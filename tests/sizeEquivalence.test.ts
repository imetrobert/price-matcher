/**
 * The same size, written every way a package or a person writes it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS PINNED SO HEAVILY
 * ---------------------------------------------------------------------------
 * Size is the field a price match turns on, and it arrives from three places
 * that agree on nothing: a flyer tile ("4 x 100 g"), a package photographed at
 * an angle ("400g"), and a person typing on a phone ("400 grams"). If those do
 * not compare equal, the app quietly refuses matches that are correct — and a
 * refusal is invisible, so nobody finds out.
 *
 * Every line below is a form that must compare equal to 400 g or 1 L.
 */

import { describe, expect, it } from "vitest";

import { parseSize, sizesMatch } from "@/services/products/normalize";

const size = (raw: string) => parseSize(raw).size;
const same = (a: string, b: string) => sizesMatch(size(a), size(b));

describe("grams, however they are written", () => {
  const forms = [
    "400 g",
    "400g",
    "400 G",
    "400gr",
    "400 gr",
    "400 gm",
    "400 gram",
    "400 grams",
    "400 grammes",
    "0.4 kg",
    "0,4 kg",
    "0.4 kilogram",
    "0.4 kilograms",
    "0.4 kilo",
    "4 x 100 g",
    "4x100g",
    "4 X 100 G",
    "4 × 100 g",
  ];

  for (const form of forms) {
    it(`treats "${form}" as 400 g`, () => {
      expect(same(form, "400 g")).toBe(true);
    });
  }

  it("still refuses a genuinely different pack", () => {
    // The tolerance absorbs unit-conversion rounding, nothing else. 650 vs 750
    // is a different tub and must never pass as the same product.
    expect(same("650 g", "750 g")).toBe(false);
    expect(same("400 g", "500 g")).toBe(false);
  });
});

describe("litres, however they are written", () => {
  const forms = [
    "1 L",
    "1l",
    "1 l",
    "1 litre",
    "1 litres",
    "1 liter",
    "1 liters",
    "1000 ml",
    "1000 mL",
    "1000ml",
    "1000 millilitres",
    "2 x 500 ml",
    "4 x 250 mL",
  ];

  for (const form of forms) {
    it(`treats "${form}" as 1 L`, () => {
      expect(same(form, "1 L")).toBe(true);
    });
  }

  it("refuses to guess at a thousands separator", () => {
    /*
      "1,000 ml" is not supported, deliberately. Where the comma is the decimal
      separator — which it is in Quebec, and "1,5 L" is printed everywhere —
      there is no way to tell 1,000 meaning one thousand from 1,000 meaning
      one. Guessing wrong scales a size by a thousand. So it reads as 1 ml and
      simply fails to match a litre, which is a missed match rather than a
      confident wrong one.
    */
    expect(same("1,000 ml", "1 L")).toBe(false);
    // The form that actually matters keeps working.
    expect(same("1,5 L", "1500 ml")).toBe(true);
  });

  it("keeps mass and volume apart", () => {
    // 400 g of yoghurt and 400 ml of milk are not the same size, and a system
    // that compares only the number would say they are.
    expect(same("400 g", "400 ml")).toBe(false);
    expect(same("1 kg", "1 L")).toBe(false);
  });
});

describe("multi-packs carry their count as well as their total", () => {
  it("totals a multi-pack", () => {
    expect(parseSize("4 x 100 g").size!.baseValue).toBe(400);
    expect(parseSize("4 x 100 g").packageCount).toBe(4);
  });

  it("counts a single pack as one", () => {
    expect(parseSize("400 g").packageCount).toBe(1);
  });
});

describe("what cannot be read is null, never a guess", () => {
  it("returns null for text with no size in it", () => {
    expect(size("family size")).toBeNull();
    expect(size("")).toBeNull();
    expect(size("grand format")).toBeNull();
  });

  it("never matches a null against anything", () => {
    expect(sizesMatch(null, size("400 g"))).toBe(false);
    expect(sizesMatch(null, null)).toBe(false);
  });
});
