/**
 * A cart, against this week's flyers.
 *
 * ---------------------------------------------------------------------------
 * THE THREE ANSWERS, AND WHY THEY ARE THE ONLY THREE
 * ---------------------------------------------------------------------------
 * Somebody standing in a shop with a trolley wants to know one thing per item,
 * and it is always one of these:
 *
 *   NOT IN ANY FLYER   nobody advertised it this week. Nothing to do. This is
 *                      the common case and it deserves to be quiet — a list
 *                      that shouts about every item trains people to skim.
 *
 *   BEST WHERE YOU ARE the shop you are standing in advertised it, and no
 *                      other flyer beats that price. Also nothing to do, and
 *                      worth saying plainly: "you already have the best price"
 *                      is a result, not an absence of one.
 *
 *   CHEAPER ELSEWHERE  another chain advertised it for less. This is the only
 *                      one that opens up, because it is the only one that asks
 *                      anything of the shopper.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES TO CLAIM
 * ---------------------------------------------------------------------------
 * A SAVING IT CANNOT COMPUTE. When another shop advertises an item and yours
 * does not, there is no number for what you would pay here — the shelf price
 * of an unadvertised product is not in this app and cannot be guessed from a
 * competitor's sale price. That item is still worth showing, with the price
 * that WAS advertised and no invented gap. `savingCents` is null and stays
 * null.
 *
 * A COMPARISON ACROSS UNITS. Only per-item prices take part in the arithmetic.
 * A flyer advertising chicken at $3.62/lb is real information and is shown as
 * such, but it is never subtracted from a package price.
 *
 * A MATCH IT IS NOT SURE OF. The same threshold the deals screen uses —
 * brand, name, variant and size all agreeing. A trolley photograph is already
 * one inference; pairing it to a flyer tile on "strong token overlap" would be
 * a second inference stacked on the first, presented to a cashier as fact.
 */

import { buildCanonicalProduct } from "@/services/products/normalize";
import { scoreMatch } from "@/services/matching/scoring";
import { calculateSavingsCents } from "@/lib/money";
import type { Cents, DetectedProduct, RetailerId } from "@/types";
import { isMeasuredBasis } from "@/types/flyer";
import { SAME_PRODUCT_SCORE, isComparable } from "./compare";
import type { StoredOffer } from "./storage";

export type CartOutcome = "NOT_IN_FLYERS" | "BEST_HERE" | "CHEAPER_ELSEWHERE";

export interface CartLine {
  item: DetectedProduct;
  outcome: CartOutcome;
  /** What the shop you are standing in advertised, if it advertised it. */
  hereOffer: StoredOffer | null;
  /** The cheapest offer at another chain that beats `hereOffer`, if any. */
  bestElsewhere: StoredOffer | null;
  /**
   * The gap, in cents — null when it cannot honestly be computed, which is
   * whenever your own shop did not advertise the item. Null is not zero.
   */
  savingCents: Cents | null;
  /** Every per-item offer matched, cheapest first. */
  matches: StoredOffer[];
  /**
   * Matches advertised per pound or per kilo. Shown, never subtracted — the
   * shopper can read "$3.62/lb at Maxi" and judge it themselves.
   */
  measuredMatches: StoredOffer[];
}

export interface CartComparison {
  lines: CartLine[];
  notInFlyers: CartLine[];
  bestHere: CartLine[];
  cheaperElsewhere: CartLine[];
  /** Total of every gap that could actually be computed. */
  totalSavingCents: Cents;
  /** Offers that were available to compare against. */
  offersConsidered: number;
}

/**
 * How sure the camera has to be before an item is taken as read.
 *
 * Below this the shopper is asked to look. Not a statistical threshold — it is
 * the point past which a wrong reading stops being obvious in a list, and a
 * misread product that reaches a price-match desk is worse than one the app
 * admitted it could not see.
 */
export const NEEDS_A_LOOK_BELOW = 0.7;

export function needsConfirming(item: DetectedProduct): boolean {
  if (item.userConfirmed) return false;
  return item.confidence < NEEDS_A_LOOK_BELOW || item.productName === null;
}

function toCanonical(item: DetectedProduct) {
  return buildCanonicalProduct({
    brand: item.brand ?? "",
    name: item.productName ?? "",
    variant: item.variant,
    fatPercentage: item.fatPercentage,
    size: item.size,
    packageCount: item.packageQuantity,
    gtin: item.visibleUpc,
    identitySource: item.visibleUpc ? "VISIBLE_BARCODE" : "USER_ENTERED",
  });
}

function offerCanonical(offer: StoredOffer) {
  return buildCanonicalProduct({
    brand: offer.brand ?? "",
    name: offer.advertisedText,
    size: offer.size,
    identitySource: "ATTRIBUTE_SEARCH",
  });
}

/**
 * Sort a cart against the week's offers.
 *
 * `currentRetailer` is where the shopper is standing — the whole "do I already
 * have the best price" question is relative to it, and without it the second
 * category cannot exist.
 */
export function compareCartToFlyers(
  items: DetectedProduct[],
  offers: StoredOffer[],
  currentRetailer: RetailerId,
  options: { includeConditional?: boolean } = {},
): CartComparison {
  const usable = offers.filter((o) => isComparable(o, options.includeConditional ?? false));

  const lines = items.map((item) => line(item, usable, currentRetailer));

  const cheaperElsewhere = lines.filter((l) => l.outcome === "CHEAPER_ELSEWHERE");

  return {
    lines,
    notInFlyers: lines.filter((l) => l.outcome === "NOT_IN_FLYERS"),
    bestHere: lines.filter((l) => l.outcome === "BEST_HERE"),
    cheaperElsewhere,
    totalSavingCents: cheaperElsewhere.reduce(
      (sum, l) => sum + (l.savingCents ?? 0),
      0,
    ),
    offersConsidered: usable.length,
  };
}

function line(
  item: DetectedProduct,
  offers: StoredOffer[],
  currentRetailer: RetailerId,
): CartLine {
  const canonical = toCanonical(item);

  const matched = offers.filter(
    (offer) => scoreMatch(canonical, offerCanonical(offer)).score >= SAME_PRODUCT_SCORE,
  );

  // Split before anything is compared. A per-pound price and a package price
  // are not two prices for one thing, and the moment they share a sorted list
  // the cheapest of them is wrong.
  const measuredMatches = matched
    .filter((o) => isMeasuredBasis(o.basis))
    .sort((a, b) => a.price - b.price);
  const perItem = matched
    .filter((o) => !isMeasuredBasis(o.basis))
    .sort((a, b) => a.price - b.price);

  if (perItem.length === 0 && measuredMatches.length === 0) {
    return {
      item,
      outcome: "NOT_IN_FLYERS",
      hereOffer: null,
      bestElsewhere: null,
      savingCents: null,
      matches: [],
      measuredMatches: [],
    };
  }

  const hereOffer = perItem.find((o) => o.retailerId === currentRetailer) ?? null;
  const elsewhere = perItem.filter((o) => o.retailerId !== currentRetailer);
  const cheapestElsewhere = elsewhere[0] ?? null;

  // Advertised only where you are standing, or advertised nowhere per item.
  // Either way there is nothing to send anybody across town for.
  if (cheapestElsewhere === null) {
    return {
      item,
      outcome: hereOffer ? "BEST_HERE" : "NOT_IN_FLYERS",
      hereOffer,
      bestElsewhere: null,
      savingCents: null,
      matches: perItem,
      measuredMatches,
    };
  }

  if (hereOffer === null) {
    // Somebody else advertised it and your shop did not. Worth knowing, and
    // the gap is unknowable: the shelf price of an unadvertised product is not
    // in this app, and a competitor's sale price is no basis for guessing it.
    return {
      item,
      outcome: "CHEAPER_ELSEWHERE",
      hereOffer: null,
      bestElsewhere: cheapestElsewhere,
      savingCents: null,
      matches: perItem,
      measuredMatches,
    };
  }

  if (cheapestElsewhere.price >= hereOffer.price) {
    return {
      item,
      outcome: "BEST_HERE",
      hereOffer,
      bestElsewhere: null,
      savingCents: null,
      matches: perItem,
      measuredMatches,
    };
  }

  return {
    item,
    outcome: "CHEAPER_ELSEWHERE",
    hereOffer,
    bestElsewhere: cheapestElsewhere,
    savingCents: calculateSavingsCents(hereOffer.price, cheapestElsewhere.price),
    matches: perItem,
    measuredMatches,
  };
}

/** What to call an item in a list, from whatever the camera managed to read. */
export function itemLabel(item: DetectedProduct): string {
  const parts = [item.brand, item.productName, item.size].filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  );
  return parts.length > 0 ? parts.join(" ") : "Unidentified item";
}
