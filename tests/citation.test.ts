/**
 * What gets said to a cashier, and what gets refused.
 */

import { describe, expect, it } from "vitest";

import {
  citationEvidence,
  citationIsCurrent,
  citationLine,
} from "@/services/flyers/citation";

const iga = {
  retailerId: "iga" as const,
  flyerPage: 7,
  validFrom: "2026-08-13",
  validTo: "2026-08-19",
  hasPageImage: true,
};

describe("the line a shopper shows", () => {
  it("names the retailer, the page and the window", () => {
    expect(citationLine(iga)).toBe("IGA flyer, page 7, valid Aug 13 to Aug 19");
  });

  it("reads the same whether or not a picture was kept", () => {
    // The page number is stored on every offer, so the claim survives a
    // decision not to spend storage on images.
    expect(citationLine({ ...iga, hasPageImage: false })).toBe(
      citationLine(iga),
    );
  });

  it("does not shift a date backwards across a timezone", () => {
    // Parsed at local midnight, "2026-08-13" lands on the 12th west of
    // Greenwich, and a flyer shown as expiring a day early is one nobody takes
    // to the till.
    expect(citationLine(iga)).toContain("Aug 19");
    expect(citationLine(iga)).not.toContain("Aug 18");
  });
});

describe("what the shopper has to do about the document", () => {
  it("points at the saved page when there is one", () => {
    expect(citationEvidence(iga)).toMatch(/saved/);
  });

  it("says plainly when there is not", () => {
    // Learned while planning a shop, not at the till.
    expect(citationEvidence({ ...iga, hasPageImage: false })).toMatch(
      /your own copy/,
    );
  });
});

describe("whether the citation is still true", () => {
  it("holds inside the window", () => {
    expect(citationIsCurrent(iga, new Date("2026-08-15T12:00:00Z"))).toBe(true);
  });

  it("holds on the last day", () => {
    expect(citationIsCurrent(iga, new Date("2026-08-19T23:00:00Z"))).toBe(true);
  });

  it("fails the day after, because that is a false claim rather than a weak one", () => {
    expect(citationIsCurrent(iga, new Date("2026-08-20T00:30:00Z"))).toBe(false);
  });

  it("fails before the flyer opens", () => {
    expect(citationIsCurrent(iga, new Date("2026-08-12T12:00:00Z"))).toBe(false);
  });
});
