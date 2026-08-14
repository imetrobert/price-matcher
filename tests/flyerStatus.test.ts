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

describe("stopped, versus still going", () => {
  // The bug this covers held a spinner at 31% for an evening: the card counted
  // pages that finished, so a queue that had run out of attempts looked
  // identical to one still working through the backlog.

  it("says nothing is queued when nothing is", () => {
    const status = flyerStatus([flyer({ pagesRead: 5 })], DURING, {
      "maxi-2026-08-13": { pending: 0, reading: 0, done: 5, failed: 12, waitingReason: null },
    });
    expect(status.readiness).toBe("PARTIAL");
    expect(status.stalled).toBe(true);
    expect(status.pagesFailed).toBe(12);
    expect(status.headline).toMatch(/stopped/i);
    expect(status.detail).toMatch(/nothing is queued/);
    // The old wording promised an arrival that was not coming.
    expect(status.detail).not.toMatch(/The rest are queued/);
  });

  it("is not stalled while pages are still waiting their turn", () => {
    // A failure alongside live work is not a stopped run.
    const status = flyerStatus([flyer({ pagesRead: 5 })], DURING, {
      "maxi-2026-08-13": { pending: 11, reading: 1, done: 5, failed: 1, waitingReason: null },
    });
    expect(status.stalled).toBe(false);
    expect(status.detail).toMatch(/The rest are queued/);
  });

  it("treats a page being read as work in progress", () => {
    const status = flyerStatus([flyer({ pagesRead: 16 })], DURING, {
      "maxi-2026-08-13": { pending: 0, reading: 1, done: 16, failed: 0, waitingReason: null },
    });
    expect(status.stalled).toBe(false);
  });

  it("does not claim the work stopped when it cannot see the queue", () => {
    // No counts supplied. Not knowing is not evidence of having stopped, and
    // the screen must not invent the stronger claim.
    const status = flyerStatus([flyer({ pagesRead: 5 })], DURING);
    expect(status.stalled).toBe(false);
    expect(status.headline).toMatch(/Reading Aug 13/);
  });

  it("ignores failures belonging to a flyer that has expired", () => {
    // Last week's abandoned pages must not stall this week's card.
    const status = flyerStatus(
      [flyer({ pagesRead: 4 }), flyer({ id: "iga-2026-08-06", validFrom: "2026-08-06", validTo: "2026-08-12" })],
      DURING,
      {
        "maxi-2026-08-13": { pending: 13, reading: 0, done: 4, failed: 0, waitingReason: null },
        "iga-2026-08-06": { pending: 0, reading: 0, done: 3, failed: 14, waitingReason: null },
      },
    );
    expect(status.stalled).toBe(false);
    expect(status.pagesFailed).toBe(0);
  });

  it("stalls without failures when pages were never queued at all", () => {
    // Uploaded, never enqueued — a different fault with the same symptom, and
    // the wording has to stop short of blaming a failure that did not happen.
    const status = flyerStatus([flyer({ pagesRead: 3 })], DURING, {
      "maxi-2026-08-13": { pending: 0, reading: 0, done: 3, failed: 0, waitingReason: null },
    });
    expect(status.stalled).toBe(true);
    expect(status.pagesFailed).toBe(0);
    expect(status.detail).toMatch(/never queued/);
  });
});

describe("waiting on something outside the queue", () => {
  it("reports why a queued page is going nowhere", () => {
    // The quota case: pages are queued and correctly untouched, so nothing is
    // stalled — but nothing is going to move tonight either.
    const status = flyerStatus([flyer({ pagesRead: 16 })], DURING, {
      "maxi-2026-08-13": {
        pending: 1,
        reading: 0,
        done: 16,
        failed: 0,
        waitingReason: "This API key has used its quota for the DAY.",
      },
    });
    expect(status.stalled).toBe(false);
    expect(status.waitingReason).toMatch(/quota for the DAY/);
  });

  it("says nothing when the queue is moving cleanly", () => {
    const status = flyerStatus([flyer({ pagesRead: 5 })], DURING, {
      "maxi-2026-08-13": { pending: 12, reading: 0, done: 5, failed: 0, waitingReason: null },
    });
    expect(status.waitingReason).toBeNull();
  });
});

describe("today, as a fixed point to check the window against", () => {
  // The app filters to flyers covering today, so a shopper could take
  // "loaded" on trust. Printing the date makes it checkable instead — and the
  // window is the one thing on that card which goes stale on its own while
  // nobody touches the app.

  it("reports today and how much of the window is left", () => {
    const status = flyerStatus([flyer()], DURING);
    expect(status.today).toBe("Aug 15");
    // Aug 15 through Aug 19, counting today.
    expect(status.daysLeft).toBe(5);
  });

  it("counts the last day as one, not zero", () => {
    // Today is still a shopping day. Zero would read as expired.
    const status = flyerStatus([flyer()], new Date("2026-08-19T12:00:00Z"));
    expect(status.daysLeft).toBe(1);
  });

  it("counts the first day as the whole window", () => {
    const status = flyerStatus([flyer()], new Date("2026-08-13T12:00:00Z"));
    expect(status.daysLeft).toBe(7);
  });

  it("still names today when nothing covers it", () => {
    // The Thursday-morning case. "Nothing covers today" is more useful beside
    // the date it is talking about.
    const status = flyerStatus([flyer()], AFTER);
    expect(status.readiness).toBe("NONE");
    expect(status.today).toBe("Aug 21");
    expect(status.daysLeft).toBe(0);
  });

  it("reads a date near midnight as the day it is, not the day before", () => {
    // Noon UTC throughout, so a late-evening scan in Montreal does not shift
    // the window by a day.
    expect(flyerStatus([flyer()], new Date("2026-08-15T03:30:00Z")).today).toBe(
      "Aug 15",
    );
  });
});
