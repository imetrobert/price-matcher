/**
 * Retailer price-match policies.
 *
 * ---------------------------------------------------------------------------
 * HONESTY NOTE — WHY EVERY FIELD IS "UNKNOWN"
 * ---------------------------------------------------------------------------
 * The build spec forbids claiming a retailer policy exists without a source.
 * Retailer policy pages could not be reached from the development environment
 * (all six domains are refused by egress policy), so there is no source to
 * cite for any of them. Rather than encode plausible-sounding but unverified
 * policy — which would flow straight through to a claim shown to a cashier —
 * every policy below is UNKNOWN with an empty `sourceUrl`.
 *
 * Consequence, by design: `POTENTIAL_PRICE_MATCH` is never asserted on policy
 * grounds. The app tops out at "this competitor price is verified", which is
 * a claim about a web page we actually fetched, not a claim about what a
 * cashier will do. See src/services/policies/eligibility.ts.
 *
 * TO POPULATE: open the retailer's published policy page, fill the fields,
 * set `sourceUrl` to that page, and set `lastReviewed` to today's date.
 */

import type { RetailerId, RetailerPolicy } from "@/types";

const unknownPolicy = (retailerId: RetailerId): RetailerPolicy => ({
  retailerId,
  priceMatchSupported: "UNKNOWN",
  verifiedPriceProgram: "UNKNOWN",
  requiresExactProduct: "UNKNOWN",
  proofRequired: "UNKNOWN",
  localPromotionRules:
    "Not established. No published policy source has been reviewed for this retailer.",
  notes:
    "Policy not verified. The app will not assert price-match eligibility for this retailer.",
  sourceUrl: "",
  lastReviewed: "",
});

export const RETAILER_POLICIES: Record<RetailerId, RetailerPolicy> = {
  maxi: unknownPolicy("maxi"),
  superc: unknownPolicy("superc"),
  walmart: unknownPolicy("walmart"),
  metro: unknownPolicy("metro"),
  iga: unknownPolicy("iga"),
  provigo: unknownPolicy("provigo"),
  adonis: unknownPolicy("adonis"),
};

export function getPolicy(id: RetailerId): RetailerPolicy {
  return RETAILER_POLICIES[id] ?? unknownPolicy(id);
}

/** A policy is only usable if a human verified it against a published source. */
export function policyIsVerified(policy: RetailerPolicy): boolean {
  return policy.sourceUrl !== "" && policy.lastReviewed !== "";
}
