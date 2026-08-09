/**
 * The trust gate.
 *
 * Everything the user sees passes through this module. It answers one
 * question: given a match and two price observations, what may we honestly
 * claim? The three states the spec distinguishes are kept strictly separate:
 *
 *   CHEAPER_ELSEWHERE      — we have a verified competitor price that is lower.
 *   POTENTIAL_PRICE_MATCH  — the above, AND a verified retailer policy says a
 *                            match is possible. Requires a reviewed policy
 *                            source; currently unreachable (see config/policies).
 *   CHECKOUT_READY_PROOF   — the above, plus a direct product URL, a fresh
 *                            price, confirmed availability and an exact match.
 *
 * A row can only ever move DOWN this ladder as gates fail. Nothing in the app
 * upgrades a claim.
 */

import { PRICE_CONFIDENCE } from "@/config/thresholds";
import { getPolicy, policyIsVerified } from "@/config/policies";
import { getRetailer } from "@/config/retailers";
import {
  classifyFreshness,
  describeFreshness,
  freshnessAllowsCheckout,
} from "@/services/pricing/freshness";
import type {
  Freshness,
  MatchResult,
  OpportunityState,
  PriceObservation,
  ProofPoint,
  SourceReliability,
} from "@/types";

export interface EligibilityInput {
  currentStore: PriceObservation;
  competitor: PriceObservation;
  match: MatchResult;
  now?: Date;
}

export interface EligibilityVerdict {
  state: OpportunityState;
  checkoutReady: boolean;
  proofPoints: ProofPoint[];
  competitorFreshness: Freshness;
  competitorReliability: SourceReliability;
  /** One-line explanation recorded in the audit trail. */
  reason: string;
  /** Reasons this row must not be shown at all, if any. */
  suppress: string[];
}

export function evaluateEligibility(
  input: EligibilityInput,
): EligibilityVerdict {
  const now = input.now ?? new Date();
  const { competitor, currentStore, match } = input;

  const proofPoints: ProofPoint[] = [];
  const suppress: string[] = [];

  // --- Gate 1: is it the same product? -----------------------------------
  const exact = match.eligibleForCheckoutProof;
  proofPoints.push({
    label: "Exact product match",
    passed: exact,
    detail: exact
      ? match.reasons[0] ?? `Match score ${match.score}/100`
      : match.blockers[0] ?? `Match score ${match.score}/100 — below the bar`,
  });
  if (match.tier === "REJECTED") {
    suppress.push(
      match.blockers[0] ?? "Products are not the same item.",
    );
  } else if (!exact) {
    suppress.push(
      `Match confidence ${match.score}/100 is not high enough to present as the same product.`,
    );
  }

  // --- Gate 2: freshness --------------------------------------------------
  const competitorFreshness = classifyFreshness(competitor, now);
  const freshOk = freshnessAllowsCheckout(competitorFreshness);
  proofPoints.push({
    label: "Price is current",
    passed: freshOk,
    detail: describeFreshness(competitor, now),
  });
  if (competitorFreshness === "EXPIRED") {
    suppress.push("The competitor's promotional price is no longer valid.");
  } else if (competitorFreshness === "STALE") {
    suppress.push("The competitor price is older than the freshness window.");
  }

  // --- Gate 3: availability ----------------------------------------------
  const availableOk = competitor.availability === "IN_STOCK";
  proofPoints.push({
    label: "Product available",
    passed: availableOk,
    detail: availabilityLabel(competitor),
  });
  if (competitor.availability === "OUT_OF_STOCK") {
    suppress.push("The product is out of stock at the competitor.");
  }

  // --- Gate 4: verifiable source -----------------------------------------
  const hasUrl = Boolean(competitor.productUrl);
  proofPoints.push({
    label: "Direct product page",
    passed: hasUrl,
    detail: hasUrl
      ? `${getRetailer(competitor.retailerId).displayName} product page`
      : "No verified product URL — cannot be shown to a cashier",
  });

  const reliability = classifyReliability(competitor, competitorFreshness);
  const confidenceOk =
    competitor.priceConfidence >= PRICE_CONFIDENCE.minimumForCheckoutProof;
  proofPoints.push({
    label: "Price verified at source",
    passed: reliability === "VERIFIED" && confidenceOk,
    detail: reliabilityDetail(competitor, reliability),
  });
  if (competitor.priceConfidence < PRICE_CONFIDENCE.minimumForDisplay) {
    suppress.push("Competitor price could not be verified with enough confidence.");
  }

  // --- Gate 5: mock data can never be a claim ----------------------------
  if (competitor.isMock || currentStore.isMock) {
    proofPoints.push({
      label: "Real retailer data",
      passed: false,
      detail: "MOCK FIXTURE — this figure was never observed at a retailer.",
    });
  }

  // --- Ladder -------------------------------------------------------------
  const cheaper = competitor.price < currentStore.price;
  if (!cheaper) {
    suppress.push("The competitor is not cheaper.");
  }

  const checkoutReady =
    cheaper &&
    exact &&
    freshOk &&
    availableOk &&
    hasUrl &&
    confidenceOk &&
    reliability === "VERIFIED" &&
    !competitor.isMock;

  let state: OpportunityState = "CHEAPER_ELSEWHERE";
  if (checkoutReady) {
    state = "CHECKOUT_READY_PROOF";
  } else {
    // Only claim a price-MATCH opportunity when the retailer's policy has
    // actually been reviewed against a published source. Today no policy is
    // verified, so this branch is unreachable by design rather than by accident.
    const policy = getPolicy(currentStore.retailerId);
    if (
      policyIsVerified(policy) &&
      policy.priceMatchSupported === true &&
      exact &&
      cheaper
    ) {
      state = "POTENTIAL_PRICE_MATCH";
    }
  }

  return {
    state,
    checkoutReady,
    proofPoints,
    competitorFreshness,
    competitorReliability: reliability,
    reason: buildReason(state, checkoutReady, suppress, competitor),
    suppress,
  };
}

/**
 * Source reliability per spec §34. Note that a MOCK_FIXTURE is always
 * UNVERIFIED regardless of how recent it is.
 */
export function classifyReliability(
  observation: PriceObservation,
  freshness: Freshness,
): SourceReliability {
  if (observation.isMock || observation.sourceType === "MOCK_FIXTURE") {
    return "UNVERIFIED";
  }
  if (observation.sourceType === "USER_ENTERED") {
    return "CONDITIONALLY_VERIFIED";
  }
  if (freshness === "STALE" || freshness === "EXPIRED") return "STALE";
  if (!observation.productUrl) return "UNVERIFIED";
  if (observation.priceConfidence < PRICE_CONFIDENCE.minimumForDisplay) {
    return "UNVERIFIED";
  }

  const pageBacked =
    observation.sourceType === "RETAILER_PRODUCT_PAGE" ||
    observation.sourceType === "RETAILER_API";

  if (!pageBacked) return "CONDITIONALLY_VERIFIED";

  // A regional/online price is real, but it is not a promise about the shelf.
  if (!observation.storeId) return "CONDITIONALLY_VERIFIED";

  return "VERIFIED";
}

function reliabilityDetail(
  observation: PriceObservation,
  reliability: SourceReliability,
): string {
  switch (reliability) {
    case "VERIFIED":
      return "Read from the retailer's own product page";
    case "CONDITIONALLY_VERIFIED":
      return observation.sourceType === "USER_ENTERED"
        ? "Entered by you — not independently verified"
        : "Montreal-area online price — may differ in store";
    case "STALE":
      return "Source is older than the freshness window";
    default:
      return observation.isMock
        ? "Mock fixture — not a real price"
        : "Could not be confirmed at the source";
  }
}

function availabilityLabel(o: PriceObservation): string {
  switch (o.availability) {
    case "IN_STOCK":
      return "In stock at the competitor";
    case "OUT_OF_STOCK":
      return "Out of stock at the competitor";
    case "ONLINE_ONLY":
      return "Online only — may not be in the store";
    default:
      return "Availability unknown";
  }
}

function buildReason(
  state: OpportunityState,
  checkoutReady: boolean,
  suppress: string[],
  competitor: PriceObservation,
): string {
  if (checkoutReady) {
    return `All gates passed: exact match, fresh verified price from ${competitor.retailerId} product page, in stock, direct URL present.`;
  }
  if (suppress.length > 0) {
    return `Excluded from checkout-ready results: ${suppress.join(" ")}`;
  }
  if (competitor.isMock) {
    return `Shown as ${state} but not checkout-ready: the price is MOCK FIXTURE data and was never observed at a retailer.`;
  }
  return `Shown as ${state} but not checkout-ready (missing product URL, no specific store context, or price confidence below the checkout bar).`;
}

/** Label shown on the card when a row is not checkout-ready. */
export function stateLabel(state: OpportunityState, isMock: boolean): string {
  if (isMock) return "MOCK DATA — not usable at checkout";
  switch (state) {
    case "CHECKOUT_READY_PROOF":
      return "Checkout-ready proof";
    case "POTENTIAL_PRICE_MATCH":
      return "Potential price-match opportunity";
    default:
      return "Potential savings — verification required";
  }
}
