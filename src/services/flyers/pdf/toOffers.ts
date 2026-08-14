/**
 * Turning verified extractions into offers the app will show.
 *
 * The single door between "a model read this off a page" and "the app is
 * willing to put this in front of a cashier". Everything upstream produces
 * proposals; nothing downstream re-checks them. So this file refuses rather
 * than repairs: an extraction that has not been corroborated by the page or
 * accepted by a person does not come through, and there is no flag to make it.
 */

import type { FlyerOffer } from "@/types/flyer";
import type {
  ExtractedOffer,
  FlyerPdfDocument,
  OfferVerification,
} from "./types";

/**
 * A person's decision on an offer the automatic check could not settle.
 *
 * `ACCEPTED` means they looked at the page and the price, and the price is
 * right. It carries the same weight as an automatic confirmation, because it is
 * the same claim made by a better witness.
 */
export type ReviewDecision = "ACCEPTED" | "REJECTED" | "PENDING";

export interface ReviewedExtraction {
  offer: ExtractedOffer;
  verification: OfferVerification;
  /** `PENDING` until someone has actually looked. Not a default of convenience. */
  review: ReviewDecision;
}

/**
 * Is this extraction allowed to become an offer?
 *
 * Confirmed by the page, or accepted by a person, and in neither case
 * overridden by a rejection. A `REJECTED` verdict stays rejected even if
 * somebody clicks accept — the page said the price is not there, and a tap is
 * not evidence against the document.
 */
export function isUsable(item: ReviewedExtraction): boolean {
  if (item.verification.verdict === "REJECTED") return false;
  if (item.verification.verdict === "CONFIRMED") return true;
  return item.review === "ACCEPTED";
}

/**
 * Build the offers a flyer import contributes.
 *
 * `id` is derived from the document and page rather than generated, so
 * re-importing the same flyer updates the same rows instead of quietly
 * doubling every offer — a duplicate offer is a second chance to show a stale
 * price after the first has been corrected.
 */
export function toFlyerOffers(
  document: FlyerPdfDocument,
  items: ReviewedExtraction[],
  observedAt: string,
): FlyerOffer[] {
  const offers: FlyerOffer[] = [];
  const usedIds = new Map<string, number>();

  for (const item of items) {
    if (!isUsable(item)) continue;
    const { offer } = item;

    const base = `${document.documentRef}:p${offer.pageNumber}`;
    const seen = usedIds.get(base) ?? 0;
    usedIds.set(base, seen + 1);

    offers.push({
      id: `${base}:${seen}`,
      retailerId: document.retailerId,
      advertisedText: offer.advertisedText,
      brand: offer.brand,
      size: offer.size,
      price: offer.price,
      currency: offer.currency,
      basis: offer.basis,
      regularPrice: offer.regularPrice,
      validity: document.validity,
      condition: offer.condition,
      conditionText: offer.conditionText,
      source: "FLYER_PDF",
      // No URL: this offer came from a file, not a page. The document ref is
      // the thing that can actually be shown, and the proof gate accepts it.
      flyerUrl: null,
      flyerDocumentRef: document.documentRef,
      flyerPage: offer.pageNumber,
      storeId: document.storeId,
      observedAt,
    });
  }

  return offers;
}
