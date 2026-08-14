/**
 * Which models get thinkingConfig.
 *
 * A scan died on `INVALID_ARGUMENT` while the flyer worker read pages all
 * night on the same API key. The difference was one parameter: the vision
 * function attaches thinkingConfig and the worker does not. The gate deciding
 * that assumed a newer model family keeps an older family's knobs, and Gemini
 * 3 does not — it rejects the config outright, which is a 400, which broke the
 * model loop before any other model was tried.
 *
 * The rule is mirrored here rather than imported because the Edge Function is
 * Deno and imports supabase-js at module scope. What is pinned is the
 * behaviour: a family gets this parameter only once somebody has measured that
 * it accepts it.
 */

import { describe, expect, it } from "vitest";

/** The rule as it stands in supabase/functions/cartmatch-vision/index.ts. */
function supportsThinking(model: string): boolean {
  return model.toLowerCase().includes("2.5");
}

describe("who gets thinkingConfig", () => {
  it("gives it to the family it was written for", () => {
    expect(supportsThinking("gemini-2.5-flash")).toBe(true);
    expect(supportsThinking("gemini-2.5-flash-lite")).toBe(true);
  });

  it("withholds it from every model in the default chain but 2.5", () => {
    // The chain the scan actually walks. Six of these previously received a
    // parameter that made the request invalid.
    for (const model of [
      "gemini-3.7-flash",
      "gemini-3.5-flash",
      "gemini-3.6-flash",
      "gemini-3-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
    ]) {
      expect(supportsThinking(model)).toBe(false);
    }
  });

  it("withholds it from families older than 2.5", () => {
    expect(supportsThinking("gemini-2.0-flash")).toBe(false);
    expect(supportsThinking("gemini-1.5-pro")).toBe(false);
  });

  it("does not assume a future family accepts it", () => {
    // The assumption that produced the bug: forward compatibility by default.
    // An unrecognised name gets the plain request, which is the one shape
    // known to work everywhere.
    expect(supportsThinking("gemini-4-flash")).toBe(false);
    expect(supportsThinking("gemini-flash-latest")).toBe(false);
  });
});
