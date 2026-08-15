/**
 * Where an offer sits on its page.
 *
 * "IGA, page 7" is a citation somebody can check, and a page of a Montreal
 * grocery flyer carries twenty to thirty tiles — so checking it means pinching
 * around artwork on a phone, at a till, with somebody waiting. The box is what
 * closes that distance.
 *
 * It is decoration in the strict sense: no price, comparison or citation
 * depends on it. Which is exactly why every check below discards a doubtful
 * box rather than repairing it. A rectangle drawn in the wrong place points
 * somebody confidently at a product that is not theirs, and that is worse than
 * drawing nothing at all.
 */

import { describe, expect, it } from "vitest";

import { parseFlyerExtraction } from "@shared/parseOffers";

function withBox(box: unknown) {
  return parseFlyerExtraction(
    {
      offers: [
        {
          advertisedText: "Lait 2% 2 L",
          priceDollars: 4,
          priceCents: 99,
          basis: "PER_ITEM",
          condition: "UNIT_PRICE",
          box,
        },
      ],
    },
    7,
  ).offers[0]!;
}

describe("a box that describes a rectangle", () => {
  it("is kept in the order it was asked for", () => {
    // [ymin, xmin, ymax, xmax] on a 0-1000 scale, origin top-left.
    expect(withBox([100, 200, 300, 500]).box).toEqual([100, 200, 300, 500]);
  });

  it("allows the full extent of the page", () => {
    expect(withBox([0, 0, 1000, 1000]).box).toEqual([0, 0, 1000, 1000]);
  });
});

describe("a box that does not", () => {
  it("is dropped when the corners are inverted", () => {
    // ymax before ymin is not a reading of anything, and guessing which pair
    // was meant would invent a location.
    expect(withBox([500, 200, 100, 400]).box).toBeNull();
  });

  it("is dropped when it has no area", () => {
    expect(withBox([100, 200, 100, 400]).box).toBeNull();
  });

  it("is dropped when a number is out of range", () => {
    expect(withBox([0, 0, 1200, 500]).box).toBeNull();
    expect(withBox([-10, 0, 500, 500]).box).toBeNull();
  });

  it("is dropped when it is not four numbers", () => {
    expect(withBox([100, 200, 300]).box).toBeNull();
    expect(withBox([100, 200, 300, 400, 500]).box).toBeNull();
    expect(withBox(["100", "200", "300", "400"]).box).toBeNull();
  });

  it("is dropped when the numbers are fractional", () => {
    // Whole numbers were asked for. A fraction means something else was
    // returned, and reading it anyway is trusting a reply that did not follow
    // the schema.
    expect(withBox([10.5, 20, 300, 400]).box).toBeNull();
  });

  it("is null when the model said nothing", () => {
    expect(withBox(undefined).box).toBeNull();
    expect(withBox(null).box).toBeNull();
  });
});

describe("the offer survives a bad box", () => {
  it("keeps the price when the box is discarded", () => {
    // The price is the offer. The box is a convenience for finding it, and
    // losing it must never cost a saving.
    const offer = withBox([999, 999, 1, 1]);
    expect(offer.price).toBe(499);
    expect(offer.box).toBeNull();
  });
});
