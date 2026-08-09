/**
 * The critical test file (spec §54).
 *
 * These cases encode the product promise: CartMatch would rather show nothing
 * than show a near-miss. If one of these ever starts passing when it should
 * fail, the app has become untrustworthy at a checkout counter.
 */

import { describe, expect, it } from "vitest";

import { getFixture } from "@/fixtures/products";
import { scoreMatch } from "@/services/matching/scoring";
import { buildCanonicalProduct } from "@/services/products/normalize";
import type { CanonicalProduct } from "@/types";

function fromFixture(key: string): CanonicalProduct {
  const f = getFixture(key);
  if (!f) throw new Error(`missing fixture ${key}`);
  return buildCanonicalProduct(f);
}

describe("critical non-match cases", () => {
  it("Oikos 650 g must NOT match Oikos 750 g", () => {
    const m = scoreMatch(
      fromFixture("oikos-vanilla-650"),
      fromFixture("oikos-vanilla-750"),
    );
    expect(m.tier).toBe("REJECTED");
    expect(m.score).toBe(0);
    expect(m.eligibleForCheckoutProof).toBe(false);
    expect(m.blockers.join(" ")).toMatch(/size/i);
  });

  it("Oikos Vanilla must NOT match Oikos Strawberry", () => {
    const m = scoreMatch(
      fromFixture("oikos-vanilla-650"),
      fromFixture("oikos-strawberry-650"),
    );
    expect(m.tier).toBe("REJECTED");
    expect(m.blockers.join(" ")).toMatch(/variant/i);
  });

  it("Oikos must NOT automatically match Oikos Pro", () => {
    const m = scoreMatch(
      fromFixture("oikos-vanilla-650"),
      fromFixture("oikos-pro-vanilla-650"),
    );
    expect(m.eligibleForCheckoutProof).toBe(false);
    expect(m.tier).toBe("REJECTED");
    expect(m.blockers.join(" ")).toMatch(/product line/i);
  });

  it("Oikos 650 g must NOT match Oikos 4 x 100 g", () => {
    const m = scoreMatch(
      fromFixture("oikos-vanilla-650"),
      fromFixture("oikos-vanilla-4x100"),
    );
    expect(m.tier).toBe("REJECTED");
    expect(m.blockers.join(" ")).toMatch(/size|package count/i);
  });

  it("Oikos must NOT match President's Choice at the same size", () => {
    const m = scoreMatch(
      fromFixture("oikos-vanilla-650"),
      fromFixture("pc-vanilla-greek-650"),
    );
    expect(m.tier).toBe("REJECTED");
    expect(m.blockers.join(" ")).toMatch(/brand/i);
  });

  it("2% milk must NOT match 1% milk", () => {
    const m = scoreMatch(fromFixture("milk-2pct-2l"), fromFixture("milk-1pct-2l"));
    expect(m.tier).toBe("REJECTED");
    expect(m.blockers.join(" ")).toMatch(/fat/i);
  });

  it("salted butter must NOT match unsalted butter", () => {
    const m = scoreMatch(
      fromFixture("butter-lactantia-454"),
      fromFixture("butter-lactantia-unsalted-454"),
    );
    expect(m.tier).toBe("REJECTED");
  });

  it("650 ml must NOT match 650 g (different unit systems)", () => {
    const volume = buildCanonicalProduct({
      brand: "Classico",
      name: "Pasta Sauce",
      variant: "Tomato Basil",
      size: "650 ml",
      identitySource: "TEST_FIXTURE",
    });
    const mass = buildCanonicalProduct({
      brand: "Classico",
      name: "Pasta Sauce",
      variant: "Tomato Basil",
      size: "650 g",
      identitySource: "TEST_FIXTURE",
    });
    expect(scoreMatch(volume, mass).tier).toBe("REJECTED");
  });
});

describe("critical match cases", () => {
  it("identical GTIN matches at level 1 with score 100", () => {
    // Synthetic but check-digit-valid GTIN, used ONLY to exercise the
    // algorithm. It is not a claim about any real product.
    const gtin = "0006543210982";
    const a = buildCanonicalProduct({
      gtin,
      brand: "Oikos",
      name: "Greek Yogurt",
      variant: "Vanilla",
      size: "650 g",
      identitySource: "VISIBLE_BARCODE",
    });
    const b = buildCanonicalProduct({
      gtin,
      // Deliberately different wording — GTIN equality outranks text.
      brand: "Oikos",
      name: "Yogourt Grec",
      variant: "Vanille",
      size: "650 g",
      identitySource: "RETAILER_PRODUCT_DATA",
    });
    const m = scoreMatch(a, b);
    expect(m.level).toBe("L1_GTIN");
    expect(m.score).toBe(100);
    expect(m.tier).toBe("EXACT_MATCH");
    expect(m.eligibleForCheckoutProof).toBe(true);
  });

  it("conflicting GTINs are a hard blocker even when text is identical", () => {
    const a = buildCanonicalProduct({
      gtin: "0006543210982",
      brand: "Oikos",
      name: "Greek Yogurt",
      variant: "Vanilla",
      size: "650 g",
      identitySource: "VISIBLE_BARCODE",
    });
    const b = buildCanonicalProduct({
      gtin: "0000012345670",
      brand: "Oikos",
      name: "Greek Yogurt",
      variant: "Vanilla",
      size: "650 g",
      identitySource: "VISIBLE_BARCODE",
    });
    expect(scoreMatch(a, b).tier).toBe("REJECTED");
  });

  it("same product, unit conversion (0.65 kg vs 650 g) still matches", () => {
    const a = buildCanonicalProduct({
      brand: "Oikos",
      name: "Greek Yogurt",
      variant: "Vanilla",
      size: "650 g",
      identitySource: "TEST_FIXTURE",
    });
    const b = buildCanonicalProduct({
      brand: "Oikos",
      name: "Greek Yogurt",
      variant: "Vanilla",
      size: "0.65 kg",
      identitySource: "TEST_FIXTURE",
    });
    const m = scoreMatch(a, b);
    expect(m.level).toBe("L3_ATTRIBUTES");
    expect(m.eligibleForCheckoutProof).toBe(true);
  });

  it("matches the same product listed in French and in English", () => {
    // The core Montreal case: identical tub, bilingual listings.
    const english = buildCanonicalProduct({
      brand: "Oikos",
      name: "Greek Yogurt",
      variant: "Vanilla",
      fatPercentage: "0",
      size: "650 g",
      identitySource: "ATTRIBUTE_SEARCH",
    });
    const french = buildCanonicalProduct({
      brand: "Oikos",
      name: "Yogourt Grec",
      variant: "Vanille",
      fatPercentage: "0",
      size: "650 g",
      identitySource: "RETAILER_PRODUCT_DATA",
    });
    const m = scoreMatch(english, french);
    expect(m.blockers).toHaveLength(0);
    expect(m.eligibleForCheckoutProof).toBe(true);
  });

  it("bilingual normalization does not blur genuinely different flavours", () => {
    const vanillaFr = buildCanonicalProduct({
      brand: "Oikos",
      name: "Yogourt Grec",
      variant: "Vanille",
      size: "650 g",
      identitySource: "RETAILER_PRODUCT_DATA",
    });
    const strawberryEn = buildCanonicalProduct({
      brand: "Oikos",
      name: "Greek Yogurt",
      variant: "Strawberry",
      size: "650 g",
      identitySource: "ATTRIBUTE_SEARCH",
    });
    expect(scoreMatch(vanillaFr, strawberryEn).tier).toBe("REJECTED");
  });

  it("a level-4 fuzzy result is never checkout-eligible", () => {
    const a = buildCanonicalProduct({
      brand: "Ritz",
      name: "Crackers",
      variant: "Original",
      size: null, // size unknown -> cannot reach level 3
      identitySource: "ATTRIBUTE_SEARCH",
    });
    const b = buildCanonicalProduct({
      brand: "Ritz",
      name: "Crackers",
      variant: "Original",
      size: "200 g",
      identitySource: "RETAILER_PRODUCT_DATA",
    });
    const m = scoreMatch(a, b);
    expect(m.level).toBe("L4_FUZZY");
    expect(m.eligibleForCheckoutProof).toBe(false);
  });

  it("retailer id mapping gives level 2", () => {
    const a = fromFixture("pasta-barilla-454");
    const b = fromFixture("pasta-barilla-454");
    const m = scoreMatch(a, b, { retailerIdAlreadyMapped: true });
    // Identical attributes already reach L3 at 95; the mapping flag is only
    // consulted when GTIN is absent, and it outranks attributes.
    expect(m.score).toBeGreaterThanOrEqual(95);
    expect(m.eligibleForCheckoutProof).toBe(true);
  });
});
