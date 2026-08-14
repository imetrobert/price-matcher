/**
 * How much of the day's allowance each caller may spend.
 *
 * ---------------------------------------------------------------------------
 * WHY A RESERVATION, AND WHY IT IS ASYMMETRIC
 * ---------------------------------------------------------------------------
 * The worker and the scan draw on one chain of models, and the free tier
 * counts per model: twenty a day for a full flash model, five hundred for a
 * Lite one. A Thursday import walking down from 3.7-flash can therefore spend
 * every full model's twenty before a shopper standing in a shop asks for one
 * photograph to be read.
 *
 * The two failures are not comparable. An import that waits an hour is nothing
 * at all — the queue survives, the pages keep their attempts, the offers land
 * before anybody needs them. A scan that fails is a person stuck at a shelf
 * with a trolley, and no amount of retry logic fixes standing there.
 *
 * So the worker stops short and the scan does not. The numbers below are the
 * whole of that policy.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LIMITS ARE CONSTANTS AND NOT LOOKED UP
 * ---------------------------------------------------------------------------
 * Google publishes them on the project's rate-limit page and does not offer
 * them through the API. These were read off that page: 20 RPD on every full
 * flash model, 500 on the Lite ones. If a plan changes, this file is where it
 * changes — and until then a wrong constant fails safe, because it only ever
 * makes the worker hold back sooner than it needed to.
 */

/** Requests per day, per model, on the free tier. */
export const DAILY_LIMIT_FULL = 20;
export const DAILY_LIMIT_LITE = 500;

/**
 * What the worker leaves untouched on each model.
 *
 * Five is enough for a scan and a retry on a full model — a cart photograph is
 * one request — and small enough that a week of flyers still fits: fifteen
 * usable requests across five full models is seventy-five, batched three pages
 * to a request, against a week of about seventy pages.
 */
export const SCAN_RESERVE_FULL = 5;
export const SCAN_RESERVE_LITE = 50;

export function isLite(model: string): boolean {
  return model.toLowerCase().includes("lite");
}

export function dailyLimit(model: string): number {
  return isLite(model) ? DAILY_LIMIT_LITE : DAILY_LIMIT_FULL;
}

/** The most requests the worker may spend on this model today. */
export function workerCeiling(model: string): number {
  return dailyLimit(model) - (isLite(model) ? SCAN_RESERVE_LITE : SCAN_RESERVE_FULL);
}

/**
 * Which models the worker may still use, given what has been spent.
 *
 * `used` counts what THIS APP sent. Google counts everything the project sent,
 * and the key may serve other things, so this is a floor on usage rather than
 * the truth. That asymmetry is safe in this direction: an undercount makes the
 * worker try a model that then refuses, which the existing 429 handling
 * already survives without costing the page an attempt. An overcount would
 * make it hold back for nothing, which is why nothing here rounds up.
 */
export function affordableModels(
  models: string[],
  used: Record<string, number>,
): string[] {
  return models.filter((m) => (used[m] ?? 0) < workerCeiling(m));
}
