/**
 * The rules around stored flyers — the parts that are pure and therefore
 * pinnable without a database.
 */

import { describe, expect, it } from "vitest";

import {
  PAGE_GRACE_DAYS,
  flyerId,
  pagePath,
  pagesStillNeeded,
  type StoredFlyer,
} from "@/services/flyers/storage";

const flyer: StoredFlyer = {
  id: "iga-2026-08-13",
  retailerId: "iga",
  validFrom: "2026-08-13",
  validTo: "2026-08-19",
  pageCount: 16,
  pagesRead: 16,
  sourceFilename: "PDF_wk33-2026-SA V0.pdf",
  validitySource: "COVER",
};

describe("a flyer's identity", () => {
  it("is derived from the retailer and the week, not generated", () => {
    // So a re-import corrects the same rows instead of doubling every offer.
    // A duplicate offer is a second chance to show a stale price after the
    // first has been fixed.
    expect(flyerId("iga", "2026-08-13")).toBe("iga-2026-08-13");
    expect(flyerId("iga", "2026-08-13")).toBe(flyerId("iga", "2026-08-13"));
  });

  it("separates two retailers running the same week", () => {
    expect(flyerId("maxi", "2026-08-13")).not.toBe(flyerId("iga", "2026-08-13"));
  });
});

describe("where a page is stored", () => {
  it("puts the owner's id first, which is what the storage policy checks", () => {
    expect(pagePath("user-1", "iga-2026-08-13", 7)).toBe(
      "user-1/iga-2026-08-13/p07.jpg",
    );
  });

  it("pads the page number so pages sort in reading order", () => {
    const paths = [1, 2, 10, 16].map((n) => pagePath("u", "f", n));
    expect([...paths].sort()).toEqual(paths);
  });
});

describe("how long a page image is kept", () => {
  it("keeps it while the flyer runs", () => {
    expect(pagesStillNeeded(flyer, new Date("2026-08-15T12:00:00Z"))).toBe(true);
  });

  it("keeps it for a few days after, because a price match can lag the week", () => {
    expect(pagesStillNeeded(flyer, new Date("2026-08-21T12:00:00Z"))).toBe(true);
  });

  it("drops it once the grace period has passed", () => {
    // The prices stay for six months as history; the pictures do not. A page
    // image is evidence for a claim that has expired.
    const after = new Date("2026-08-19T00:00:00Z");
    after.setUTCDate(after.getUTCDate() + PAGE_GRACE_DAYS + 1);
    expect(pagesStillNeeded(flyer, after)).toBe(false);
  });
});
