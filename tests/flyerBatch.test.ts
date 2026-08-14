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

describe("what the batch reports when it is done", () => {
  const item = (patch: Partial<BatchItem>): BatchItem =>
    ({
      id: "x",
      file: new File([], "f.pdf"),
      retailerId: "maxi",
      retailerFrom: "FILENAME",
      stage: "DONE",
      detail: "",
      pages: null,
      result: {
        offers: [],
        rejected: [],
        failedPages: [],
        notAttempted: [],
        model: "m",
        retailerName: null,
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
          failedPages: [{ pageNumber: 2, error: "quota" }],
          notAttempted: [3, 4, 5],
          model: "m",
          retailerName: null,
        },
      }),
    ]);
    expect(totals.flyersDone).toBe(1);
    expect(totals.flyersIncomplete).toBe(1);
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
