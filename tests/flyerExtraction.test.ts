/**
 * Parsing a model's reading of a flyer page.
 *
 * The cases below are drawn from real week-33 Montreal tiles, and every
 * rejection corresponds to a way a wrong number could otherwise reach a
 * cashier.
 */

import { describe, expect, it } from "vitest";

import { parseFlyerExtraction } from "@/services/flyers/pdf/parseExtraction";

function reply(offers: unknown[]): unknown {
  return { offers };
}

const OIKOS = {
  advertisedText: "Oikos yogourt grec nature 0% 650 g",
  brand: "Oikos",
  size: "650 g",
  retailerSku: null,
  priceDollars: 7,
  priceCents: 49,
  basis: "PER_ITEM",
  regularDollars: 8,
  regularCents: 49,
  condition: "UNIT_PRICE",
  conditionText: null,
};

describe("assembling a price from what was printed", () => {
  it("reads a superscript-cents price as dollars and cents", () => {
    const { offers } = parseFlyerExtraction(reply([OIKOS]), 3);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.price).toBe(749);
    expect(offers[0]!.regularPrice).toBe(849);
    expect(offers[0]!.pageNumber).toBe(3);
  });

  it("reads a sub-dollar price", () => {
    // Walmart page 1: corn at 44 cents.
    const { offers } = parseFlyerExtraction(
      reply([{ ...OIKOS, priceDollars: 0, priceCents: 44 }]),
      1,
    );
    expect(offers[0]!.price).toBe(44);
  });

  it("takes the page number from the caller, not the model", () => {
    const { offers } = parseFlyerExtraction(
      reply([{ ...OIKOS, pageNumber: 99 }]),
      3,
    );
    expect(offers[0]!.pageNumber).toBe(3);
  });
});

describe("what gets dropped, and why", () => {
  it("drops an offer whose price is not two integers", () => {
    const { offers, rejected } = parseFlyerExtraction(
      reply([{ ...OIKOS, priceDollars: 7.49, priceCents: null }]),
      3,
    );
    expect(offers).toEqual([]);
    expect(rejected[0]).toMatch(/dollars and cents/);
  });

  it("drops cents outside 0..99, which mean the shape was misunderstood", () => {
    const { offers } = parseFlyerExtraction(
      reply([{ ...OIKOS, priceDollars: 0, priceCents: 749 }]),
      3,
    );
    expect(offers).toEqual([]);
  });

  it("drops a price no grocery flyer would print", () => {
    const { offers, rejected } = parseFlyerExtraction(
      reply([{ ...OIKOS, priceDollars: 51087737, priceCents: 0 }]),
      1,
    );
    expect(offers).toEqual([]);
    expect(rejected[0]).toMatch(/not a grocery price/);
  });

  it("drops an offer with no basis rather than assuming PER_ITEM", () => {
    // The whole point. A missing unit is how a price per pound becomes a
    // number that looks comparable to a package price.
    const { offers, rejected } = parseFlyerExtraction(
      reply([{ ...OIKOS, basis: undefined }]),
      3,
    );
    expect(offers).toEqual([]);
    expect(rejected[0]).toMatch(/basis/);
  });

  it("drops an unrecognised basis rather than coercing it", () => {
    const { offers } = parseFlyerExtraction(
      reply([{ ...OIKOS, basis: "PER_POUND" }]),
      3,
    );
    expect(offers).toEqual([]);
  });

  it("drops an offer with no product wording", () => {
    const { offers, rejected } = parseFlyerExtraction(
      reply([{ ...OIKOS, advertisedText: "   " }]),
      3,
    );
    expect(offers).toEqual([]);
    expect(rejected[0]).toMatch(/nothing to match against/);
  });

  it("keeps the good offers on a page that also had a bad one", () => {
    const { offers, rejected } = parseFlyerExtraction(
      reply([OIKOS, { ...OIKOS, basis: "NONSENSE" }]),
      3,
    );
    expect(offers).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("says so when the reply has no offers list at all", () => {
    expect(parseFlyerExtraction({ result: "none" }, 3).rejected[0]).toMatch(
      /no list of offers/,
    );
  });
});

describe("fields that need cleaning rather than trusting", () => {
  it("keeps only the digits of an article number", () => {
    // "N° 51087737" and "51087737" are one article number, not two.
    const { offers } = parseFlyerExtraction(
      reply([{ ...OIKOS, retailerSku: "N° 51087737" }]),
      1,
    );
    expect(offers[0]!.retailerSku).toBe("51087737");
  });

  it("drops a regular price that is not above the sale price", () => {
    // A struck-through price lower than the one beside it is a misread, and
    // showing it would advertise a saving that runs backwards.
    const { offers } = parseFlyerExtraction(
      reply([{ ...OIKOS, regularDollars: 6, regularCents: 99 }]),
      3,
    );
    expect(offers[0]!.regularPrice).toBeNull();
  });

  it("carries a per-pound basis through untouched", () => {
    // Metro: "8.96 /lb — filet de saumon Atlantique frais".
    const { offers } = parseFlyerExtraction(
      reply([
        {
          ...OIKOS,
          advertisedText: "filet de saumon Atlantique frais",
          brand: null,
          size: null,
          priceDollars: 8,
          priceCents: 96,
          basis: "PER_LB",
          regularDollars: 14,
          regularCents: 99,
        },
      ]),
      5,
    );
    expect(offers[0]!.basis).toBe("PER_LB");
    expect(offers[0]!.price).toBe(896);
  });
});
