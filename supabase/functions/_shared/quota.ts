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

/**
 * The limit that was hit, in numbers, when Google supplies them.
 *
 * A 429 body carries a QuotaFailure detail naming the metric and the ceiling:
 *
 *   quotaId:    GenerateRequestsPerDayPerProjectPerModel-FreeTier
 *   quotaValue: 250
 *
 * That pair is the only thing that answers "is this workload feasible on this
 * plan?", and reading the head of the blob threw it away — the human-readable
 * message comes first and the violations come last, so a 300-character slice
 * kept the prose and dropped the numbers. Whether a week of flyers fits was
 * then unanswerable from anything the app had stored.
 */
interface QuotaViolation {
  id: string;
  value: string | null;
  model: string | null;
}

function readViolation(detail: string): QuotaViolation | null {
  const start = detail.indexOf("{");
  if (start < 0) return null;
  try {
    const body = JSON.parse(detail.slice(start));
    const details = body?.error?.details;
    if (!Array.isArray(details)) return null;
    for (const entry of details) {
      const violations = entry?.violations;
      if (!Array.isArray(violations)) continue;
      for (const v of violations) {
        const id = v?.quotaId ?? v?.quotaMetric;
        if (typeof id !== "string") continue;
        return {
          id,
          value: v?.quotaValue != null ? String(v.quotaValue) : null,
          model:
            typeof v?.quotaDimensions?.model === "string"
              ? v.quotaDimensions.model
              : null,
        };
      }
    }
  } catch {
    // Not JSON, or not shaped as documented. The wording below still works
    // off the raw text.
  }
  return null;
}

export function quotaMessage(detail: string): string {
  const violation = readViolation(detail);

  // Prefer the quota's own id: it names the window unambiguously, where the
  // prose does not always.
  const named = violation?.id ?? detail;
  const perDay = /per\s?day/i.test(named);
  const perMinute = /per\s?minute/i.test(named);

  // "250 requests per day on gemini-flash-latest" — the sentence that decides
  // whether this plan can carry a week of flyers.
  const ceiling = violation?.value
    ? ` The limit is ${violation.value}${
        perDay ? " per day" : perMinute ? " per minute" : ""
      }${violation.model ? ` on ${violation.model}` : ""}.`
    : "";

  if (perDay && !perMinute) {
    return `This API key has used its quota for the DAY. Waiting will not help until it resets — use a different key, or come back tomorrow.${ceiling}`;
  }
  if (perMinute && !perDay) {
    return `This API key's per-minute quota is used up. It refills within a minute.${ceiling}`;
  }

  // Neither window named. Report the violation if there was one, and the tail
  // of Google's text otherwise — the tail, because that is where a body that
  // did not parse still tends to carry the specifics.
  if (violation) {
    return `This API key is over its ${violation.id} quota.${ceiling}`;
  }
  const quoted = detail.replace(/\s+/g, " ");
  return `This API key is over its quota. Google said: ${quoted.slice(-220)}`;
}
