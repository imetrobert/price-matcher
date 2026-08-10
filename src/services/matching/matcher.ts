/**
 * Candidate selection: given a canonical product and a retailer's search
 * results, decide which candidate (if any) is the SAME product.
 */

import { buildCanonicalProduct } from "@/services/products/normalize";
import { scoreMatch } from "@/services/matching/scoring";
import type {
  CanonicalProduct,
  MatchResult,
  ProductSearchCandidate,
} from "@/types";

export interface ScoredCandidate {
  candidate: ProductSearchCandidate;
  canonical: CanonicalProduct;
  match: MatchResult;
}

/**
 * Turn a retailer listing into a canonical identity so it can be compared on
 * the same terms as the cart item.
 *
 * Retailer titles are messy ("Oikos Greek Yogurt Vanilla 0% M.F. 650 g"), so
 * we extract brand and size where the adapter supplied them and otherwise
 * lean on the title. Anything we cannot establish stays null — which caps the
 * achievable score rather than being guessed.
 */
export function candidateToCanonical(
  candidate: ProductSearchCandidate,
  reference: CanonicalProduct,
): CanonicalProduct {
  const title = candidate.title;
  const brand = candidate.rawBrand ?? inferBrandFromTitle(title, reference.brand);
  const size = candidate.rawSize ?? inferSizeFromTitle(title);

  return buildCanonicalProduct({
    brand,
    name: stripNoise(title, brand, size),
    variant: inferVariantFromTitle(title, reference),
    fatPercentage: inferFatFromTitle(title),
    size,
    identitySource: "RETAILER_PRODUCT_DATA",
  });
}

/** Score every candidate and return them best-first. */
export function rankCandidates(
  reference: CanonicalProduct,
  candidates: ProductSearchCandidate[],
): ScoredCandidate[] {
  return candidates
    .map((candidate) => {
      const canonical = candidateToCanonical(candidate, reference);
      const match = scoreMatch(reference, canonical);
      return { candidate, canonical, match };
    })
    .sort((x, y) => y.match.score - x.match.score);
}

/**
 * Pick the single best candidate, or null when nothing clears the bar.
 * Returning null is a normal, expected outcome — it becomes an
 * "Unable to verify" row rather than a match.
 */
export function selectBestCandidate(
  reference: CanonicalProduct,
  candidates: ProductSearchCandidate[],
): ScoredCandidate | null {
  const ranked = rankCandidates(reference, candidates);
  const best = ranked[0];
  if (!best) return null;
  if (best.match.tier === "REJECTED") return null;
  return best;
}

// ---------------------------------------------------------------------------
// Title parsing helpers (deliberately conservative — null beats a guess)
// ---------------------------------------------------------------------------

const SIZE_PATTERN =
  /(\d+\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l|oz|lb)|\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l|oz|lb|ct|pk|un)\b)/i;

export function inferSizeFromTitle(title: string): string | null {
  const m = title.match(SIZE_PATTERN);
  return m ? m[1]!.trim() : null;
}

export function inferFatFromTitle(title: string): string | null {
  const m = title.match(/(\d+(?:[.,]\d+)?)\s*%/);
  return m ? m[1]!.replace(",", ".") : null;
}

/**
 * We only accept a brand from the title if the reference brand actually
 * appears in it. Inventing a brand from the first word of a title is exactly
 * the kind of guess that produces false matches.
 */
export function inferBrandFromTitle(
  title: string,
  referenceBrand: string,
): string {
  const lowerTitle = title.toLowerCase();
  if (referenceBrand && lowerTitle.includes(referenceBrand.toLowerCase())) {
    return referenceBrand;
  }
  return title.split(/[\s,]+/)[0] ?? "";
}

/**
 * Variant inference is anchored on the reference variant: if the reference
 * says "Vanilla" and the title contains it, that is a confirmed variant. If
 * the title contains a DIFFERENT known flavour word, we return that so the
 * scorer can block on it. Otherwise null (unknown, caps the score).
 */
const COMMON_VARIANT_WORDS = [
  "vanilla",
  "vanille",
  "strawberry",
  "fraise",
  "blueberry",
  "bleuet",
  "raspberry",
  "framboise",
  "peach",
  "peche",
  "plain",
  "nature",
  "honey",
  "miel",
  "chocolate",
  "chocolat",
  "coffee",
  "cafe",
  "lemon",
  "citron",
  "mango",
  "mangue",
  "cherry",
  "cerise",
  "coconut",
  "coco",
  "caramel",
  "maple",
  "erable",
];

export function inferVariantFromTitle(
  title: string,
  reference: CanonicalProduct,
): string | null {
  const lower = title.toLowerCase();
  if (reference.variant && lower.includes(reference.variant.toLowerCase())) {
    return reference.variant;
  }
  for (const word of COMMON_VARIANT_WORDS) {
    if (lower.includes(word)) return word;
  }
  return null;
}

function stripNoise(title: string, brand: string, size: string | null): string {
  let out = title;
  if (brand) out = out.replace(new RegExp(escapeRegExp(brand), "ig"), " ");
  if (size) out = out.replace(new RegExp(escapeRegExp(size), "ig"), " ");
  return out.replace(/\s+/g, " ").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
