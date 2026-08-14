/**
 * Which quota ran out, and what its ceiling was.
 *
 * The second half is why this file exists. "You are over quota" cannot answer
 * whether a week of flyers — about seventy page reads — fits inside a plan.
 * Google states the number; the app kept throwing it away by slicing the head
 * off a body whose specifics are at the end.
 */

import { describe, expect, it } from "vitest";

import { quotaMessage } from "@shared/quota";

/** A 429 shaped the way the API documents it. */
function body(quotaId: string, quotaValue: string, model = "gemini-flash-latest") {
  return `Gemini 429 on ${model}: ${JSON.stringify({
    error: {
      code: 429,
      message:
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            {
              quotaMetric:
                "generativelanguage.googleapis.com/generate_content_free_tier_requests",
              quotaId,
              quotaDimensions: { model, location: "global" },
              quotaValue,
            },
          ],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "27s" },
      ],
    },
  })}`;
}

describe("naming the window", () => {
  it("tells a day apart from a minute, because the answers differ", () => {
    // One means come back tomorrow; the other means wait sixty seconds.
    const daily = quotaMessage(
      body("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "250"),
    );
    expect(daily).toMatch(/for the DAY/);

    const minute = quotaMessage(
      body("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "10"),
    );
    expect(minute).toMatch(/per-minute/);
    expect(minute).not.toMatch(/for the DAY/);
  });

  it("reads the window from the quota id, not the prose", () => {
    // Google's human-readable message names neither window. The id always
    // does, which is why it is preferred.
    const message = quotaMessage(
      body("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "250"),
    );
    expect(message).toMatch(/for the DAY/);
  });
});

describe("reporting the ceiling", () => {
  it("states the number, which is the part that decides feasibility", () => {
    const message = quotaMessage(
      body("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "250"),
    );
    expect(message).toMatch(/limit is 250 per day/);
    expect(message).toMatch(/gemini-flash-latest/);
  });

  it("survives the body arriving without a violation block", () => {
    const message = quotaMessage("Gemini 429: rate limited, try later");
    expect(message).toMatch(/over its quota/);
    // No number invented where Google supplied none.
    expect(message).not.toMatch(/limit is/);
  });

  it("keeps the tail rather than the head when the body will not parse", () => {
    // The head of a quota body is boilerplate; anything specific is at the
    // end, which is exactly what a leading slice discarded.
    const long = `Gemini 429: ${"boilerplate ".repeat(60)}exhausted on project 12345`;
    expect(quotaMessage(long)).toMatch(/exhausted on project 12345/);
  });
});
