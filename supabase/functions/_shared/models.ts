/**
 * Which models to try, in order, and why this list is shared.
 *
 * ---------------------------------------------------------------------------
 * THE ALLOWANCE IS PER MODEL, SO THE CHAIN IS A SUM
 * ---------------------------------------------------------------------------
 * Measured from the project's own rate-limit page rather than assumed. On the
 * free tier every full flash model carries 20 requests per day — 3.7, 3.5,
 * 3.6, 3 and 2.5 alike — and the Lite models carry 500. Because the counter is
 * per model, a chain is not merely a fallback list: five full models are a
 * hundred requests a day between them before Lite is touched at all.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT TWO LISTS
 * ---------------------------------------------------------------------------
 * It was. The worker got the long chain and the vision function kept an older
 * one — three names, of which the last was an alias resolving back to the
 * first. So a shopper standing in a shop was told the day's quota was gone
 * after three attempts against what were effectively two pools, while the
 * scheduled worker had seven to draw on. The same list, in one place, is the
 * only way that stays true.
 *
 * ---------------------------------------------------------------------------
 * WHY LITE IS LAST AND NOT ABSENT
 * ---------------------------------------------------------------------------
 * Twenty-five times the allowance and less of everything else. Measured on
 * real flyer pages it held up — fifteen Lite pages of one flyer averaged 17.6
 * offers against 16.4 for a full model on another — but those were different
 * flyers, so that is encouraging rather than conclusive. Last, therefore:
 * reaching it means the good pools are spent, and a page read by a weaker
 * model beats a page not read at all.
 *
 * No aliases. `gemini-flash-latest` and its kind resolve to a concrete model
 * that is probably already in this list, which spends an attempt to arrive
 * back at a pool that was exhausted a moment ago.
 */
export const DEFAULT_MODEL_CHAIN = [
  "gemini-3.7-flash",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3-flash",
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
].join(",");

/** The configured chain, or the default. Blank entries are dropped. */
export function modelChain(configured: string | undefined): string[] {
  return (configured ?? DEFAULT_MODEL_CHAIN)
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m !== "");
}
