/**
 * Deciding which flyer is which.
 *
 * The filenames below are the real ones from the week-33 Montreal set. Getting
 * this wrong is not untidy: a Maxi flyer filed under IGA produces price
 * matches attributed to the wrong shop, which is a false claim made to a
 * cashier.
 */

import { describe, expect, it } from "vitest";

import {
  batchTotals,
  retailerFromFilename,
  retailerFromLogo,
  validityFromFilename,
  type BatchItem,
} from "@/services/flyers/batch";

describe("reading the retailer off a filename", () => {
  it("recognises the ones that name themselves", () => {
    expect(
      retailerFromFilename("SuperC Weekly Flyer 2 Valid 13-08-26 - 19-08-26.pdf"),
    ).toBe("superc");
    expect(
      retailerFromFilename("Metro Que Weekly Flyer 1 Valid 13-08-26 - 19-08-26.pdf"),
    ).toBe("metro");
    expect(retailerFromFilename("PDF_wk33-2026-WM-AB V2.pdf")).toBe("walmart");
  });

  it("refuses to guess between Maxi and IGA", () => {
    // Both arrive as "PDF_wk33-2026-SA V<n>.pdf" from the same host. The only
    // difference is the version number, which says nothing about the store.
    // A guess right half the time is worse than none: it looks like knowledge.
    expect(retailerFromFilename("PDF_wk33-2026-SA V6.pdf")).toBeNull();
    expect(retailerFromFilename("PDF_wk33-2026-SA V0.pdf")).toBeNull();
  });

  it("uses a name when the file actually carries one", () => {
    expect(retailerFromFilename("maxi-week33.pdf")).toBe("maxi");
    expect(retailerFromFilename("IGA_flyer.pdf")).toBe("iga");
  });
});

describe("reading the retailer off the logo on page 1", () => {
  it("matches the store names the app knows", () => {
    expect(retailerFromLogo("Walmart")).toBe("walmart");
    expect(retailerFromLogo("Super C")).toBe("superc");
    expect(retailerFromLogo("IGA")).toBe("iga");
  });

  it("survives punctuation and case the way a logo is written", () => {
    expect(retailerFromLogo("super c")).toBe("superc");
    expect(retailerFromLogo("METRO")).toBe("metro");
  });

  it("says nothing when it saw nothing", () => {
    expect(retailerFromLogo(null)).toBeNull();
    expect(retailerFromLogo("")).toBeNull();
    expect(retailerFromLogo("Coca-Cola")).toBeNull();
  });
});

describe("run dates in a filename", () => {
  it("reads the window Metro Inc writes into its filenames", () => {
    expect(
      validityFromFilename("SuperC Weekly Flyer 2 Valid 13-08-26 - 19-08-26.pdf"),
    ).toEqual({ from: "2026-08-13", to: "2026-08-19" });
  });

  it("says nothing about filenames that carry no dates", () => {
    expect(validityFromFilename("PDF_wk33-2026-SA V6.pdf")).toBeNull();
  });

  it("refuses a window that runs backwards", () => {
    expect(validityFromFilename("Flyer 19-08-26 - 13-08-26.pdf")).toBeNull();
  });

  it("refuses a month that does not exist", () => {
    // Guards against a day-month-year file being read as month-day-year.
    expect(validityFromFilename("Flyer 13-19-26 - 19-20-26.pdf")).toBeNull();
  });
});

describe("what the batch reports when it is done", () => {
  const item = (patch: Partial<BatchItem>): BatchItem =>
    ({
      id: "x",
      file: new File([], "f.pdf"),
      pageCount: 17,
      pagesRead: 17,
      validFrom: "2026-08-13",
      validTo: "2026-08-19",
      validityFrom: "FILENAME",
      saved: { offers: 0, pages: 17 },
      saveError: null,
      retailerId: "maxi",
      retailerFrom: "FILENAME",
      stage: "DONE",
      detail: "",
      pages: null,
      result: {
        offers: [],
        rejected: [],
        pageYield: [],
        failedPages: [],
        notAttempted: [],
        model: "m",
        retailerName: null,
        validFrom: null,
        validTo: null,
        stoppedReason: null,
      },
      error: null,
      ...patch,
    }) as BatchItem;

  it("counts a partly read flyer as incomplete, not as done", () => {
    // The distinction the whole result screen turns on: a flyer read to page 2
    // of 17 has offers, a full page grid, and is not this week's prices.
    const totals = batchTotals([
      item({}),
      item({
        result: {
          offers: [],
          rejected: [],
          pageYield: [],
          failedPages: [{ pageNumber: 2, error: "quota" }],
          notAttempted: [3, 4, 5],
          model: "m",
          retailerName: null,
          validFrom: null,
          validTo: null,
          stoppedReason: null,
        },
      }),
    ]);
    expect(totals.flyersDone).toBe(1);
    expect(totals.flyersIncomplete).toBe(1);
  });

  it("counts flyers whose dates were never found", () => {
    // An offer with no end date cannot back a checkout claim, so this is a
    // gap worth interrupting for rather than a cosmetic blank.
    const totals = batchTotals([
      item({ validTo: null }),
      item({}),
    ]);
    expect(totals.needsDates).toBe(1);
  });

  it("reports progress in pages rather than in files", () => {
    const totals = batchTotals([
      item({ pageCount: 17, pagesRead: 17 }),
      item({ pageCount: 8, pagesRead: 2 }),
    ]);
    expect(totals.pagesTotal).toBe(25);
    expect(totals.pagesRead).toBe(19);
    expect(totals.percent).toBe(76);
  });

  it("reports zero rather than nonsense before counting finishes", () => {
    const totals = batchTotals([item({ pageCount: null, pagesRead: 0 })]);
    expect(totals.percent).toBe(0);
  });

  it("counts a flyer that was read but not stored", () => {
    // Read and not saved is the worst outcome to leave quiet: the offers are
    // on screen, look complete, and vanish when the page closes.
    const totals = batchTotals([
      item({ saved: null, saveError: "no dates" }),
      item({}),
    ]);
    expect(totals.notSaved).toBe(1);
  });

  it("counts flyers still missing a store", () => {
    const totals = batchTotals([item({ retailerId: null }), item({})]);
    expect(totals.needsRetailer).toBe(1);
  });

  it("counts a failed flyer separately from a thin one", () => {
    const totals = batchTotals([
      item({ stage: "FAILED", result: null }),
      item({}),
    ]);
    expect(totals.flyersFailed).toBe(1);
    expect(totals.flyersDone).toBe(1);
  });
});

describe("recognising a banner from a filename", () => {
  // The names come from the registry now rather than a second hardcoded list.
  // The repetition is how a banner gets added in one place and stays invisible
  // in the other, which is exactly what happened with Adonis.

  it("reads the banners it knows", () => {
    expect(retailerFromFilename("Maxi_flyer.pdf")).toBe("maxi");
    expect(retailerFromFilename("IGA_flyer.pdf")).toBe("iga");
    expect(retailerFromFilename("Metro Que Weekly.pdf")).toBe("metro");
    expect(retailerFromFilename("Adonis circulaire.pdf")).toBe("adonis");
  });

  it("prefers the more specific banner where two names collide", () => {
    // Super C belongs to Metro Inc and its files carry both names. Longest
    // name first is what gets this right without naming the pair.
    expect(retailerFromFilename("SuperC Weekly Flyer Metro Inc.pdf")).toBe("superc");
    expect(retailerFromFilename("Super C Valid 13-08-26.pdf")).toBe("superc");
  });

  it("still reads the one alias no display name carries", () => {
    expect(retailerFromFilename("WM_flyer_wk33.pdf")).toBe("walmart");
  });

  it("says nothing rather than guessing", () => {
    // Loblaw and Sobeys files share the token "SA". A guess that is right half
    // the time is worse than none, because it looks like knowledge.
    expect(retailerFromFilename("PDF_wk33-2026-SA V6.pdf")).toBeNull();
    expect(retailerFromFilename("circulaire.pdf")).toBeNull();
  });
});
