/**
 * Where flyer offers come from.
 *
 * Deliberately a narrow interface, because the supply question is unsettled and
 * the app should not be shaped around whichever answer arrives first:
 *
 *   A partner feed (Flipp runs a media-partner programme; retailers pay to have
 *   flyers distributed, so a surface that shows them at the moment of purchase
 *   is aligned with what they sell rather than against it).
 *
 *   A person typing what they see in a paper or digital flyer.
 *
 *   Fixtures, for development.
 *
 * All three produce the same `FlyerOffer`, so the pipeline above never learns
 * which one it is talking to. What it does learn is `source`, carried on every
 * offer, because a user-entered price and a licensed feed deserve different
 * confidence even when they say the same number.
 *
 * NOT IMPLEMENTED TODAY. No feed exists, and this file does not pretend
 * otherwise: `NoFlyerSource` returns nothing and says why.
 */

import type { FlyerOffer } from "@/types/flyer";
import type { CanonicalProduct, RetailerId } from "@/types";

export interface FlyerQuery {
  /** The product being shopped for. */
  product: CanonicalProduct;
  /** Retailers worth asking about — competitors, not the current store. */
  retailerIds: RetailerId[];
  /** Narrows store-specific flyers. */
  postalCode: string | null;
  /**
   * Offers valid at this moment. Passed explicitly rather than read from the
   * clock so a test can ask about a Thursday without waiting for one.
   */
  at: Date;
}

export type FlyerLookup =
  | { available: true; offers: FlyerOffer[] }
  /**
   * No feed, or the feed failed. Distinct from an empty result: "nothing is on
   * sale" and "we could not look" are different answers, and collapsing them
   * lets an outage read as good news.
   */
  | { available: false; reason: string };

export interface FlyerSourceAdapter {
  readonly id: string;
  readonly displayName: string;
  /** False when the adapter cannot serve anything — surfaced in the UI. */
  isAvailable(): boolean;
  findOffers(query: FlyerQuery): Promise<FlyerLookup>;
}

/**
 * The honest default: there is no flyer feed.
 *
 * Returns `available: false` with the real reason rather than an empty list.
 * An empty list means "checked, nothing on sale", which is a claim this app
 * cannot currently make about anything.
 */
export class NoFlyerSource implements FlyerSourceAdapter {
  readonly id = "none";
  readonly displayName = "No flyer source configured";

  isAvailable(): boolean {
    return false;
  }

  async findOffers(): Promise<FlyerLookup> {
    return {
      available: false,
      reason:
        "No flyer source is connected. Flyer comparison needs either a licensed feed or offers entered by hand — see README.",
    };
  }
}
