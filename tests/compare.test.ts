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
    box: null,
    rejectedAt: null,
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

describe("opting into conditional prices", () => {
  // Two problems were filed under one word. "Requires the card" advertises a
  // price for ONE item and the catch is whether you qualify. "2 for $5"
  // advertises the price of TWO. Only the first can be opted into.

  const card = (patch: Partial<StoredOffer> = {}): StoredOffer =>
    offer({ condition: "LOYALTY_ONLY", conditionText: "avec carte Scène+", ...patch });

  it("leaves card prices out until asked", () => {
    const offers = [
      offer({ id: "a", retailerId: "maxi", advertisedText: "Lait 2% 2 L", price: 599 }),
      card({ id: "b", retailerId: "iga", advertisedText: "Lait 2% 2 L", price: 399 }),
    ];
    expect(findPriceGaps(offers, 50)).toHaveLength(0);
  });

  it("includes them when asked, and marks the gap", () => {
    const offers = [
      offer({ id: "a", retailerId: "maxi", advertisedText: "Lait 2% 2 L", price: 599 }),
      card({ id: "b", retailerId: "iga", advertisedText: "Lait 2% 2 L", price: 399 }),
    ];
    const gaps = findPriceGaps(offers, 50, true);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.savingCents).toBe(200);
    // The flag is what lets the card say so where the number is read, rather
    // than only in a setting somebody toggled and forgot.
    expect(gaps[0]!.hasConditional).toBe(true);
  });

  it("never includes a multi-buy, whatever the setting", () => {
    // $5 is the price of two. Beside $3.99 each it reads a dollar cheaper
    // when it is a dollar dearer per item, and no label fixes a subtraction
    // between two different quantities.
    const offers = [
      offer({ id: "a", retailerId: "maxi", advertisedText: "Lait 2% 2 L", price: 399 }),
      offer({
        id: "b",
        retailerId: "iga",
        advertisedText: "Lait 2% 2 L",
        price: 500,
        condition: "MULTI_BUY",
        conditionText: "2 pour 5$",
      }),
    ];
    expect(findPriceGaps(offers, 50, true)).toHaveLength(0);
  });

  it("never includes a with-purchase offer either", () => {
    const offers = [
      offer({ id: "a", retailerId: "maxi", advertisedText: "Lait 2% 2 L", price: 599 }),
      offer({
        id: "b",
        retailerId: "iga",
        advertisedText: "Lait 2% 2 L",
        price: 199,
        condition: "WITH_PURCHASE",
        conditionText: "à l'achat de 3 produits",
      }),
    ];
    expect(findPriceGaps(offers, 50, true)).toHaveLength(0);
  });

  it("leaves an all-unit-price gap unmarked", () => {
    const offers = [
      offer({ id: "a", retailerId: "maxi", advertisedText: "Lait 2% 2 L", price: 599 }),
      offer({ id: "b", retailerId: "iga", advertisedText: "Lait 2% 2 L", price: 399 }),
    ];
    expect(findPriceGaps(offers, 50, true)[0]!.hasConditional).toBe(false);
  });
});

describe("saying what the comparison was working from", () => {
  it("names each flyer with its dates and how much was read", () => {
    const offers = [
      offer({ id: "a", retailerId: "maxi", advertisedText: "Lait", price: 599 }),
      offer({ id: "b", retailerId: "iga", advertisedText: "Pain", price: 399 }),
    ];
    const summary = summariseComparison(offers, [], [
      { retailerId: "maxi", validFrom: "2026-08-13", pagesRead: 17, pageCount: 17 },
      { retailerId: "iga", validFrom: "2026-08-13", pagesRead: 4, pageCount: 16 },
    ]);

    expect(summary.sources).toHaveLength(2);
    const iga = summary.sources.find((s) => s.retailerId === "iga")!;
    expect(iga.pagesRead).toBe(4);
    expect(iga.pageCount).toBe(16);
    // A page unread is offers missing, not offers absent — the same
    // distinction the home card makes.
    expect(summary.incomplete).toBe(true);
  });

  it("does not claim incompleteness it cannot see", () => {
    // No flyer records supplied. Not knowing how many pages exist is not
    // evidence that some are unread.
    const summary = summariseComparison(
      [offer({ id: "a", retailerId: "maxi", advertisedText: "Lait", price: 599 })],
      [],
    );
    expect(summary.incomplete).toBe(false);
    expect(summary.sources[0]!.pagesRead).toBeNull();
  });

  it("counts conditional offers by whether they could ever be compared", () => {
    const offers = [
      offer({ id: "a", advertisedText: "Lait", price: 599 }),
      offer({ id: "b", advertisedText: "Pain", price: 399, condition: "LOYALTY_ONLY" }),
      offer({ id: "c", advertisedText: "Riz", price: 500, condition: "MULTI_BUY" }),
    ];
    const summary = summariseComparison(offers, []);
    expect(summary.offersConsidered).toBe(1);
    expect(summary.offersConditionalUsable).toBe(1);
    expect(summary.offersNeverComparable).toBe(1);
  });
});

describe("which readings are worth a person's time", () => {
  // A week is around nine hundred offers. The queue on /confirm is built from
  // both sides of every price gap, because a saving is a subtraction and a
  // wrong number on the dearer side invents a gap just as effectively as a
  // wrong one on the cheaper.

  it("names both sides of a gap, not only the cheaper one", () => {
    const offers = [
      offer({ id: "a", retailerId: "maxi", advertisedText: "Lait 2% 2 L", price: 599 }),
      offer({ id: "b", retailerId: "iga", advertisedText: "Lait 2% 2 L", price: 399 }),
    ];
    const gap = findPriceGaps(offers, 50)[0]!;
    expect(gap.cheapest.id).toBe("b");
    expect(gap.dearest.id).toBe("a");
  });

  it("leaves an offer no comparison depends on out of the reckoning", () => {
    // Advertised at one shop only. Nothing hangs on whether it was read
    // correctly, so nobody should be asked to check it.
    const offers = [
      offer({ id: "a", retailerId: "maxi", advertisedText: "Lait 2% 2 L", price: 599 }),
      offer({ id: "b", retailerId: "iga", advertisedText: "Lait 2% 2 L", price: 399 }),
      offer({ id: "c", retailerId: "maxi", advertisedText: "Sirop d'érable 540 ml", price: 999 }),
    ];
    const involved = new Set(
      findPriceGaps(offers, 50).flatMap((g) => [g.cheapest.id, g.dearest.id]),
    );
    expect(involved.has("c")).toBe(false);
    expect(involved.size).toBe(2);
  });
});
