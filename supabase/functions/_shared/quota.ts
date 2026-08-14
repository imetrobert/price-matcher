/**
 * Say WHICH quota ran out, in Google's own words.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SHARED RATHER THAN COPIED
 * ---------------------------------------------------------------------------
 * A 429 is a per-minute cap or a per-day cap, and the difference decides
 * whether the answer is "wait a minute" or "come back tomorrow". Guessing
 * per-minute once sent somebody to retry a run that could not succeed again
 * until the following day.
 *
 * Both the browser-facing function and the scheduled worker have to make that
 * distinction, and they have to make it identically: the worker uses it to
 * decide whether a page keeps its attempts, and the vision function uses it to
 * decide what to tell a person who is waiting. Two copies of the rule would
 * eventually give one answer to the screen and a different one to the queue.
 *
 * Google names the metric in the error body — GenerateRequestsPerDayPerProject
 * or PerMinute — so this reads it rather than assuming.
 */

export function quotaMessage(detail: string): string {
  const perDay = /per\s?day/i.test(detail);
  const perMinute = /per\s?minute/i.test(detail);

  if (perDay && !perMinute) {
    return "This API key has used its quota for the DAY. Waiting will not help until it resets — use a different key, or come back tomorrow.";
  }
  if (perMinute && !perDay) {
    return "This API key's per-minute quota is used up. It refills within a minute.";
  }

  // Both named, or neither. Report what Google said rather than picking one.
  const quoted = detail.replace(/\s+/g, " ").slice(0, 220);
  return `This API key is over its quota. Google said: ${quoted}`;
}
