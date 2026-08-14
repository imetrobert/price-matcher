/**
 * The list of models to try, which is really a list of daily allowances.
 *
 * On the free tier the counter is per model — 20 a day for a full flash model,
 * 500 for a Lite one — so a chain is a sum rather than a fallback list. It was
 * two different lists for a while: the worker had seven names and the scan had
 * three, of which the last was an alias resolving back to the first. A shopper
 * standing in a shop was told the day was over after effectively two pools
 * while the scheduled worker still had five untouched.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL_CHAIN, modelChain } from "@shared/models";

describe("the default chain", () => {
  it("puts the full models before the Lite ones", () => {
    const names = DEFAULT_MODEL_CHAIN.split(",");
    const firstLite = names.findIndex((n) => n.includes("lite"));
    const lastFull = names.reduce(
      (last, n, i) => (n.includes("lite") ? last : i),
      -1,
    );
    expect(firstLite).toBeGreaterThan(lastFull);
  });

  it("carries at least one Lite model, which is where the headroom is", () => {
    // 500 a day against 20. Without one of these a week of flyers does not
    // fit, and a scan competes with the worker for the same small pools.
    expect(DEFAULT_MODEL_CHAIN).toMatch(/lite/);
  });

  it("names no aliases", () => {
    // An alias resolves to a concrete model already in this list, so trying it
    // spends an attempt to arrive back at a pool exhausted a moment ago.
    expect(DEFAULT_MODEL_CHAIN).not.toMatch(/latest/);
  });

  it("has no duplicates", () => {
    const names = DEFAULT_MODEL_CHAIN.split(",");
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("reading the configured chain", () => {
  it("falls back to the default when nothing is set", () => {
    expect(modelChain(undefined)).toEqual(DEFAULT_MODEL_CHAIN.split(","));
  });

  it("trims and drops blanks, so a trailing comma is harmless", () => {
    expect(modelChain("a, b ,, c,")).toEqual(["a", "b", "c"]);
  });

  it("takes a single name", () => {
    expect(modelChain("gemini-3.7-flash")).toEqual(["gemini-3.7-flash"]);
  });
});
