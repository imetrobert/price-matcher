/**
 * Checking an extracted offer against the page it was read from.
 *
 * This is the file that decides whether a model's reading of a flyer becomes
 * something the app will show. It works by looking for the same facts a second
 * time, in the PDF's own text layer, which the model did not write.
 *
 * The bar is deliberately awkward to clear. A flyer import that yields forty
 * confirmed offers and sixty needing a glance is a good outcome; one that
 * confirms everything is a sign the check is not checking.
 */

import type { Cents } from "@/types";
import type {
  ExtractedOffer,
  FlyerPdfPage,
  OfferVerification,
  PriceEvidence,
} from "./types";

/**
 * A page with less text than this is treated as having no text layer.
 *
 * Not zero, because a scanned page often still carries a stray character or two
 * from a stamp or a page-number overlay, and one stray glyph is not a text
 * layer. Deliberately low: the cost of misjudging a real text layer as absent is
 * only that offers go to review.
 */
const MIN_TEXT_LAYER_CHARS = 40;

/** Shortest word worth treating as distinctive. */
const MIN_TERM_LENGTH = 4;

/**
 * Words that appear on every second flyer tile in both official languages, so
 * finding one proves nothing about which product a price belongs to.
 */
const STOPWORDS = new Set([
  // English
  "each",
  "with",
  "from",
  "pack",
  "size",
  "save",
  "sale",
  "price",
  "when",
  "your",
  "more",
  "than",
  "product",
  "products",
  "selected",
  "varieties",
  "assorted",
  "limit",
  "only",
  // French
  "chaque",
  "avec",
  "format",
  "prix",
  "rabais",
  "economisez",
  "epargnez",
  "choix",
  "varietes",
  "assortis",
  "assorties",
  "limite",
  "seulement",
  "certaines",
  "produit",
  "produits",
]);

/**
 * Strip accents and fold case.
 *
 * Quebec flyers are typeset in French and the accents are not applied
 * consistently between the artwork and the text layer — "épargnez" and
 * "epargnez" are the same word to a shopper and must be the same word here.
 * NFKC first so ligatures and full-width forms normalize too.
 */
function fold(input: string): string {
  return input
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Collapse the whitespace zoo a PDF text layer produces.
 *
 * Non-breaking and narrow-no-break spaces are not cosmetic here: French
 * typography puts one between the number and the dollar sign, so "7,49 $"
 * arrives as "7,49 $" and a naive space match misses it.
 */
function normalizeWhitespace(input: string): string {
  return input.replace(/[\s    ]+/g, " ").trim();
}

function normalizePageText(page: FlyerPdfPage): string {
  return normalizeWhitespace(fold(page.text));
}

/**
 * How the page's text corroborates the price, if at all.
 *
 * Two tiers, and the distinction is the point. A flyer sets the dollars large
 * and the cents as a superscript, so the text layer frequently yields "749"
 * or "7 49" with no separator at all. That is a genuine reading of a genuine
 * price — and it is also indistinguishable from an article number, so it is
 * reported as its own weaker grade rather than counted as a hit.
 */
export function findPriceEvidence(
  priceCents: Cents,
  pageText: string,
): PriceEvidence {
  if (pageText.length < MIN_TEXT_LAYER_CHARS) return "NO_TEXT_LAYER";

  const dollars = Math.trunc(priceCents / 100);
  const cents = Math.abs(priceCents % 100);
  const centsText = String(cents).padStart(2, "0");

  // Not preceded by a digit or a separator, so 7.49 does not match inside
  // 17.49 or 0.7.49, and not followed by a digit, so it does not match inside
  // 7.492.
  const before = "(?<![\\d.,])";
  const after = "(?![\\d])";

  const exact = new RegExp(
    `${before}\\$? ?${dollars}[.,] ?${centsText} ?\\$?${after}`,
  );
  if (exact.test(pageText)) return "EXACT";

  const split = new RegExp(`${before}\\$? ?${dollars} ?${centsText}${after}`);
  if (split.test(pageText)) return "SPLIT_DIGITS";

  return "NOT_IN_TEXT";
}

/**
 * The words from an offer worth looking for on the page.
 *
 * Short words and flyer boilerplate are dropped, because a check that passes on
 * "with" passes on everything. What survives is brand names, product nouns and
 * distinctive descriptors — the things that differ between one tile and the one
 * beside it.
 */
export function distinctiveTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of fold(text).split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TERM_LENGTH) continue;
    if (STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/**
 * Decide what becomes of one extracted offer.
 *
 * The rules, and why each one is where it is:
 *
 *   No text layer — nothing to check. The offer is not wrong, it is unproven,
 *   so it goes to a person rather than being thrown away or trusted.
 *
 *   Price absent from a page that HAS text — this is the important one. The
 *   page can be read, and the number is not on it. That is a contradiction, not
 *   a gap, and the offer is rejected.
 *
 *   Price present but none of the product's distinctive words are — the number
 *   is real and belongs to a different tile. Rejected for the same reason: at
 *   checkout, the right price attached to the wrong product is worse than nothing.
 *
 *   Brand named but absent from the page — same failure, sharper. A brand is
 *   the single most load-bearing token in a price match, and "Oikos" not
 *   appearing on the page the Oikos offer supposedly came from is decisive.
 *
 *   Everything corroborated, with an exact price hit — confirmed.
 *
 *   Everything corroborated, with only a split-digit price hit — review. The
 *   digits agree, but a bare digit run is not proof, and this app does not
 *   promote a maybe into a yes because the alternative is more work.
 */
export function verifyExtractedOffer(
  offer: ExtractedOffer,
  page: FlyerPdfPage,
): OfferVerification {
  if (page.pageNumber !== offer.pageNumber) {
    return {
      verdict: "REJECTED",
      priceEvidence: "NOT_IN_TEXT",
      matchedTerms: [],
      reason: `Offer says page ${offer.pageNumber} but was checked against page ${page.pageNumber}.`,
    };
  }

  const pageText = normalizePageText(page);
  const priceEvidence = findPriceEvidence(offer.price, pageText);

  if (priceEvidence === "NO_TEXT_LAYER") {
    return {
      verdict: "NEEDS_REVIEW",
      priceEvidence,
      matchedTerms: [],
      reason: `Page ${page.pageNumber} is an image with no readable text, so the price could not be double-checked. Confirm it against the flyer before using it.`,
    };
  }

  const terms = distinctiveTerms(offer.advertisedText);
  const matchedTerms = terms.filter((term) => pageText.includes(term));

  const brandTerms = offer.brand ? distinctiveTerms(offer.brand) : [];
  const brandFound =
    brandTerms.length === 0 ||
    brandTerms.some((term) => pageText.includes(term));

  if (priceEvidence === "NOT_IN_TEXT") {
    return {
      verdict: "REJECTED",
      priceEvidence,
      matchedTerms,
      reason: `Page ${page.pageNumber} can be read, and does not contain this price. Dropped rather than shown.`,
    };
  }

  if (!brandFound) {
    return {
      verdict: "REJECTED",
      priceEvidence,
      matchedTerms,
      reason: `"${offer.brand}" does not appear on page ${page.pageNumber}, so this price belongs to something else.`,
    };
  }

  if (terms.length > 0 && matchedTerms.length === 0) {
    return {
      verdict: "REJECTED",
      priceEvidence,
      matchedTerms,
      reason: `None of the product wording appears on page ${page.pageNumber}, so the price is not this product's.`,
    };
  }

  if (terms.length === 0) {
    return {
      verdict: "NEEDS_REVIEW",
      priceEvidence,
      matchedTerms,
      reason: `"${offer.advertisedText}" has no distinctive wording to check against the page. Confirm which product this price belongs to.`,
    };
  }

  if (priceEvidence === "SPLIT_DIGITS") {
    return {
      verdict: "NEEDS_REVIEW",
      priceEvidence,
      matchedTerms,
      reason: `Page ${page.pageNumber} shows these digits but not as a formatted price, which is what a superscript-cents flyer looks like. Confirm the amount.`,
    };
  }

  return {
    verdict: "CONFIRMED",
    priceEvidence,
    matchedTerms,
    reason: `Price and product wording both found in the text of page ${page.pageNumber}.`,
  };
}

export interface ImportSummary {
  confirmed: number;
  needsReview: number;
  rejected: number;
  /** Pages that carried no text layer — the part of the flyer we cannot check. */
  unreadablePages: number[];
}

/**
 * Verify a whole extraction run, and say plainly how much of it stood up.
 *
 * The summary exists so the import screen can lead with the truth — "38
 * confirmed, 12 to check, 4 dropped" — instead of a count of offers found,
 * which is the number that flatters the extraction and misleads the shopper.
 */
export function verifyExtraction(
  offers: ExtractedOffer[],
  pages: FlyerPdfPage[],
): { verifications: OfferVerification[]; summary: ImportSummary } {
  const byPage = new Map(pages.map((page) => [page.pageNumber, page]));
  const verifications: OfferVerification[] = [];
  const unreadable = new Set<number>();

  for (const offer of offers) {
    const page = byPage.get(offer.pageNumber);
    if (!page) {
      verifications.push({
        verdict: "REJECTED",
        priceEvidence: "NOT_IN_TEXT",
        matchedTerms: [],
        reason: `Page ${offer.pageNumber} is not in this document.`,
      });
      continue;
    }
    const verification = verifyExtractedOffer(offer, page);
    if (verification.priceEvidence === "NO_TEXT_LAYER") {
      unreadable.add(offer.pageNumber);
    }
    verifications.push(verification);
  }

  return {
    verifications,
    summary: {
      confirmed: verifications.filter((v) => v.verdict === "CONFIRMED").length,
      needsReview: verifications.filter((v) => v.verdict === "NEEDS_REVIEW")
        .length,
      rejected: verifications.filter((v) => v.verdict === "REJECTED").length,
      unreadablePages: [...unreadable].sort((a, b) => a - b),
    },
  };
}
