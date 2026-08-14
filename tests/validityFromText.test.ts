/**
 * Reading a flyer's run dates out of its own text.
 *
 * The strings below are what the real week-33 Montreal flyers print. Getting
 * these without an API call is what makes a flyer's dates available when the
 * quota is spent — which is precisely when they were being reported missing.
 */

import { describe, expect, it } from "vitest";

import {
  validityFromPages,
  validityFromText,
} from "@/services/flyers/pdf/validityFromText";

describe("what a Quebec flyer prints", () => {
  it("reads the French form, with the month named twice", () => {
    expect(
      validityFromText("Du jeudi 13 août au mercredi 19 août 2026"),
    ).toEqual({ from: "2026-08-13", to: "2026-08-19" });
  });

  it("reads the French form with the month named once", () => {
    expect(validityFromText("du 13 au 19 août 2026")).toEqual({
      from: "2026-08-13",
      to: "2026-08-19",
    });
  });

  it("reads the English form with ordinals", () => {
    expect(
      validityFromText(
        "From Thursday, August 13th to Wednesday, August 19th, 2026",
      ),
    ).toEqual({ from: "2026-08-13", to: "2026-08-19" });
  });

  it("reads the numeric form Metro Inc uses", () => {
    expect(validityFromText("Valid 13-08-26 - 19-08-26")).toEqual({
      from: "2026-08-13",
      to: "2026-08-19",
    });
  });

  it("does not care about accents or case", () => {
    expect(validityFromText("DU JEUDI 13 AOUT AU MERCREDI 19 AOUT 2026")).toEqual(
      { from: "2026-08-13", to: "2026-08-19" },
    );
  });
});

describe("what it refuses", () => {
  it("refuses a range with no year rather than assuming this one", () => {
    // A December flyer read in January would come out eleven months wrong.
    expect(validityFromText("du 13 au 19 août")).toBeNull();
  });

  it("refuses a day that does not exist", () => {
    expect(validityFromText("du 31 au 32 février 2026")).toBeNull();
  });

  it("finds nothing in artwork, which is the ordinary case", () => {
    expect(validityFromText("")).toBeNull();
    expect(validityFromText("Fruits et légumes")).toBeNull();
  });

  it("handles a range that runs backwards by declining it", () => {
    expect(validityFromText("du 19 août au 13 août 2026")).toBeNull();
  });
});

describe("which page is believed", () => {
  it("takes the cover's window, not a coupon expiry deeper in", () => {
    const found = validityFromPages([
      { pageNumber: 1, text: "Du jeudi 13 août au mercredi 19 août 2026" },
      { pageNumber: 9, text: "Coupon valide du 1 septembre au 30 septembre 2026" },
    ]);
    expect(found).toEqual({ from: "2026-08-13", to: "2026-08-19" });
  });

  it("ignores pages beyond the first few", () => {
    expect(
      validityFromPages([
        { pageNumber: 9, text: "du 1 au 30 septembre 2026" },
      ]),
    ).toBeNull();
  });

  it("handles a window that crosses new year", () => {
    expect(validityFromText("du 28 décembre au 3 janvier 2027")).toEqual({
      from: "2026-12-28",
      to: "2027-01-03",
    });
  });
});
