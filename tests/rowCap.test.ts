/**
 * Fetching every matching row, when the server will only hand over some.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS PINS
 * ---------------------------------------------------------------------------
 * PostgREST caps a response at `max-rows` — 1000 by default — and says nothing
 * when it truncates. A week with six flyers crossed that line and one entire
 * store disappeared from the comparison screen: not flagged as missing, not
 * shown with zero offers, simply absent, with the totals adding to exactly
 * 1000. The store that vanished was the one whose rows sorted last, which is
 * why the freshly re-imported flyer was the casualty.
 *
 * Every case below is a way that silent truncation could come back.
 */

import { describe, expect, it } from "vitest";

import { fetchAllRows } from "@/services/flyers/storage";

/**
 * A server holding `total` rows that will never return more than `cap` at once.
 * Records each requested window so the test can check how it was asked.
 */
function server(total: number, cap = 1000) {
  const asked: [number, number][] = [];
  const slice = async (from: number, to: number) => {
    asked.push([from, to]);
    const width = Math.min(to - from + 1, cap);
    const rows = [];
    for (let i = from; i < Math.min(from + width, total); i++) {
      rows.push({ id: `row-${String(i).padStart(6, "0")}` });
    }
    return { data: rows, error: null };
  };
  return { slice, asked };
}

describe("fetching past the server's row cap", () => {
  it("returns every row when there are more than one response can hold", async () => {
    const { slice } = server(1200);
    const result = await fetchAllRows(slice);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1200);
    // No row fetched twice, none skipped: the count alone would not catch a
    // page that repeated one row and dropped another.
    expect(new Set(result.rows.map((r) => r.id)).size).toBe(1200);
  });

  it("gets the whole answer even when the cap is smaller than our slice", async () => {
    // The failure mode of assuming the server's limit: ask for 500, get 200
    // back because somebody lowered max-rows, conclude that was the end.
    const { slice } = server(1200, 200);
    const result = await fetchAllRows(slice);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1200);
  });

  it("advances by what actually arrived, never by what was asked for", async () => {
    const { slice, asked } = server(1200, 200);
    await fetchAllRows(slice);

    // Each window starts where the last one really ended.
    expect(asked[0]![0]).toBe(0);
    expect(asked[1]![0]).toBe(200);
    expect(asked[2]![0]).toBe(400);
  });

  it("handles a total that lands exactly on the cap", async () => {
    // The case that caused this: 1000 rows matched, 1000 returned, and there
    // is no way to tell from the response whether a 1001st exists.
    const { slice } = server(1000, 1000);
    const result = await fetchAllRows(slice);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1000);
  });

  it("asks once more than strictly necessary, on purpose", async () => {
    const { slice, asked } = server(300, 1000);
    await fetchAllRows(slice);
    // 300 came back for a 500-wide window. That is probably the end — but
    // "probably" is what truncated the comparison, so it asks and gets zero.
    expect(asked).toHaveLength(2);
  });

  it("reports an empty table as empty rather than as a failure", async () => {
    const { slice } = server(0);
    const result = await fetchAllRows(slice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([]);
  });

  it("passes a query error back instead of returning a short answer", async () => {
    const result = await fetchAllRows(async () => ({
      data: null,
      error: { message: "permission denied for table cartmatch_flyer_offers" },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("permission denied");
  });

  it("fails loudly rather than truncating when the data is absurdly large", async () => {
    // A guard against looping forever. It must not quietly hand back the
    // partial answer, which is the very behaviour being fixed.
    const { slice } = server(200_000, 1000);
    const result = await fetchAllRows(slice);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/rows matched/);
  });
});
