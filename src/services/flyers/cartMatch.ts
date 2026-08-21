/**
 * A cart, against this week's flyers.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR ANSWERS, AND WHY THE FOURTH IS THE POINT
 * ---------------------------------------------------------------------------
 * Somebody standing in a shop with a trolley wants to know one thing per item,
 * and it is always one of these:
 *
 *   NOT IN ANY FLYER   nobody advertised it this week. Nothing to do. This is
 *                      the common case and it deserves to be quiet — a list
 *                      that shouts about every item trains people to skim.
 *
 *   BEST WHERE YOU ARE nothing advertised anywhere beats what you are paying.
 *                      Also nothing to do, and worth saying plainly: "you
 *                      already have the best price" is a result, not an
 *                      absence of one.
 *
 *   CHEAPER ELSEWHERE  a real number. Both sides are known — what you pay here
 *                      and what another chain advertised — so the gap can be
 *                      subtracted rather than suggested.
 *
 *   ON SALE ELSEWHERE  another chain advertised it, and what you would pay
 *                      here is UNKNOWN. No number is possible and none is
 *                      given. This is the largest group and the whole reason
 *                      somebody scans a trolley.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FOURTH ONE HAD TO BE SPLIT OUT
 * ---------------------------------------------------------------------------
 * It used to be filed under CHEAPER ELSEWHERE with a null saving. The data was
 * honest; the label was not. "Cheaper elsewhere" is a claim, and it cannot be
 * made about an item whose shelf price nobody has looked at — the competitor
 * might be dearer. Worse, the honest half was hidden behind the same heading
 * as the certain half, so the answer a shopper actually wanted — "something in
 * your trolley is on sale somewhere else, go and look" — read like a weaker
 * version of a price match instead of the point of the exercise.
 *
 * So the two are now different outcomes with different words. This group says
 * MAY BE cheaper, shows what was advertised and where, and asks the shopper to
 * compare it against the shelf in front of them. If they type that shelf price
 * in, the line stops being a suggestion and becomes arithmetic.
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

export type CartOutcome =
  | "NOT_IN_FLYERS"
  | "BEST_HERE"
  | "CHEAPER_ELSEWHERE"
  | "ON_SALE_ELSEWHERE";

/**
 * Where the price you are paying came from — or that nobody knows it.
 *
 * This is the field the whole split turns on. ENTERED and FLYER_HERE both
 * permit a subtraction; null forbids one, and no amount of matching changes
 * that.
 */
export type YourPriceSource = "ENTERED" | "FLYER_HERE";

export interface CartLine {
  item: DetectedProduct;
  outcome: CartOutcome;
  /** What the shop you are standing in advertised, if it advertised it. */
  hereOffer: StoredOffer | null;
  /** The cheapest offer at another chain that beats your price, if any. */
  bestElsewhere: StoredOffer | null;
  /**
   * What you are paying here, if anybody knows: a price typed in beats the
   * flyer, because somebody who reads a shelf tag is reading the truth and the
   * flyer is a claim about it.
   */
  yourPriceCents: Cents | null;
  yourPriceSource: YourPriceSource | null;
  /**
   * The gap, in cents — null when it cannot honestly be computed, which is
   * whenever nobody knows what you pay here. Null is not zero.
   */
  savingCents: Cents | null;
  /** Every per-item offer matched, cheapest first. */
  matches: StoredOffer[];
  /**
   * Matches advertised per pound or per kilo. Shown, never subtracted — the
   * shopper can read "$3.62/lb at Maxi" and judge it themselves.
   */
  measuredMatches: StoredOffer[];
  /** The same, restricted to other chains: what this trolley could be told about. */
  measuredElsewhere: StoredOffer[];
  /**
   * Per-item matches from a partner feed (Flipp), restricted to other chains.
   * Shown, never subtracted, for the same reason as measuredElsewhere: the
   * number is real but this app did not confirm it means "per item".
   */
  uncertainElsewhere: StoredOffer[];
  /**
   * True when the offer this line leads with was matched without a confirmed
   * size — one side or the other printed nothing readable.
   *
   * The product is still the product: brand, name and variant all agreed, and
   * a size KNOWN on both sides and different is a hard blocker that never gets
   * here. What is missing is the check, so every screen showing one of these
   * has to ask for it, and Checkout Mode refuses them entirely.
   */
  sizeUnverified: boolean;
}

export interface CartComparison {
  lines: CartLine[];
  notInFlyers: CartLine[];
  bestHere: CartLine[];
  cheaperElsewhere: CartLine[];
  /** Advertised elsewhere, with no way to know whether it beats your shelf. */
  onSaleElsewhere: CartLine[];
  /**
   * Total of every gap that could actually be computed.
   *
   * Only CHEAPER_ELSEWHERE contributes, and every one of those has both sides
   * known — so this total is now arithmetic rather than a partial sum with
   * unknowables silently counted as zero.
   */
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
  options: {
    includeConditional?: boolean;
    /**
     * Shelf prices somebody has typed in, by item id. Kept out of
     * DetectedProduct on purpose: that type is what a camera reported, and a
     * price read off a tag by a person is a different kind of fact with a
     * different reliability. Mixing them would lose that distinction.
     */
    enteredPrices?: Record<string, Cents | null>;
  } = {},
): CartComparison {
  // SOURCE_UNCERTAIN (Flipp) offers are let through here even though
  // isComparable() would normally exclude them — line() below is what keeps
  // them out of every dollar figure. This filter only decides what reaches
  // the matcher at all, not what gets subtracted.
  const usable = offers.filter(
    (o) =>
      isComparable(o, options.includeConditional ?? false) ||
      o.condition === "SOURCE_UNCERTAIN",
  );

  const lines = items.map((item) =>
    line(item, usable, currentRetailer, options.enteredPrices?.[item.id] ?? null),
  );

  const cheaperElsewhere = lines.filter((l) => l.outcome === "CHEAPER_ELSEWHERE");

  return {
    lines,
    notInFlyers: lines.filter((l) => l.outcome === "NOT_IN_FLYERS"),
    bestHere: lines.filter((l) => l.outcome === "BEST_HERE"),
    cheaperElsewhere,
    onSaleElsewhere: lines.filter((l) => l.outcome === "ON_SALE_ELSEWHERE"),
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
  enteredPrice: Cents | null,
): CartLine {
  const canonical = toCanonical(item);

  /**
   * Which offers are this product, and which of those were matched without a
   * confirmed size.
   *
   * The set is the compensating control for allowing the match at all. An
   * unread size no longer blocks a comparison — it travels with it, so the
   * screen can say "check the size before you quote this" and the till can
   * refuse it outright.
   */
  const unverified = new Set<string>();
  const matched = offers.filter((offer) => {
    const result = scoreMatch(canonical, offerCanonical(offer));
    if (result.score < SAME_PRODUCT_SCORE) return false;
    if (result.level === "L3_NO_SIZE") unverified.add(offer.id);
    return true;
  });

  // Split before anything is compared. A per-pound price and a package price
  // are not two prices for one thing, and the moment they share a sorted list
  // the cheapest of them is wrong.
  // Pull SOURCE_UNCERTAIN (Flipp) offers out FIRST, regardless of their
  // nominal basis. A Flipp offer never gets treated as a trustworthy
  // per-pound price just because its basis field happens to say PER_LB, or
  // as a trustworthy per-item price if the basis could not be determined at
  // all — "uncertain" describes the whole offer, not just its unit.
  const trustworthy = matched.filter((o) => o.condition !== "SOURCE_UNCERTAIN");
  const uncertain = matched
    .filter((o) => o.condition === "SOURCE_UNCERTAIN")
    .sort((a, b) => a.price - b.price);

  const measuredMatches = trustworthy
    .filter((o) => isMeasuredBasis(o.basis))
    .sort((a, b) => a.price - b.price);
  const perItem = trustworthy
    .filter((o) => !isMeasuredBasis(o.basis))
    .sort((a, b) => a.price - b.price);

  // "Here" and the CHEAPER_ELSEWHERE arithmetic below both only ever look at
  // the trustworthy list. A Flipp offer at the shop you're standing in is not
  // "your price" — the shelf or the photo is.
  const hereOffer = perItem.find((o) => o.retailerId === currentRetailer) ?? null;
  const perItemElsewhere = perItem.filter((o) => o.retailerId !== currentRetailer);
  const measuredElsewhere = measuredMatches.filter(
    (o) => o.retailerId !== currentRetailer,
  );
  const uncertainElsewhere = uncertain.filter(
    (o) => o.retailerId !== currentRetailer,
  );
  const cheapestElsewhere = perItemElsewhere[0] ?? null;

  /**
   * What you are paying, and how anybody knows.
   *
   * A typed price wins over the flyer. Somebody reading the tag in front of
   * them is reading what the till will charge; the flyer is a claim about that
   * which can be out of date, mis-read by the model, or for a variant the
   * shelf does not have. When the two disagree the person is right.
   */
  const yourPriceCents = enteredPrice ?? hereOffer?.price ?? null;
  const yourPriceSource: YourPriceSource | null =
    enteredPrice !== null ? "ENTERED" : hereOffer ? "FLYER_HERE" : null;

  // The offer this line leads with, which is what the caution is about.
  const lead =
    perItemElsewhere[0] ?? hereOffer ?? measuredElsewhere[0] ?? uncertainElsewhere[0] ?? null;

  const base = {
    item,
    hereOffer,
    yourPriceCents,
    yourPriceSource,
    matches: perItem,
    measuredMatches,
    measuredElsewhere,
    uncertainElsewhere,
    sizeUnverified: lead !== null && unverified.has(lead.id),
  };

  // Nobody else advertised it, in any unit, trustworthy or Flipp. Nothing to
  // send anybody across town for — the only question left is whether it was
  // advertised here.
  if (
    cheapestElsewhere === null &&
    measuredElsewhere.length === 0 &&
    uncertainElsewhere.length === 0
  ) {
    return {
      ...base,
      outcome: hereOffer || enteredPrice !== null ? "BEST_HERE" : "NOT_IN_FLYERS",
      bestElsewhere: null,
      savingCents: null,
    };
  }

  // Both sides known and the other side is lower: the one case that earns a
  // number. Subtraction in integer cents, never a model's estimate.
  if (
    yourPriceCents !== null &&
    cheapestElsewhere !== null &&
    cheapestElsewhere.price < yourPriceCents
  ) {
    return {
      ...base,
      outcome: "CHEAPER_ELSEWHERE",
      bestElsewhere: cheapestElsewhere,
      savingCents: calculateSavingsCents(yourPriceCents, cheapestElsewhere.price),
    };
  }

  // Your price is known and nothing per-item beats it. Said plainly, and any
  // per-kilo offer elsewhere still travels on the line: it cannot be
  // subtracted, but "also $3.62/lb at Maxi" is the shopper's call to make.
  if (yourPriceCents !== null) {
    return {
      ...base,
      outcome: "BEST_HERE",
      bestElsewhere: null,
      savingCents: null,
    };
  }

  // Advertised elsewhere, and what you would pay here is unknown — your shop
  // did not advertise it and nobody has typed a shelf price. No number exists
  // and none is offered. Lead with a trustworthy offer when there is one;
  // otherwise the Flipp lead is the whole reason this line exists.
  return {
    ...base,
    outcome: "ON_SALE_ELSEWHERE",
    bestElsewhere: cheapestElsewhere ?? uncertainElsewhere[0] ?? null,
    savingCents: null,
  };
}

/** What to call an item in a list, from whatever the camera managed to read. */
export function itemLabel(item: DetectedProduct): string {
  const parts = [item.brand, item.productName, item.size].filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  );
  return parts.length > 0 ? parts.join(" ") : "Unidentified item";
}
