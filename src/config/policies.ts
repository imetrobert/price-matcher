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

import { RETAILERS } from "@/config/retailers";
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

/**
 * Derived from the registry rather than listed again.
 *
 * Every entry was `unknownPolicy(id)` — the same value, written out once per
 * banner, so the list existed only to be forgotten when a banner was added.
 * It was: adding Adonis produced a type error here, in a file that has nothing
 * to say about Adonis.
 *
 * A published price-match policy, when one is ever recorded, replaces the
 * entry for that banner. Until then the honest value is the same for
 * everybody, and deriving it means a new banner is one edit fewer.
 */
export const RETAILER_POLICIES: Record<RetailerId, RetailerPolicy> =
  Object.fromEntries(
    (Object.keys(RETAILERS) as RetailerId[]).map((id) => [id, unknownPolicy(id)]),
  ) as Record<RetailerId, RetailerPolicy>;

export function getPolicy(id: RetailerId): RetailerPolicy {
  return RETAILER_POLICIES[id] ?? unknownPolicy(id);
}

/** A policy is only usable if a human verified it against a published source. */
export function policyIsVerified(policy: RetailerPolicy): boolean {
  return policy.sourceUrl !== "" && policy.lastReviewed !== "";
}
