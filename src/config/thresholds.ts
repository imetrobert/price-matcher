/**
 * All tunable numeric policy lives here so it can be reviewed in one place
 * and changed without hunting through the codebase.
 */

import type { Cents, MatchTier } from "@/types";

export const MATCH_THRESHOLDS = {
  /** score >= exactMatch  -> EXACT_MATCH */
  exactMatch: 95,
  /** score >= highConfidence -> HIGH_CONFIDENCE */
  highConfidence: 90,
  /** score >= reviewRequired -> REVIEW_REQUIRED (never auto-shown as a match) */
  reviewRequired: 75,
} as const;

export function tierForScore(score: number): MatchTier {
  if (score >= MATCH_THRESHOLDS.exactMatch) return "EXACT_MATCH";
  if (score >= MATCH_THRESHOLDS.highConfidence) return "HIGH_CONFIDENCE";
  if (score >= MATCH_THRESHOLDS.reviewRequired) return "REVIEW_REQUIRED";
  return "REJECTED";
}

/** Only these tiers may ever back a checkout-proof claim. */
export const CHECKOUT_ELIGIBLE_TIERS: MatchTier[] = [
  "EXACT_MATCH",
  "HIGH_CONFIDENCE",
];

export const FRESHNESS_HOURS = {
  fresh: 24,
  acceptable: 48,
} as const;

/** Retailer-specific overrides, e.g. banners that refresh weekly. */
export const RETAILER_FRESHNESS_OVERRIDES: Record<
  string,
  { fresh: number; acceptable: number }
> = {
  // Intentionally empty until measured against live data.
};

export const SAVINGS = {
  defaultThresholdCents: 50 as Cents,
  presetsCents: [25, 50, 100, 200] as Cents[],
} as const;

export const PRICE_CONFIDENCE = {
  /** Below this, a price is never shown as a verified competitor price. */
  minimumForDisplay: 0.7,
  /** Below this, a price is never checkout-ready. */
  minimumForCheckoutProof: 0.85,
} as const;

export const VISION = {
  /** Detections below this are shown to the user pre-flagged for confirmation. */
  autoAcceptConfidence: 0.9,
  /** Below this we ask rather than assume. */
  minimumUsableConfidence: 0.35,
} as const;

/** Montreal-region gate. MVP scope is deliberately narrow. */
export const REGION = {
  name: "Montreal",
  /** Forward sortation area first letters covering the Montreal region. */
  allowedFsaPrefixes: ["H"],
  label: "Montreal-area",
} as const;
