/**
 * Comparing this week's flyers against each other.
 *
 * Every refusal below corresponds to a real tile in the week-33 Montreal set.
 * A comparison shown here is a claim that two shops sell the same thing at
 * different prices, and each rule exists because some flyer would otherwise
 * make that claim falsely.
 */

import { describe, expect, it } from "vitest";

import { findPriceGaps, isComparable, summariseComparison } from "@/services/flyers/compare";
import type { StoredOffer } from "@/services/flyers/storage";

function offer(patch: Partial<StoredOffer> = {}): StoredOffer {
  return {
    id: "o1",
    flyerId: "maxi-2026-08-13",
    retailerId: "maxi",
    advertisedText: "Oikos yogourt grec nature 650 g",
    brand: "Oikos",
    size: "650 g",
    retailerSku: null,
    price: 749,
    basis: "PER_ITEM",
    regularPrice: null,
    regularBasis: null,
    condition: "UNIT_PRICE",
    conditionText: null,
    flyerPage: 3,
    confirmedAt: null,
    validFrom: "2026-08-13",
    validTo: "2026-08-19",
    ...patch,
  };
}

describe("finding a real gap", () => {
  it("pairs the same product across two retailers", () => {
    const gaps = findPriceGaps(
      [
        offer(),
        offer({
          id: "o2",
          flyerId: "iga-2026-08-13",
          retailerId: "iga",
          price: 599,
        }),
      ],
      50,
    );

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.savingCents).toBe(150);
    expect(gaps[0]!.cheapest.retailerId).toBe("iga");
    expect(gaps[0]!.dearest.retailerId).toBe("maxi");
  });

  it("pairs across languages", () => {
    // The point of the lexicon, exercised end to end: a French tile at Maxi
    // and an English one at Walmart for the same tub.
    const gaps = findPriceGaps(
      [
        offer({ advertisedText: "beurre Lactantia 454 g", brand: "Lactantia", size: "454 g" }),
        offer({
          id: "o2",
          flyerId: "walmart-2026-08-13",
          retailerId: "walmart",
          advertisedText: "Lactantia butter 454 g",
          brand: "Lactantia",
          size: "454 g",
          price: 498,
        }),
      ],
      50,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.savingCents).toBe(251);
  });

  it("puts the biggest gap first, which is how a trip gets planned", () => {
    const gaps = findPriceGaps(
      [
        offer(),
        offer({ id: "o2", retailerId: "iga", flyerId: "iga-1", price: 699 }),
        offer({
          id: "o3",
          advertisedText: "Lactantia beurre 454 g",
          brand: "Lactantia",
          size: "454 g",
          price: 799,
        }),
        offer({
          id: "o4",
          retailerId: "superc",
          flyerId: "superc-1",
          advertisedText: "Lactantia butter 454 g",
          brand: "Lactantia",
          size: "454 g",
          price: 399,
        }),
      ],
      50,
    );
    expect(gaps[0]!.savingCents).toBeGreaterThan(gaps[1]!.savingCents);
  });
});

describe("what is never compared", () => {
  it("refuses two units against each other", () => {
    // "$8.96 per lb" against "$12.99 each" is not a saving of $4.03. Metro
    // prints the first and Walmart the second on the same category.
    const gaps = findPriceGaps(
      [
        offer({ advertisedText: "saumon Atlantique frais", brand: null, size: null, basis: "PER_LB", price: 896 }),
        offer({
          id: "o2",
          retailerId: "walmart",
          flyerId: "walmart-1",
          advertisedText: "fresh Atlantic salmon",
          brand: null,
          size: null,
          basis: "PER_ITEM",
          price: 1299,
        }),
      ],
      50,
    );
    expect(gaps).toEqual([]);
  });

  it("refuses a loyalty price", () => {
    // IGA prints a Scene+ price and a non-card price on the same tile. Compared
    // against a plain shelf price, the card one is a saving that evaporates
    // when the cashier asks for the card.
    const loyalty = offer({
      id: "o2",
      retailerId: "iga",
      flyerId: "iga-1",
      price: 499,
      condition: "LOYALTY_ONLY",
      conditionText: "Avec carte Scène+",
    });
    expect(isComparable(loyalty)).toBe(false);
    expect(findPriceGaps([offer(), loyalty], 50)).toEqual([]);
  });

  it("refuses a multi-buy", () => {
    const multi = offer({
      id: "o2",
      retailerId: "iga",
      flyerId: "iga-1",
      price: 500,
      condition: "MULTI_BUY",
      conditionText: "2 for $5",
    });
    expect(findPriceGaps([offer(), multi], 50)).toEqual([]);
  });

  it("refuses two different sizes", () => {
    const gaps = findPriceGaps(
      [
        offer(),
        offer({ id: "o2", retailerId: "iga", flyerId: "iga-1", size: "500 g", price: 599 }),
      ],
      50,
    );
    expect(gaps).toEqual([]);
  });

  it("refuses two different brands", () => {
    const gaps = findPriceGaps(
      [
        offer(),
        offer({
          id: "o2",
          retailerId: "iga",
          flyerId: "iga-1",
          brand: "Liberté",
          advertisedText: "Liberté yogourt grec nature 650 g",
          price: 599,
        }),
      ],
      50,
    );
    expect(gaps).toEqual([]);
  });

  it("refuses two offers from the same retailer", () => {
    // Two Maxi tiles for one yogurt are a duplicate, not a saving.
    const gaps = findPriceGaps([offer(), offer({ id: "o2", price: 599 })], 50);
    expect(gaps).toEqual([]);
  });

  it("refuses a gap below the threshold", () => {
    // Nobody crosses the street for fifteen cents.
    const gaps = findPriceGaps(
      [offer(), offer({ id: "o2", retailerId: "iga", flyerId: "iga-1", price: 734 })],
      50,
    );
    expect(gaps).toEqual([]);
  });
});

describe("saying what the comparison was working from", () => {
  it("counts what was used and what was set aside", () => {
    // "No gaps found" means something different with two flyers than with five.
    const summary = summariseComparison(
      [
        offer(),
        offer({ id: "o2", retailerId: "iga", condition: "MULTI_BUY" }),
        offer({ id: "o3", retailerId: "walmart" }),
      ],
      [],
    );
    expect(summary.offersConsidered).toBe(2);
    expect(summary.offersSkippedConditional).toBe(1);
    expect(summary.retailers).toEqual(["iga", "maxi", "walmart"]);
  });
});
