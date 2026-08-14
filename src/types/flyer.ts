/**
 * Flyer offers — advertised prices, with the dates they are advertised for.
 *
 * ---------------------------------------------------------------------------
 * WHY FLYERS ARE THE RIGHT SHAPE, NOT A FALLBACK
 * ---------------------------------------------------------------------------
 * A flyer offer is a weaker dataset than a full catalogue — only advertised
 * items, only while advertised — and a stronger kind of evidence.
 *
 * Price-match policies overwhelmingly ask for a competitor's **advertised**
 * price. A cashier is trained to look at a flyer, check the dates, and check
 * the size. A product page printout is not the artefact that process expects.
 * So a flyer reference is not a downgrade from a product URL; at the till it is
 * the document that actually works.
 *
 * It also concentrates the dataset on the items where the gap is worth
 * crossing the street for. Nobody opens this app for fifteen cents on a staple.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES A FLYER OFFER DIFFERENT FROM A PRICE OBSERVATION
 * ---------------------------------------------------------------------------
 * An observation answers "what did this cost when we looked?". An offer
 * answers "what is this retailer promising, and until when?" — so the dates are
 * not metadata, they are the substance. An offer whose window has closed is not
 * a stale price; it is not a price at all, and `classifyFreshness` already
 * returns EXPIRED for exactly that case.
 *
 * The other difference is conditions. Flyers routinely advertise prices that
 * are not simply "this costs $X": limits, multi-buys, loyalty requirements.
 * Those are modelled explicitly below rather than flattened into a number,
 * because flattening them is how an app shows a saving that does not exist when
 * the person reaches the till.
 */

import type { Cents, CurrencyCode, RetailerId, ValidityPeriod } from "@/types";

/**
 * What the price is the price OF.
 *
 * Added after a Metro flyer tile read "8.96 /lb ... 19,75/kg" for a salmon
 * fillet. A shopper's cart holds a package; the flyer advertises a pound. The
 * two numbers look alike, sit in the same field, and subtracting one from the
 * other invents a saving out of a unit mismatch — a $12.99 package against
 * $8.96 a pound reports $4.03 saved and is simply wrong.
 *
 * Meat, fish and loose produce are priced this way throughout every flyer in
 * the set, so this is not an edge case; it is a large and valuable part of the
 * data that must be shown WITHOUT being arithmetic.
 */
export type PriceBasis =
  /** The price of the thing as sold. The only basis this app subtracts. */
  | "PER_ITEM"
  | "PER_LB"
  | "PER_KG"
  | "PER_100G"
  | "PER_100ML";

/** True when the price is for a weight or volume rather than for the item. */
export function isMeasuredBasis(basis: PriceBasis): boolean {
  return basis !== "PER_ITEM";
}

/** How the basis is written on a flyer, for showing beside the price. */
export function describeBasis(basis: PriceBasis): string {
  switch (basis) {
    case "PER_ITEM":
      return "each";
    case "PER_LB":
      return "per lb";
    case "PER_KG":
      return "per kg";
    case "PER_100G":
      return "per 100 g";
    case "PER_100ML":
      return "per 100 ml";
  }
}

/**
 * How a flyer price is qualified.
 *
 * `UNIT_PRICE` is the simple case and the only one this app can currently treat
 * as directly comparable. Everything else is recorded and displayed, never
 * silently converted into a per-unit number:
 *
 *   MULTI_BUY      "2 for $5" — the single-unit price is not $2.50 unless you
 *                  buy two, and a shopper buying one pays full price.
 *   LOYALTY_ONLY   requires a card, and sometimes a pre-loaded offer.
 *   LIMIT_APPLIES  capped quantity per customer or per transaction.
 *   WITH_PURCHASE  conditional on buying something else.
 */
export type OfferCondition =
  | "UNIT_PRICE"
  | "MULTI_BUY"
  | "LOYALTY_ONLY"
  | "LIMIT_APPLIES"
  | "WITH_PURCHASE";

/** Where an offer came from, and therefore how much it can be trusted. */
export type FlyerSource =
  /** A licensed feed from an aggregator or the retailer itself. */
  | "PARTNER_FEED"
  /**
   * Read out of a flyer PDF the shopper received, and corroborated against that
   * page's own text layer or confirmed by the shopper. See
   * `services/flyers/pdf` — an extraction that cleared neither bar never
   * becomes an offer at all, so this source always means "checked twice".
   */
  | "FLYER_PDF"
  /** Typed in by a person reading a flyer. Real, but unverified by anyone else. */
  | "USER_ENTERED"
  /** Fixture data. Can never back a checkout claim. */
  | "MOCK_FIXTURE";

export interface FlyerOffer {
  id: string;
  retailerId: RetailerId;

  /**
   * The product as the FLYER describes it, not as we would like it described.
   *
   * Flyer copy is terse and inconsistent — "Oikos Greek yogurt 650g" or
   * "Yogourt grec Oikos, 650 g". Stored verbatim so the matcher works from what
   * was actually printed, and so a person comparing the app against the paper
   * sees the same words.
   */
  advertisedText: string;
  brand: string | null;
  size: string | null;

  price: Cents;
  currency: CurrencyCode;
  /**
   * What `price` is the price of. Never assumed: an offer read from a flyer
   * without a visible unit marking is PER_ITEM only when the flyer showed no
   * unit, and the extraction is asked for this explicitly rather than left to
   * default into the comparable case.
   */
  basis: PriceBasis;
  /** Struck-through or "reg." price where the flyer prints one. */
  regularPrice: Cents | null;

  /**
   * The dates the offer runs. Required — an offer without dates cannot be
   * shown, because "advertised at some point" is not a claim anyone can act on.
   */
  validity: ValidityPeriod;

  condition: OfferCondition;
  /**
   * The condition in the flyer's own words: "2 for $5", "limit 4", "with PC
   * Optimum card". Shown verbatim next to the price, because paraphrasing a
   * condition is how a saving evaporates at the till.
   */
  conditionText: string | null;

  source: FlyerSource;
  /** Link to the flyer page carrying this offer — what a cashier is shown. */
  flyerUrl: string | null;
  /**
   * Pointer to a stored flyer document carrying this offer — the other way to
   * put the page in front of a cashier, and the better one when it exists,
   * because it is the flyer itself rather than a link to a site that may have
   * rotated to next week's.
   */
  flyerDocumentRef: string | null;
  /** Page number within the flyer, when the source provides one. */
  flyerPage: number | null;

  /** Store this offer applies to, when the flyer is store-specific. */
  storeId: string | null;
  observedAt: string;
}

/**
 * Can this offer be compared against a shelf price as a straight saving?
 *
 * Only an unconditional unit price. Everything else is displayable — a shopper
 * may well want to know about "2 for $5" — but it is not a number this app will
 * subtract, because the saving depends on behaviour the app cannot verify.
 */
export function isDirectlyComparable(offer: FlyerOffer): boolean {
  if (offer.condition !== "UNIT_PRICE") return false;
  // A price per pound is a real, useful, advertised price — and it is not a
  // number that can be subtracted from the price of a package, because the
  // package's weight is not something a photograph of a cart establishes.
  if (isMeasuredBasis(offer.basis)) return false;
  return true;
}

/**
 * Can this offer back a claim made to a cashier?
 *
 * Four things, all required, and each one is a real refusal mode:
 *
 *   Mock data never can, under any circumstances.
 *   A conditional price is not the price, so it cannot be presented as one.
 *   Without a flyer reference — a link or a stored page — there is nothing to
 *     show; a price with no document is exactly what a cashier declines.
 *   Without an end date there is no way to demonstrate the offer is current,
 *     and "still valid" is the first thing checked at the till.
 *
 * Note this does NOT check whether the offer is currently in date — that is
 * `classifyFreshness`'s job, which already returns EXPIRED outside the window.
 * Two checks, kept separate: this one asks whether the offer is the RIGHT KIND
 * of evidence, that one asks whether it is still true.
 */
export function offerCanSupportCheckoutProof(offer: FlyerOffer): boolean {
  if (offer.source === "MOCK_FIXTURE") return false;
  if (!isDirectlyComparable(offer)) return false;
  if (!offer.flyerUrl && !offer.flyerDocumentRef) return false;
  if (!offer.validity.endsAt) return false;
  return true;
}

/**
 * The line shown beneath a flyer price.
 *
 * Always says something. An offer with no condition still gets "Advertised
 * price" rather than an empty space, because a blank where a qualifier might
 * belong reads as "no strings attached" — a claim nobody made.
 */
export function describeCondition(offer: FlyerOffer): string {
  // The basis leads when there is one: "per lb" is the thing that stops a
  // shopper misreading the number, and it outranks any other qualifier.
  if (isMeasuredBasis(offer.basis)) {
    const unit = describeBasis(offer.basis);
    return offer.conditionText
      ? `${unit} — ${offer.conditionText}`
      : `Advertised ${unit}, so it cannot be compared against a package price`;
  }
  if (offer.conditionText) return offer.conditionText;
  switch (offer.condition) {
    case "UNIT_PRICE":
      return "Advertised price";
    case "MULTI_BUY":
      return "Multi-buy offer — the single-unit price is higher";
    case "LOYALTY_ONLY":
      return "Requires the retailer's loyalty card";
    case "LIMIT_APPLIES":
      return "Quantity limit applies";
    case "WITH_PURCHASE":
      return "Conditional on another purchase";
  }
}
