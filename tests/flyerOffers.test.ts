/**
 * Flyer offers: what may be compared, and what may be shown to a cashier.
 *
 * These are the rules that stop the app promising a saving that evaporates at
 * the till. Every refusal below corresponds to something a real flyer does.
 */

import { describe, expect, it } from "vitest";

import { classifyFreshness, validityCovers } from "@/services/pricing/freshness";
import {
  describeCondition,
  isDirectlyComparable,
  offerCanSupportCheckoutProof,
  type FlyerOffer,
} from "@/types/flyer";

const WEEK = {
  startsAt: "2026-08-07T00:00:00Z",
  endsAt: "2026-08-13T23:59:59Z",
};

function offer(patch: Partial<FlyerOffer> = {}): FlyerOffer {
  return {
    id: "offer-1",
    retailerId: "maxi",
    advertisedText: "Oikos Greek yogurt 650 g",
    brand: "Oikos",
    size: "650 g",
    price: 599,
    currency: "CAD",
    regularPrice: 749,
    validity: WEEK,
    condition: "UNIT_PRICE",
    conditionText: null,
    source: "PARTNER_FEED",
    flyerUrl: "https://example.test/flyer/page/3",
    flyerPage: 3,
    storeId: null,
    observedAt: "2026-08-10T09:00:00Z",
    ...patch,
  };
}

describe("a plain advertised price", () => {
  it("is comparable and can back a checkout claim", () => {
    expect(isDirectlyComparable(offer())).toBe(true);
    expect(offerCanSupportCheckoutProof(offer())).toBe(true);
  });

  it("still says something under the price", () => {
    // A blank where a qualifier might belong reads as "no strings attached",
    // which is a claim nobody made.
    expect(describeCondition(offer())).toBe("Advertised price");
  });
});

describe("conditional offers are shown but never subtracted", () => {
  it('refuses to compare "2 for $5"', () => {
    // The single-unit price is not $2.50. A shopper buying one pays full price,
    // so treating it as a unit price invents a saving.
    const multi = offer({ condition: "MULTI_BUY", conditionText: "2 for $5" });
    expect(isDirectlyComparable(multi)).toBe(false);
    expect(offerCanSupportCheckoutProof(multi)).toBe(false);
  });

  it("refuses a loyalty-card price", () => {
    const loyalty = offer({ condition: "LOYALTY_ONLY" });
    expect(offerCanSupportCheckoutProof(loyalty)).toBe(false);
    expect(describeCondition(loyalty)).toMatch(/loyalty/i);
  });

  it("refuses a price conditional on another purchase", () => {
    expect(offerCanSupportCheckoutProof(offer({ condition: "WITH_PURCHASE" }))).toBe(
      false,
    );
  });

  it("shows the flyer's own wording rather than paraphrasing it", () => {
    // Paraphrasing a condition is how a saving evaporates at the till.
    const limited = offer({
      condition: "LIMIT_APPLIES",
      conditionText: "Limit 4 per family",
    });
    expect(describeCondition(limited)).toBe("Limit 4 per family");
  });
});

describe("what cannot be shown to a cashier", () => {
  it("refuses mock data outright", () => {
    expect(offerCanSupportCheckoutProof(offer({ source: "MOCK_FIXTURE" }))).toBe(
      false,
    );
  });

  it("refuses an offer with no flyer to show", () => {
    // A price with no document is exactly what a cashier declines.
    expect(offerCanSupportCheckoutProof(offer({ flyerUrl: null }))).toBe(false);
  });

  it("refuses an offer with no end date", () => {
    // "Still valid?" is the first thing checked at the till, and an offer with
    // no end date cannot answer it.
    expect(
      offerCanSupportCheckoutProof(
        offer({ validity: { startsAt: WEEK.startsAt, endsAt: null } }),
      ),
    ).toBe(false);
  });

  it("still permits a user-entered offer, which is real if unverified", () => {
    expect(offerCanSupportCheckoutProof(offer({ source: "USER_ENTERED" }))).toBe(
      true,
    );
  });
});

describe("dates are the substance, not metadata", () => {
  const inWindow = new Date("2026-08-10T12:00:00Z");
  const afterWindow = new Date("2026-08-20T12:00:00Z");

  it("covers a date inside the window", () => {
    expect(validityCovers(WEEK, inWindow)).toBe(true);
  });

  it("does not cover a date after it", () => {
    expect(validityCovers(WEEK, afterWindow)).toBe(false);
  });

  it("is EXPIRED once the window closes, however recently it was fetched", () => {
    // The offer was observed minutes ago and is still not a price. This is the
    // distinction the freshness model exists to make.
    const justFetched = {
      observedAt: afterWindow.toISOString(),
      retailerId: "maxi" as const,
      validity: WEEK,
    };
    expect(classifyFreshness(justFetched, afterWindow)).toBe("EXPIRED");
  });

  it("is FRESH inside the window when recently observed", () => {
    const recent = {
      observedAt: "2026-08-10T09:00:00Z",
      retailerId: "maxi" as const,
      validity: WEEK,
    };
    expect(classifyFreshness(recent, inWindow)).toBe("FRESH");
  });
});
