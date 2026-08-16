/**
 * Remembering what somebody fixed, and applying it to the next scan.
 *
 * The parts that are pure and therefore pinnable without a database: what a
 * reading is keyed by, how disagreement between people is settled, and what a
 * correction is allowed to change.
 */

import { describe, expect, it } from "vitest";

import {
  applyCorrection,
  fingerprintOf,
  pickCorrection,
  type StoredCorrection,
} from "@/services/products/corrections";
import type { DetectedProduct } from "@/types";

const reading = (patch: Partial<DetectedProduct> = {}): DetectedProduct =>
  ({
    id: "i1",
    brand: "Oikos",
    productName: "Oikos",
    variant: "Strawberry",
    fatPercentage: null,
    size: null,
    sizeGuess: null,
    sizeGuessBasis: null,
    packageQuantity: 1,
    visibleUpc: null,
    language: "en",
    manufacturer: null,
    productType: null,
    notes: null,
    confidence: 0.8,
    isMock: false,
    userConfirmed: false,
    ...patch,
  }) as DetectedProduct;

const row = (patch: Partial<StoredCorrection> = {}): StoredCorrection => ({
  fingerprint: "oikos|oikos|strawberry",
  brand: null,
  productName: null,
  variant: null,
  size: "650 g",
  mine: false,
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...patch,
});

describe("what a correction is keyed by", () => {
  it("keys on what the model said, so the same misreading finds it again", () => {
    expect(fingerprintOf(reading())).toBe("oikos|oikos|strawberry");
  });

  it("ignores case, accents and spacing, which vary between readings", () => {
    expect(fingerprintOf(reading({ brand: "OIKOS", productName: " Oikos " }))).toBe(
      fingerprintOf(reading()),
    );
    expect(
      fingerprintOf({ brand: "Liberté", productName: "Yaourt", variant: null }),
    ).toBe(fingerprintOf({ brand: "LIBERTE", productName: "yaourt", variant: null }));
  });

  it("leaves size out of the key", () => {
    /*
      The whole point. An unreadable size is the commonest thing being
      corrected, so keying on it would tie the fix to the field that varies —
      the correction would be stored once and never found again.
    */
    expect(fingerprintOf(reading())).toBe(fingerprintOf(reading()));
  });

  it("distinguishes variants, which are different products", () => {
    expect(fingerprintOf(reading({ variant: "Pink Lemonade" }))).not.toBe(
      fingerprintOf(reading({ variant: "Strawberry" })),
    );
  });

  it("refuses to key a reading with neither brand nor name", () => {
    // Otherwise every failed reading collects into one bucket and the first
    // person's correction is applied to all of them.
    expect(fingerprintOf({ brand: null, productName: null, variant: "Large" })).toBeNull();
    expect(fingerprintOf({ brand: "", productName: "  ", variant: null })).toBeNull();
  });
});

describe("settling a disagreement between people", () => {
  it("prefers your own correction over anybody else's", () => {
    const picked = pickCorrection([
      row({ size: "750 g", mine: false }),
      row({ size: "650 g", mine: true, updatedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    // Older, and still yours. You corrected a package you were holding.
    expect(picked!.size).toBe("650 g");
  });

  it("prefers the value the most people wrote", () => {
    const picked = pickCorrection([
      row({ size: "750 g", updatedAt: "2026-08-09T00:00:00.000Z" }),
      row({ size: "650 g", updatedAt: "2026-08-01T00:00:00.000Z" }),
      row({ size: "650 g", updatedAt: "2026-08-02T00:00:00.000Z" }),
    ]);
    // Two independent people beat one more recent one.
    expect(picked!.size).toBe("650 g");
  });

  it("falls back to the most recent when nobody agrees", () => {
    const picked = pickCorrection([
      row({ size: "750 g", updatedAt: "2026-08-09T00:00:00.000Z" }),
      row({ size: "650 g", updatedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(picked!.size).toBe("750 g");
  });

  it("has nothing to say about an empty list", () => {
    expect(pickCorrection([])).toBeNull();
  });

  it("prefers your newest, when you have corrected twice", () => {
    const picked = pickCorrection([
      row({ size: "650 g", mine: true, updatedAt: "2026-07-01T00:00:00.000Z" }),
      row({ size: "700 g", mine: true, updatedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(picked!.size).toBe("700 g");
  });
});

describe("what a correction changes", () => {
  it("fills a field the camera could not read", () => {
    const patch = applyCorrection(reading(), {
      brand: null,
      productName: null,
      variant: null,
      size: "650 g",
    });
    expect(patch.size).toBe("650 g");
    expect(patch.correctedFields).toEqual(["size"]);
  });

  it("overrides a field the camera read wrongly", () => {
    const patch = applyCorrection(reading({ brand: "Oikas" }), {
      brand: "Oikos",
      productName: null,
      variant: null,
      size: null,
    });
    expect(patch.brand).toBe("Oikos");
    expect(patch.correctedFields).toEqual(["brand"]);
  });

  it("reports nothing when the reading already agrees", () => {
    // Otherwise the card claims a provenance it does not have: "corrected from
    // your earlier fix" printed against a value nothing corrected.
    const patch = applyCorrection(reading({ size: "650 g" }), {
      brand: "Oikos",
      productName: "Oikos",
      variant: "Strawberry",
      size: "650 g",
    });
    expect(patch.correctedFields).toEqual([]);
  });

  it("ignores empty strings, which are not corrections", () => {
    const patch = applyCorrection(reading(), {
      brand: "",
      productName: null,
      variant: null,
      size: "",
    });
    expect(patch.correctedFields).toEqual([]);
  });
});
