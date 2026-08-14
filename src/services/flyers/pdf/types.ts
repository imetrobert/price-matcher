/**
 * Importing a week's offers from a flyer PDF.
 *
 * ---------------------------------------------------------------------------
 * WHY A PDF IS A BETTER INPUT THAN ANYTHING ELSE AVAILABLE TO US
 * ---------------------------------------------------------------------------
 * Every other supply route has been measured and failed (see the retailer
 * adapters): Maxi and IGA both return HTTP 403 to a datacenter request, and
 * Flipp serves an app shell with no offer data in the HTML. A PDF the shopper
 * already received is different in kind — it is not fetched, not scraped, not
 * behind an access control. It is a document handed to the customer.
 *
 * It is also the strongest form of the evidence: the flyer page is the artefact
 * a cashier is trained to look at. A price-match desk asks for the competitor's
 * advertised price, printed, with dates. That is precisely what a page of this
 * PDF is.
 *
 * ---------------------------------------------------------------------------
 * WHY EXTRACTION ALONE IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * A model reading a flyer page can misread a price. Not often, but the failure
 * is silent and the number ends up in front of a cashier. This app's rule is
 * that it never presents a price it cannot stand behind, so a model's reading is
 * treated as a CLAIM, not as data.
 *
 * Most flyer PDFs carry a text layer — the real characters, placed by the
 * publishing tool, not an OCR guess. That gives us a second, independent
 * witness: if the model says $7.49 and the string "$7.49" is genuinely present
 * in that page's text, two independent readings agree. If the page has no text
 * layer, or the price is not in it, the offer does not become usable — a person
 * confirms it or it is dropped.
 *
 * That is the whole design. Extraction proposes; the page's own text disposes;
 * anything unresolved goes to a human. No offer reaches a cashier on the
 * strength of a model's reading alone.
 */

import type { Cents, CurrencyCode, RetailerId, ValidityPeriod } from "@/types";
import type { OfferCondition, PriceBasis } from "@/types/flyer";

/**
 * One page of the PDF, as two independent readings of the same paper.
 *
 * `text` is what the file itself declares — extracted from the PDF's text
 * layer, not interpreted. Empty or near-empty means the page is a flat image
 * (a scan, or artwork with the prices baked in), which is a real and common
 * case and is handled explicitly rather than treated as "no match".
 */
export interface FlyerPdfPage {
  /** 1-based, matching how a person counts pages in a viewer. */
  pageNumber: number;
  /** Raw text layer. "" when the page carries none. */
  text: string;
}

/**
 * An offer as the extraction model read it, before anything has been checked.
 *
 * Separate from `FlyerOffer` on purpose. `FlyerOffer` is something the app is
 * willing to show; this is a proposal. Nothing converts one into the other
 * except `verifyExtractedOffer` plus, where that is inconclusive, a person.
 */
export interface ExtractedOffer {
  /** Product wording exactly as printed. Not tidied — the paper is the truth. */
  advertisedText: string;
  brand: string | null;
  size: string | null;
  /** The retailer's article number where the flyer prints one ("N° 51087737"). */
  retailerSku: string | null;

  price: Cents;
  currency: CurrencyCode;
  /**
   * What the price is the price of. Asked for explicitly, because a flyer
   * marks "/lb" in six-point type beside a price set forty points tall, and an
   * extraction that overlooks it produces a number that looks comparable and
   * is not.
   */
  basis: PriceBasis;
  regularPrice: Cents | null;

  condition: OfferCondition;
  /** "2 for $5", "limite 4", "avec carte" — verbatim, in the flyer's language. */
  conditionText: string | null;

  /** Which page this was read from. Required: it is what gets verified. */
  pageNumber: number;
}

/**
 * The flyer as a whole — the facts that belong to the document, not to any one
 * offer.
 *
 * `validity` sits here because it is printed once, on the cover, and applies to
 * every offer inside. An import with no dates cannot produce usable offers at
 * all: `offerCanSupportCheckoutProof` already refuses an offer without an end
 * date, and rightly, since "advertised at some point" is not a claim anyone can
 * act on at a till.
 */
export interface FlyerPdfDocument {
  retailerId: RetailerId;
  validity: ValidityPeriod;
  /**
   * Opaque pointer to the stored PDF — used to show the page at checkout.
   * Not a URL: the file is the user's own copy, held for the flyer's run.
   */
  documentRef: string;
  /** Store the flyer is for, when it is store-specific. */
  storeId: string | null;
  pageCount: number;
}

/**
 * How well the page's own text backs the model's reading of the price.
 *
 * `EXACT`         the price appears with its separator — "$7.49", "7,49 $".
 * `SPLIT_DIGITS`  dollars and cents appear adjacent but unseparated, which is
 *                 what a text layer yields when the flyer typesets the cents as
 *                 a superscript. Real, and the commonest form in a large-format
 *                 grocery flyer, but weaker than an exact hit, so it is recorded
 *                 distinctly rather than quietly folded into EXACT.
 * `NOT_IN_TEXT`   the page has text, and this price is not in it.
 * `NO_TEXT_LAYER` the page is an image; there is nothing to check against.
 */
export type PriceEvidence =
  | "EXACT"
  | "SPLIT_DIGITS"
  | "NOT_IN_TEXT"
  | "NO_TEXT_LAYER";

/**
 * What happens to an extracted offer.
 *
 * `CONFIRMED`      price and product both corroborated by the page text. Usable.
 * `NEEDS_REVIEW`   plausible but unproven. Shown to a person, who accepts or
 *                  rejects it. Never usable until they do.
 * `REJECTED`       contradicted by the page. Dropped, with the reason kept so a
 *                  bad extraction run is diagnosable rather than invisible.
 */
export type OfferVerdict = "CONFIRMED" | "NEEDS_REVIEW" | "REJECTED";

export interface OfferVerification {
  verdict: OfferVerdict;
  priceEvidence: PriceEvidence;
  /**
   * Distinctive words from the advertised text that were found on the page.
   * Kept so the review screen can show WHY something is being questioned rather
   * than just asserting that it is.
   */
  matchedTerms: string[];
  /** Plain-language explanation, written to be shown to the user as-is. */
  reason: string;
}
