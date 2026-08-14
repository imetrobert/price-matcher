/**
 * How much of the day's allowance each caller may spend.
 *
 * The worker and the scan draw on one chain, and the free tier counts per
 * model. A Thursday import walking down from 3.7-flash can spend every full
 * model's twenty before a shopper standing in a shop asks for one photograph
 * to be read.
 *
 * The two failures are not comparable, and that asymmetry is the whole policy:
 * an import that waits an hour costs nothing, and a scan that fails is a
 * person stuck at a shelf with a trolley.
 */

import { describe, expect, it } from "vitest";

import {
  DAILY_LIMIT_FULL,
  DAILY_LIMIT_LITE,
  affordableModels,
  dailyLimit,
  workerCeiling,
} from "@shared/budget";

describe("the allowances, as measured from the rate-limit page", () => {
  it("gives a full flash model twenty a day", () => {
    expect(dailyLimit("gemini-3.7-flash")).toBe(DAILY_LIMIT_FULL);
    expect(dailyLimit("gemini-2.5-flash")).toBe(20);
  });

  it("gives a Lite model five hundred", () => {
    expect(dailyLimit("gemini-3.5-flash-lite")).toBe(DAILY_LIMIT_LITE);
    expect(dailyLimit("gemini-3.1-flash-lite")).toBe(500);
  });
});

describe("what the worker holds back", () => {
  it("leaves room on a full model for a scan and a retry", () => {
    expect(workerCeiling("gemini-3.7-flash")).toBe(15);
  });

  it("leaves proportionally more on a Lite model, which has it to spare", () => {
    expect(workerCeiling("gemini-3.5-flash-lite")).toBe(450);
  });

  it("still fits a week of flyers inside what it may spend", () => {
    // Five full models at fifteen usable is seventy-five requests; batched
    // three pages to a request that is 225 pages, against a week of about
    // seventy. The reservation must not make the app unable to do its job.
    const full = [
      "gemini-3.7-flash",
      "gemini-3.5-flash",
      "gemini-3.6-flash",
      "gemini-3-flash",
      "gemini-2.5-flash",
    ];
    const usable = full.reduce((sum, m) => sum + workerCeiling(m), 0);
    expect(usable * 3).toBeGreaterThan(70);
  });
});

describe("choosing what the worker may still use", () => {
  it("drops a model that has reached its ceiling", () => {
    const models = ["gemini-3.7-flash", "gemini-3.5-flash"];
    expect(affordableModels(models, { "gemini-3.7-flash": 15 })).toEqual([
      "gemini-3.5-flash",
    ]);
  });

  it("keeps a model one request short of its ceiling", () => {
    expect(
      affordableModels(["gemini-3.7-flash"], { "gemini-3.7-flash": 14 }),
    ).toEqual(["gemini-3.7-flash"]);
  });

  it("treats an unrecorded model as unspent", () => {
    // The counter records what this app sent. A model it has never sent to
    // has no row, and an absent row is zero rather than unknown.
    expect(affordableModels(["gemini-3.6-flash"], {})).toEqual([
      "gemini-3.6-flash",
    ]);
  });

  it("returns nothing when every model is spent, rather than the first", () => {
    // The caller reads an empty list as "hold this tick". Falling back to the
    // first model would spend exactly the requests being reserved.
    const models = ["gemini-3.7-flash", "gemini-3.5-flash"];
    const spent = { "gemini-3.7-flash": 20, "gemini-3.5-flash": 99 };
    expect(affordableModels(models, spent)).toEqual([]);
  });

  it("keeps Lite available long after the full models are done", () => {
    const models = ["gemini-3.7-flash", "gemini-3.5-flash-lite"];
    const spent = { "gemini-3.7-flash": 20, "gemini-3.5-flash-lite": 100 };
    expect(affordableModels(models, spent)).toEqual(["gemini-3.5-flash-lite"]);
  });
});
