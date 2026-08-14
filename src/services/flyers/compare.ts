/**
 * What is cheaper where, this week.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WORTH BUILDING BEFORE CART MATCHING
 * ---------------------------------------------------------------------------
 * It answers the question the whole app exists for — "am I paying more than I
 * need to" — using only data already held, with no photograph and no guessing
 * at what is in somebody's trolley. It is also the honest test of the matcher:
 * real French from Maxi against real English from Walmart, printed by four
 * different chains with four different house styles.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES TO COMPARE, AND WHY EACH REFUSAL IS THERE
 * ---------------------------------------------------------------------------
 * A comparison is only worth showing when the two numbers are the same kind of
 * number. Four things disqualify a pair, and every one of them corresponds to
 * a real tile in the week-33 Montreal flyers:
 *
 *   DIFFERENT UNITS. "$8.96 per lb" against "$12.99 each" is not a saving of
 *   $4.03; it is two units subtracted from each other. Metro prints the first,
 *   Walmart the second, on the same product category.
 *
 *   A CONDITION. "2 for $5", "avec carte Scène+", "limite 4" — the advertised
 *   number is not what a shopper pays unless they satisfy something this app
 *   cannot check. IGA prints a card price and a non-card price on the SAME
 *   tile, which is precisely how a loyalty price gets mistaken for a shelf one.
 *
 *   THE MATCHER SAYING NO. Different brand, different size, different fat
 *   percentage, a product line on one side only. These are the blockers in
 *   scoreMatch, and they are checked before any similarity is computed.
 *
 *   ONE RETAILER. Two Maxi offers for the same yogurt are not a comparison,
 *   they are a duplicate.
 *
 * The arithmetic is done here, in code, never by a model, and in integer cents.
 */

import { buildCanonicalProduct, meaningfulTokens } from "@/services/products/normalize";
import { scoreMatch } from "@/services/matching/scoring";
import { calculateSavingsCents, meetsThreshold } from "@/lib/money";
import type { Cents, RetailerId } from "@/types";
import type { PriceBasis } from "@/types/flyer";
import type { StoredOffer } from "./storage";

/**
 * The score at which two flyer descriptions are treated as one product.
 *
 * Level 3 — brand, name, variant and an exact size all agreeing. Deliberately
 * not the fuzzy tier: a comparison shown here is a claim that two shops sell
 * the same thing, and "strong token overlap" is not that claim.
 */
export const SAME_PRODUCT_SCORE = 90;

export interface ComparableOffer {
  offer: StoredOffer;
  retailerId: RetailerId;
}

export interface PriceGap {
  /** The flyer wording of the cheapest offer — what a person will recognise. */
  label: string;
  brand: string | null;
  size: string | null;
  basis: PriceBasis;
  cheapest: StoredOffer;
  dearest: StoredOffer;
  savingCents: Cents;
  /** Every offer in the group, cheapest first. */
  offers: StoredOffer[];
}

/**
 * Can this offer take part in a comparison at all?
 *
 * Conditional prices are excluded rather than converted. A "2 for $5" reduced
 * to $2.50 is a number nobody was quoted, and a card price compared against a
 * shelf price is a saving that evaporates when the cashier asks for the card.
 */
export function isComparable(offer: StoredOffer): boolean {
  return offer.condition === "UNIT_PRICE";
}

/**
 * A cheap key for narrowing which offers are worth comparing in full.
 *
 * Two products cannot be the same unless they share at least one meaningful
 * word once the lexicon has done its work — "beurre" and "butter" both become
 * "butter", so the bucket is language-independent. This is an optimisation
 * only: everything that lands in a bucket is still put through scoreMatch,
 * which is what actually decides.
 */
function bucketKeys(offer: StoredOffer): string[] {
  const tokens = meaningfulTokens(
    `${offer.brand ?? ""} ${offer.advertisedText}`,
  );
  return tokens.slice(0, 6);
}

function toCanonical(offer: StoredOffer) {
  return buildCanonicalProduct({
    brand: offer.brand ?? "",
    name: offer.advertisedText,
    size: offer.size,
    identitySource: "ATTRIBUTE_SEARCH",
  });
}

/**
 * Group this week's offers into products, and report the gaps.
 *
 * Grouping is greedy and order-dependent by design: an offer joins the first
 * group whose representative it matches. A cleverer clustering would produce
 * marginally tighter groups and would be far harder to explain to somebody
 * asking why two things were called the same product — and that explanation is
 * the feature.
 */
export function findPriceGaps(
  offers: StoredOffer[],
  minSavingCents: Cents,
): PriceGap[] {
  const usable = offers.filter(isComparable);

  // Grouped by unit first. Comparing a per-pound price with a per-item one is
  // the single most convincing wrong answer this app could produce, so the two
  // never meet — not even as candidates.
  const byBasis = new Map<PriceBasis, StoredOffer[]>();
  for (const offer of usable) {
    const list = byBasis.get(offer.basis) ?? [];
    list.push(offer);
    byBasis.set(offer.basis, list);
  }

  const gaps: PriceGap[] = [];

  for (const [basis, group] of byBasis) {
    const buckets = new Map<string, StoredOffer[][]>();

    for (const offer of group) {
      const canonical = toCanonical(offer);
      let placed = false;

      for (const key of bucketKeys(offer)) {
        const clusters = buckets.get(key);
        if (!clusters) continue;
        for (const cluster of clusters) {
          const result = scoreMatch(canonical, toCanonical(cluster[0]!));
          if (result.score >= SAME_PRODUCT_SCORE) {
            cluster.push(offer);
            placed = true;
            break;
          }
        }
        if (placed) break;
      }

      if (!placed) {
        const cluster = [offer];
        for (const key of bucketKeys(offer)) {
          const clusters = buckets.get(key) ?? [];
          clusters.push(cluster);
          buckets.set(key, clusters);
        }
      }
    }

    // A cluster reached through several keys appears several times; compare by
    // identity so one product is not reported twice.
    const seen = new Set<StoredOffer[]>();
    for (const clusters of buckets.values()) {
      for (const cluster of clusters) {
        if (seen.has(cluster)) continue;
        seen.add(cluster);

        const retailers = new Set(cluster.map((o) => o.retailerId));
        // One shop is not a comparison. Two offers from the same flyer for the
        // same product are a duplicate, not a saving.
        if (retailers.size < 2) continue;

        const sorted = [...cluster].sort((a, b) => a.price - b.price);
        const cheapest = sorted[0]!;
        const dearest = sorted[sorted.length - 1]!;
        const saving = calculateSavingsCents(dearest.price, cheapest.price);
        if (!meetsThreshold(saving, minSavingCents)) continue;

        gaps.push({
          label: cheapest.advertisedText,
          brand: cheapest.brand,
          size: cheapest.size,
          basis,
          cheapest,
          dearest,
          savingCents: saving,
          offers: sorted,
        });
      }
    }
  }

  // Biggest gap first: that is the order somebody plans a shopping trip in.
  return gaps.sort((a, b) => b.savingCents - a.savingCents);
}

export interface ComparisonSummary {
  offersConsidered: number;
  offersSkippedConditional: number;
  retailers: RetailerId[];
  gaps: number;
}

/**
 * What the comparison was working from.
 *
 * Shown above the results because the results are only as good as the input,
 * and "no gaps found" means something quite different with two flyers loaded
 * than with five.
 */
export function summariseComparison(
  offers: StoredOffer[],
  gaps: PriceGap[],
): ComparisonSummary {
  return {
    offersConsidered: offers.filter(isComparable).length,
    offersSkippedConditional: offers.filter((o) => !isComparable(o)).length,
    retailers: [...new Set(offers.map((o) => o.retailerId))].sort(),
    gaps: gaps.length,
  };
}
