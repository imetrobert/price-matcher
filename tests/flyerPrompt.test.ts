/**
 * The instructions the model reads, which are now in one place.
 *
 * Two copies existed — vision and worker — and by the time anybody compared
 * them they had drifted to 3,243 and 1,940 characters, giving materially
 * different instructions for the same job. Nothing would have surfaced that
 * but reading both.
 */

import { describe, expect, it } from "vitest";

import { FLYER_PROMPT, FLYER_SCHEMA } from "@shared/flyerPrompt";

describe("the rules that keep a number honest", () => {
  it("asks for the price as two numerals, never as a decimal", () => {
    // A flyer prints a large 4 and a small 99 with no decimal point at all.
    // "The price" invites 4.99, 499, 4,99 or 4 99 — one of which is a
    // hundredfold error in a number shown to a cashier.
    expect(FLYER_PROMPT).toMatch(/priceDollars and priceCents/);
    expect(FLYER_PROMPT).toMatch(/priceDollars 4.*priceCents 99/s);
  });

  it("requires the unit, since it is printed six-point beside a forty-point price", () => {
    expect(FLYER_PROMPT).toMatch(/PER_LB when marked/);
    expect(FLYER_SCHEMA.properties.offers.items.required).toContain("basis");
  });

  it("refuses a price it cannot read rather than guessing at one", () => {
    expect(FLYER_PROMPT).toMatch(/omit that offer entirely rather than guessing/);
    expect(FLYER_PROMPT).toMatch(/Do not infer a price from a similar product/);
  });

  it("takes only the year printed on the page", () => {
    expect(FLYER_PROMPT).toMatch(/if no year is printed, return null/i);
  });
});

describe("one tile, several products", () => {
  // "Tomates en dés Aylmer 796 ml ou Sauce tomate 680 ml" is one price for
  // either of two products. Read as a single offer, somebody holding the
  // second was told their item was not advertised — a real saving, missing,
  // with no error and no low confidence to mark it.

  it("asks for one entry per product in a combined tile", () => {
    expect(FLYER_PROMPT).toMatch(/ONE ENTRY PER PRODUCT/);
    expect(FLYER_PROMPT).toMatch(/its own brand and its own size/);
  });

  it("says the parts share the tile's price", () => {
    expect(FLYER_PROMPT).toMatch(/sharing the tile's price, basis and condition/);
  });

  it("excludes alternative sizes of one product", () => {
    // "Kraft 175 g ou 200 g" is one product in two sizes. Splitting it would
    // manufacture a second offer nobody printed.
    expect(FLYER_PROMPT).toMatch(/alternative SIZES/);
    expect(FLYER_PROMPT).toMatch(/is ONE product/);
  });

  it("excludes flavours and varieties of one product", () => {
    expect(FLYER_PROMPT).toMatch(/flavours or varieties/);
  });

  it("resolves doubt toward one entry, not two", () => {
    // The asymmetry matters: a missed offer costs a saving, an invented one
    // reaches a cashier.
    expect(FLYER_PROMPT).toMatch(
      /unsure, return one entry — a single correct offer is worth more than two uncertain ones/,
    );
  });
});
