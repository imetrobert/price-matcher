/**
 * Flyer weeks in Montreal.
 *
 * The tests that matter here are the refusals: every one of them is a way a
 * scheduled job could quietly import last week's prices as this week's.
 */

import { describe, expect, it } from "vitest";

import {
  acceptDownloadedFlyer,
  flyerWeekStart,
  isFlyerDay,
  montrealDate,
  shouldAttemptImport,
} from "@/services/flyers/schedule";

/** 2026-08-13 is a Thursday; 2026-08-20 the next one. */
const THURSDAY_MORNING = new Date("2026-08-13T13:00:00Z"); // 09:00 in Montreal
const SATURDAY = new Date("2026-08-15T16:00:00Z");
const NEXT_WEDNESDAY = new Date("2026-08-19T16:00:00Z");

describe("the Montreal calendar, not the UTC one", () => {
  it("reads the local date, not the UTC date", () => {
    // 01:30 UTC Friday is still Thursday evening in Montreal.
    expect(montrealDate(new Date("2026-08-14T01:30:00Z"))).toEqual({
      date: "2026-08-13",
      weekday: 4,
    });
  });

  it("puts a late-Wednesday-UTC instant in the week that has not started yet", () => {
    // 23:00 UTC Wednesday = 19:00 Montreal Wednesday: still last week's flyer.
    expect(flyerWeekStart(new Date("2026-08-12T23:00:00Z"))).toBe("2026-08-06");
  });

  it("anchors every day of the flyer week to its Thursday", () => {
    expect(flyerWeekStart(THURSDAY_MORNING)).toBe("2026-08-13");
    expect(flyerWeekStart(SATURDAY)).toBe("2026-08-13");
    expect(flyerWeekStart(NEXT_WEDNESDAY)).toBe("2026-08-13");
  });

  it("survives the daylight-saving changeover", () => {
    // DST ends 2026-11-01. The Thursdays either side must still be Thursdays.
    expect(flyerWeekStart(new Date("2026-10-29T12:00:00Z"))).toBe("2026-10-29");
    expect(flyerWeekStart(new Date("2026-11-05T12:00:00Z"))).toBe("2026-11-05");
  });

  it("knows which day is flyer day", () => {
    expect(isFlyerDay(THURSDAY_MORNING)).toBe(true);
    expect(isFlyerDay(SATURDAY)).toBe(false);
  });
});

describe("deciding whether to look", () => {
  it("looks on any day when nothing is held", () => {
    expect(shouldAttemptImport({ validity: null }, SATURDAY).attempt).toBe(true);
  });

  it("looks on any day when what we hold has run out", () => {
    const decision = shouldAttemptImport(
      { validity: { startsAt: "2026-08-06", endsAt: "2026-08-12" } },
      SATURDAY,
    );
    expect(decision.attempt).toBe(true);
    expect(decision.reason).toContain("nothing covers today");
  });

  it("leaves a current flyer alone mid-week", () => {
    const decision = shouldAttemptImport(
      { validity: { startsAt: "2026-08-13", endsAt: "2026-08-19" } },
      SATURDAY,
    );
    expect(decision.attempt).toBe(false);
  });

  it("looks on Thursday when what we hold is last week's", () => {
    const decision = shouldAttemptImport(
      { validity: { startsAt: "2026-08-06", endsAt: "2026-08-19" } },
      THURSDAY_MORNING,
    );
    expect(decision.attempt).toBe(true);
    expect(decision.reason).toContain("changeover");
  });

  it("stops asking once this week's flyer is in hand", () => {
    const decision = shouldAttemptImport(
      { validity: { startsAt: "2026-08-13", endsAt: "2026-08-19" } },
      THURSDAY_MORNING,
    );
    expect(decision.attempt).toBe(false);
    expect(decision.reason).toContain("2026-08-13");
  });
});

describe("deciding whether what came back is new", () => {
  const heldLastWeek = {
    validity: { startsAt: "2026-08-06", endsAt: "2026-08-12" },
  };

  it("accepts a flyer whose dates have moved on", () => {
    const result = acceptDownloadedFlyer(
      heldLastWeek,
      { startsAt: "2026-08-13", endsAt: "2026-08-19" },
      THURSDAY_MORNING,
    );
    expect(result.accept).toBe(true);
  });

  it("refuses a Thursday fetch that returned the same flyer again", () => {
    // Runs through Thursday, so it is not expired — the only thing wrong with
    // it is that it is the flyer we already have.
    const held = { validity: { startsAt: "2026-08-06", endsAt: "2026-08-13" } };
    const result = acceptDownloadedFlyer(
      held,
      { startsAt: "2026-08-06", endsAt: "2026-08-13" },
      THURSDAY_MORNING,
    );
    expect(result.accept).toBe(false);
    expect(result.reason).toContain("not switched yet");
  });

  it("refuses a stale cached flyer whose window has closed", () => {
    const result = acceptDownloadedFlyer(
      { validity: null },
      { startsAt: "2026-07-30", endsAt: "2026-08-05" },
      THURSDAY_MORNING,
    );
    expect(result.accept).toBe(false);
    expect(result.reason).toContain("cached page");
  });

  it("refuses a flyer that prints no end date, however new it looks", () => {
    const result = acceptDownloadedFlyer(
      heldLastWeek,
      { startsAt: "2026-08-13", endsAt: null },
      THURSDAY_MORNING,
    );
    expect(result.accept).toBe(false);
    expect(result.reason).toContain("never be shown");
  });

  it("accepts a flyer that is dated ahead of today", () => {
    // Some retailers publish Thursday's flyer late Wednesday. That is genuinely
    // next week's, and holding it is correct — freshness keeps it out of
    // results until its window opens.
    const result = acceptDownloadedFlyer(
      heldLastWeek,
      { startsAt: "2026-08-13", endsAt: "2026-08-19" },
      new Date("2026-08-12T23:00:00Z"),
    );
    expect(result.accept).toBe(true);
  });
});
