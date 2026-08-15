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
import type { OfferCondition, PriceBasis } from "@/types/flyer";
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
  /**
   * At least one offer here carries a condition — a card, a quantity cap.
   * Set so the card can say so where somebody reads the number, rather than
   * only in a setting they toggled and forgot.
   */
  hasConditional: boolean;
}

/**
 * Conditions whose advertised number is still a price for ONE of the item.
 *
 * ---------------------------------------------------------------------------
 * THE LINE THAT MATTERS, AND WHY IT IS NOT DRAWN AT "CONDITIONAL"
 * ---------------------------------------------------------------------------
 * Conditional offers were excluded wholesale, which conflated two quite
 * different problems under one word.
 *
 *   "avec carte Scène+" and "limite 4" advertise a price for one unit. The
 *   catch is whether the shopper QUALIFIES — a card in the wallet, a quantity
 *   cap. The number itself is comparable; what it costs is a condition a
 *   person can read and decide about.
 *
 *   "2 for $5" and "with the purchase of..." advertise a price for something
 *   else entirely. Five dollars is the price of TWO. Set beside $3.99 each it
 *   reads as a dollar cheaper when it is in fact a dollar dearer per item, and
 *   halving it to $2.50 quotes a number no flyer printed.
 *
 * So the first group can be opted into and the second cannot. That is not a
 * setting: a multi-buy total compared against a unit price is arithmetic
 * between two different quantities, and no amount of labelling makes the
 * subtraction mean anything.
 */
const UNIT_PRICED_CONDITIONS: readonly OfferCondition[] = [
  "UNIT_PRICE",
  "LOYALTY_ONLY",
  "LIMIT_APPLIES",
];

/**
 * Can this offer take part in a comparison at all?
 *
 * With `includeConditional`, offers whose price is still per-unit join in —
 * card prices and limited quantities. Multi-buys and with-purchase offers stay
 * out either way, because their number counts a different thing.
 */
export function isComparable(
  offer: StoredOffer,
  includeConditional = false,
): boolean {
  if (offer.condition === "UNIT_PRICE") return true;
  return includeConditional && UNIT_PRICED_CONDITIONS.includes(offer.condition);
}

/** Is this offer in the comparison only because conditions were opted into? */
export function isConditional(offer: StoredOffer): boolean {
  return offer.condition !== "UNIT_PRICE";
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
  includeConditional = false,
): PriceGap[] {
  const usable = offers.filter((o) => isComparable(o, includeConditional));

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
          hasConditional: sorted.some(isConditional),
        });
      }
    }
  }

  // Biggest gap first: that is the order somebody plans a shopping trip in.
  return gaps.sort((a, b) => b.savingCents - a.savingCents);
}

/** One flyer that took part, as the reader needs to see it. */
export interface ComparisonSource {
  retailerId: RetailerId;
  validFrom: string;
  validTo: string;
  /** Offers this flyer contributed, conditional ones included. May be zero. */
  offers: number;
  /** From the flyer record, when it is available. */
  pagesRead: number | null;
  pageCount: number | null;
}

/** A flyer record as this summary needs it. */
export interface ComparisonFlyer {
  retailerId: RetailerId;
  validFrom: string;
  validTo: string;
  pagesRead: number;
  pageCount: number;
}

export interface ComparisonSummary {
  offersConsidered: number;
  offersSkippedConditional: number;
  /** Conditional offers whose price is per-unit, so they CAN be opted into. */
  offersConditionalUsable: number;
  /** Multi-buys and with-purchase offers, which never take part. */
  offersNeverComparable: number;
  retailers: RetailerId[];
  gaps: number;
  /** Every flyer behind these numbers, named and dated. */
  sources: ComparisonSource[];
  /** The widest window the sources cover, or null when there are none. */
  validFrom: string | null;
  validTo: string | null;
  /** True when some page of some flyer has not been read yet. */
  incomplete: boolean;
}

/**
 * What the comparison was working from.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SOURCES ARE NAMED AND DATED
 * ---------------------------------------------------------------------------
 * This screen compares what THIS WEEK'S FLYERS ADVERTISE. It is not a survey
 * of what the shops sell — a product nobody put in a flyer cannot appear here
 * however different its price is between two stores, and a flyer that was not
 * loaded is simply a store that does not exist as far as these numbers go.
 *
 * "3 price gaps across 4 stores" gave no way to tell those apart. Naming each
 * flyer with its dates, its offer count and how much of it has been read makes
 * the boundary of the answer visible: four stores for the week of the 13th,
 * one of them still sixteen pages short, is a very different claim from four
 * complete flyers.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LIST IS BUILT FROM THE FLYERS AND NOT FROM THE OFFERS
 * ---------------------------------------------------------------------------
 * It used to be built from the offers, which meant a flyer contributing none
 * was not listed as contributing none — it was not listed at all. A store held
 * for this week whose pages had not been read yet, or had failed, or had been
 * read to nothing, was indistinguishable on this screen from a store the
 * shopper never loaded.
 *
 * That is the failure that matters most here, because it is invisible: nobody
 * notices an absence. So every flyer running today gets a row, zero offers
 * included, and any offer whose flyer was not supplied gets one too — a
 * summary must never quietly drop what it was given.
 */
export function summariseComparison(
  offers: StoredOffer[],
  gaps: PriceGap[],
  flyers: ComparisonFlyer[] = [],
): ComparisonSummary {
  const byRetailer = new Map<RetailerId, StoredOffer[]>();
  for (const offer of offers) {
    const list = byRetailer.get(offer.retailerId) ?? [];
    list.push(offer);
    byRetailer.set(offer.retailerId, list);
  }

  // Keyed by store and week, which is what a flyer is: the same shop's flyer
  // for two different weeks is two sources, and only one of them can be today's.
  const key = (retailerId: RetailerId, validFrom: string) =>
    `${retailerId}|${validFrom}`;

  const counted = new Map<string, StoredOffer[]>();
  for (const offer of offers) {
    const k = key(offer.retailerId, offer.validFrom);
    const list = counted.get(k) ?? [];
    list.push(offer);
    counted.set(k, list);
  }

  const sources: ComparisonSource[] = [];
  const seen = new Set<string>();

  for (const flyer of flyers) {
    const k = key(flyer.retailerId, flyer.validFrom);
    seen.add(k);
    const list = counted.get(k) ?? [];
    sources.push({
      retailerId: flyer.retailerId,
      validFrom: flyer.validFrom,
      validTo: flyer.validTo,
      offers: list.length,
      pagesRead: flyer.pagesRead,
      pageCount: flyer.pageCount,
    });
  }

  // Offers whose flyer record was not supplied. Callers that pass no flyers at
  // all rely on this, and it is also the honest reading of a mismatch: the
  // offers exist, so the source did.
  for (const [k, list] of counted) {
    if (seen.has(k)) continue;
    sources.push({
      retailerId: list[0]!.retailerId,
      validFrom: list[0]!.validFrom,
      validTo: list.map((o) => o.validTo).sort().reverse()[0]!,
      offers: list.length,
      pagesRead: null,
      pageCount: null,
    });
  }

  sources.sort(
    (a, b) =>
      a.retailerId.localeCompare(b.retailerId) ||
      a.validFrom.localeCompare(b.validFrom),
  );

  const conditional = offers.filter(isConditional);

  return {
    offersConsidered: offers.filter((o) => isComparable(o)).length,
    offersSkippedConditional: conditional.length,
    offersConditionalUsable: conditional.filter((o) => isComparable(o, true)).length,
    offersNeverComparable: conditional.filter((o) => !isComparable(o, true)).length,
    retailers: [...byRetailer.keys()].sort(),
    gaps: gaps.length,
    sources,
    validFrom: sources.map((s) => s.validFrom).sort()[0] ?? null,
    validTo: sources.map((s) => s.validTo).sort().reverse()[0] ?? null,
    // A page still unread is offers missing from this comparison, not offers
    // that do not exist — the same distinction the home card makes.
    incomplete: sources.some(
      (s) => s.pagesRead !== null && s.pageCount !== null && s.pagesRead < s.pageCount,
    ),
  };
}
