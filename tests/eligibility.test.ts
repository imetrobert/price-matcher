import { describe, expect, it } from "vitest";

import { classifyFreshness, validityCovers } from "@/services/pricing/freshness";
import { evaluateEligibility } from "@/services/policies/eligibility";
import { scoreMatch } from "@/services/matching/scoring";
import { buildCanonicalProduct } from "@/services/products/normalize";
import type { PriceObservation } from "@/types";

const NOW = new Date("2026-08-08T12:00:00Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

function observation(patch: Partial<PriceObservation> = {}): PriceObservation {
  return {
    id: "obs-1",
    retailerId: "superc",
    storeId: "store-123",
    postalCode: "H4A 1A1",
    canonicalProductId: "p1",
    retailerProductId: "SC-1",
    productName: "Oikos Greek Yogurt Vanilla 650 g",
    productUrl: "https://example.test/product/oikos-650",
    price: 649,
    regularPrice: 749,
    salePrice: 649,
    currency: "CAD",
    availability: "IN_STOCK",
    observedAt: hoursAgo(2),
    sourceUrl: "https://example.test/product/oikos-650",
    sourceType: "RETAILER_PRODUCT_PAGE",
    priceConfidence: 0.95,
    matchConfidence: 95,
    checkoutProofStatus: "VERIFICATION_REQUIRED",
    sourceReliability: "VERIFIED",
    validity: null,
    restrictions: [],
    notes: [],
    rawSourceReference: null,
    isMock: false,
    ...patch,
  };
}

const canonical = buildCanonicalProduct({
  brand: "Oikos",
  name: "Greek Yogurt",
  variant: "Vanilla",
  size: "650 g",
  identitySource: "TEST_FIXTURE",
});

const exactMatch = scoreMatch(canonical, canonical);

const currentStore = observation({
  id: "cur",
  retailerId: "maxi",
  price: 749,
  sourceType: "USER_ENTERED",
  productUrl: null,
  priceConfidence: 1,
});

describe("freshness", () => {
  it("classifies by age", () => {
    expect(classifyFreshness(observation({ observedAt: hoursAgo(2) }), NOW)).toBe("FRESH");
    expect(classifyFreshness(observation({ observedAt: hoursAgo(30) }), NOW)).toBe("ACCEPTABLE");
    expect(classifyFreshness(observation({ observedAt: hoursAgo(96) }), NOW)).toBe("STALE");
  });

  it("marks a price outside its flyer window EXPIRED even when just fetched", () => {
    const o = observation({
      observedAt: hoursAgo(0.1),
      validity: {
        startsAt: "2026-07-01T00:00:00Z",
        endsAt: "2026-07-07T23:59:59Z",
      },
    });
    expect(classifyFreshness(o, NOW)).toBe("EXPIRED");
  });

  it("honours open-ended validity bounds", () => {
    expect(validityCovers({ startsAt: null, endsAt: null }, NOW)).toBe(true);
    expect(validityCovers({ startsAt: "2026-08-01T00:00:00Z", endsAt: null }, NOW)).toBe(true);
    expect(validityCovers({ startsAt: "2026-09-01T00:00:00Z", endsAt: null }, NOW)).toBe(false);
  });

  it("does not treat a future timestamp as fresh", () => {
    expect(classifyFreshness(observation({ observedAt: hoursAgo(-5) }), NOW)).toBe("STALE");
  });
});

describe("eligibility gauntlet", () => {
  it("passes a clean, verified, in-stock, fresh, exact match", () => {
    const v = evaluateEligibility({
      currentStore,
      competitor: observation(),
      match: exactMatch,
      now: NOW,
    });
    expect(v.checkoutReady).toBe(true);
    expect(v.state).toBe("CHECKOUT_READY_PROOF");
    expect(v.suppress).toHaveLength(0);
  });

  it("suppresses a stale competitor price", () => {
    const v = evaluateEligibility({
      currentStore,
      competitor: observation({ observedAt: hoursAgo(96) }),
      match: exactMatch,
      now: NOW,
    });
    expect(v.checkoutReady).toBe(false);
    expect(v.suppress.join(" ")).toMatch(/older than the freshness window/i);
  });

  it("suppresses an out-of-stock competitor", () => {
    const v = evaluateEligibility({
      currentStore,
      competitor: observation({ availability: "OUT_OF_STOCK" }),
      match: exactMatch,
      now: NOW,
    });
    expect(v.checkoutReady).toBe(false);
    expect(v.suppress.join(" ")).toMatch(/out of stock/i);
  });

  it("never marks a result checkout-ready without a product URL", () => {
    const v = evaluateEligibility({
      currentStore,
      competitor: observation({ productUrl: null }),
      match: exactMatch,
      now: NOW,
    });
    expect(v.checkoutReady).toBe(false);
  });

  it("never marks MOCK data checkout-ready, however good it looks", () => {
    const v = evaluateEligibility({
      currentStore,
      competitor: observation({
        isMock: true,
        sourceType: "MOCK_FIXTURE",
        priceConfidence: 1,
      }),
      match: exactMatch,
      now: NOW,
    });
    expect(v.checkoutReady).toBe(false);
    expect(v.competitorReliability).toBe("UNVERIFIED");
  });

  it("rejects a non-exact match outright", () => {
    const other = buildCanonicalProduct({
      brand: "Oikos",
      name: "Greek Yogurt",
      variant: "Vanilla",
      size: "750 g",
      identitySource: "TEST_FIXTURE",
    });
    const v = evaluateEligibility({
      currentStore,
      competitor: observation(),
      match: scoreMatch(canonical, other),
      now: NOW,
    });
    expect(v.checkoutReady).toBe(false);
    expect(v.suppress.length).toBeGreaterThan(0);
  });

  it("suppresses when the competitor is not actually cheaper", () => {
    const v = evaluateEligibility({
      currentStore,
      competitor: observation({ price: 799 }),
      match: exactMatch,
      now: NOW,
    });
    expect(v.suppress.join(" ")).toMatch(/not cheaper/i);
  });

  it("downgrades a regional (no store context) price to conditionally verified", () => {
    const v = evaluateEligibility({
      currentStore,
      competitor: observation({ storeId: null }),
      match: exactMatch,
      now: NOW,
    });
    expect(v.competitorReliability).toBe("CONDITIONALLY_VERIFIED");
    expect(v.checkoutReady).toBe(false);
  });

  it("never claims a price match while no retailer policy is verified", () => {
    // Policies are all UNKNOWN with no source, so POTENTIAL_PRICE_MATCH must
    // be unreachable — the app tops out at a verified competitor price.
    const v = evaluateEligibility({
      currentStore,
      competitor: observation({ productUrl: null }),
      match: exactMatch,
      now: NOW,
    });
    expect(v.state).not.toBe("POTENTIAL_PRICE_MATCH");
  });
});
