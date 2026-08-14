/**
 * The line on the home screen that answers "do I have this week's prices?"
 */

import { describe, expect, it } from "vitest";

import { flyerStatus } from "@/services/flyers/status";
import type { StoredFlyer } from "@/services/flyers/storage";

function flyer(patch: Partial<StoredFlyer> = {}): StoredFlyer {
  return {
    id: "maxi-2026-08-13",
    retailerId: "maxi",
    validFrom: "2026-08-13",
    validTo: "2026-08-19",
    pageCount: 17,
    pagesRead: 17,
    sourceFilename: "PDF_wk33-2026-SA V6.pdf",
    validitySource: "COVER",
    ...patch,
  };
}

const DURING = new Date("2026-08-15T12:00:00Z");
const AFTER = new Date("2026-08-21T12:00:00Z");

describe("nothing covering today", () => {
  it("asks for the latest flyers when none were ever loaded", () => {
    const status = flyerStatus([], DURING);
    expect(status.readiness).toBe("NONE");
    expect(status.headline).toBe("Upload the latest flyers");
    expect(status.detail).toMatch(/No flyers have been loaded/);
  });

  it("says the held ones expired rather than that nothing exists", () => {
    // The Thursday-morning case. Somebody who loaded flyers last week is owed
    // "those have run out", not "you have never done this".
    const status = flyerStatus([flyer()], AFTER);
    expect(status.readiness).toBe("NONE");
    expect(status.detail).toMatch(/expired/);
    expect(status.detail).toMatch(/Aug 19/);
  });
});

describe("partly loaded", () => {
  it("is its own state, not rounded up to loaded", () => {
    // A flyer read to page two of seventeen has offers, looks complete in a
    // list, and is not this week's prices.
    const status = flyerStatus([flyer({ pagesRead: 2 })], DURING);
    expect(status.readiness).toBe("PARTIAL");
    expect(status.percent).toBe(12);
    expect(status.headline).toMatch(/12%/);
  });

  it("counts pages across every flyer, not files", () => {
    const status = flyerStatus(
      [
        flyer({ pagesRead: 17, pageCount: 17 }),
        flyer({
          id: "iga-2026-08-13",
          retailerId: "iga",
          pagesRead: 3,
          pageCount: 16,
        }),
      ],
      DURING,
    );
    expect(status.pagesRead).toBe(20);
    expect(status.pagesTotal).toBe(33);
    expect(status.readiness).toBe("PARTIAL");
  });
});

describe("loaded", () => {
  it("names the stores it holds and the window they run", () => {
    const status = flyerStatus(
      [flyer(), flyer({ id: "iga-2026-08-13", retailerId: "iga", pageCount: 16, pagesRead: 16 })],
      DURING,
    );
    expect(status.readiness).toBe("LOADED");
    expect(status.headline).toBe("Flyers loaded — Aug 13 to Aug 19");
    expect(status.detail).toMatch(/IGA and Maxi/);
    expect(status.detail).toMatch(/33 pages/);
  });

  it("does not claim the set is complete", () => {
    // Nobody told the app which stores the shopper cares about, so counting
    // down to a total it invented would be a claim it cannot support.
    const status = flyerStatus([flyer()], DURING);
    expect(status.detail).not.toMatch(/of 5|of five/i);
    expect(status.retailers).toEqual(["maxi"]);
  });

  it("shows the widest window when retailers run different days", () => {
    const status = flyerStatus(
      [
        flyer(),
        flyer({
          id: "superc-2026-08-14",
          retailerId: "superc",
          validFrom: "2026-08-14",
          validTo: "2026-08-20",
          pageCount: 17,
          pagesRead: 17,
        }),
      ],
      DURING,
    );
    // Showing one flyer's dates as if they were all of them would misstate
    // when the others expire.
    expect(status.validFrom).toBe("2026-08-13");
    expect(status.validTo).toBe("2026-08-20");
  });
});
