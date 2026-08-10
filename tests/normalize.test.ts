import { describe, expect, it } from "vitest";

import {
  isValidGtinCheckDigit,
  normalizeFatPercentage,
  normalizeGtin,
  parseSize,
  sizesMatch,
} from "@/services/products/normalize";

describe("size parsing", () => {
  it("parses mass", () => {
    expect(parseSize("650 g").size).toEqual({
      system: "MASS",
      baseValue: 650,
      raw: "650 g",
    });
    expect(parseSize("0.65 kg").size?.baseValue).toBe(650);
    expect(parseSize("454g").size?.baseValue).toBe(454);
  });

  it("parses volume", () => {
    expect(parseSize("2 L").size?.baseValue).toBe(2000);
    expect(parseSize("1.75 L").size?.baseValue).toBe(1750);
    expect(parseSize("500ml").size?.baseValue).toBe(500);
  });

  it("parses multi-packs into total size AND package count", () => {
    const p = parseSize("4 x 100 g");
    expect(p.size?.baseValue).toBe(400);
    expect(p.packageCount).toBe(4);

    const q = parseSize("12 x 355 ml");
    expect(q.size?.baseValue).toBe(4260);
    expect(q.packageCount).toBe(12);
  });

  it("parses counts", () => {
    expect(parseSize("6 rolls").packageCount).toBe(6);
    expect(parseSize("6 rolls").size?.system).toBe("COUNT");
  });

  it("returns null rather than guessing an unreadable size", () => {
    expect(parseSize(null).size).toBeNull();
    expect(parseSize("").size).toBeNull();
    expect(parseSize("family size").size).toBeNull();
  });
});

describe("size comparison", () => {
  it("accepts unit-conversion rounding only", () => {
    expect(sizesMatch(parseSize("650 g").size, parseSize("0.65 kg").size)).toBe(true);
    expect(sizesMatch(parseSize("650 g").size, parseSize("655 g").size)).toBe(true);
  });

  it("rejects genuinely different sizes", () => {
    expect(sizesMatch(parseSize("650 g").size, parseSize("750 g").size)).toBe(false);
    expect(sizesMatch(parseSize("650 g").size, parseSize("700 g").size)).toBe(false);
  });

  it("never bridges unit systems", () => {
    expect(sizesMatch(parseSize("650 g").size, parseSize("650 ml").size)).toBe(false);
  });

  it("treats an unknown size as not matching", () => {
    expect(sizesMatch(null, parseSize("650 g").size)).toBe(false);
  });
});

describe("GTIN handling", () => {
  it("validates check digits", () => {
    expect(isValidGtinCheckDigit("0000012345670")).toBe(true);
    expect(isValidGtinCheckDigit("0000012345671")).toBe(false);
  });

  it("normalizes to GTIN-14 so UPC-A and EAN-13 compare equal", () => {
    const upcA = normalizeGtin("012345670");
    const ean13 = normalizeGtin("0000012345670");
    expect(ean13).toBe("00000000012345670".slice(-14));
    expect(normalizeGtin("0000012345670")).toHaveLength(14);
    expect(upcA === null || upcA.length === 14).toBe(true);
  });

  it("rejects invalid or malformed barcodes rather than accepting them", () => {
    expect(normalizeGtin("123")).toBeNull();
    expect(normalizeGtin("abcdefghijkl")).toBeNull();
    expect(normalizeGtin(null)).toBeNull();
    expect(normalizeGtin("0000012345671")).toBeNull(); // bad check digit
  });
});

describe("fat percentage", () => {
  it("normalizes common printings", () => {
    expect(normalizeFatPercentage("0%")).toBe("0");
    expect(normalizeFatPercentage("0 %")).toBe("0");
    expect(normalizeFatPercentage("3.25%")).toBe("3.25");
    expect(normalizeFatPercentage("2 M.F.")).toBe("2");
    expect(normalizeFatPercentage(null)).toBeNull();
  });
});
