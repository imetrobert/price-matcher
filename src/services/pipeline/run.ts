/**
 * The comparison pipeline.
 *
 * CANONICAL PRODUCT
 *   -> competitor search (all competitors in parallel)
 *   -> candidate ranking (deterministic matcher)
 *   -> price fetch for the winning candidate only
 *   -> eligibility gauntlet
 *   -> savings arithmetic (integer cents, in code, never by an LLM)
 *   -> threshold filter
 *   -> sort
 *
 * A failure anywhere degrades one product/retailer pair into an "unable to
 * verify" row. It never fails the run and never substitutes a fallback price.
 */

import "server-only";

import { env } from "@/config/env";
import { SAVINGS } from "@/config/thresholds";
import { competitorsFor, getRetailer } from "@/config/retailers";
import { calculateSavingsCents, meetsThreshold, sumCents } from "@/lib/money";
import { saveAudit, saveObservations } from "@/lib/store";
import { selectBestCandidate } from "@/services/matching/matcher";
import { evaluateEligibility } from "@/services/policies/eligibility";
import { classifyFreshness } from "@/services/pricing/freshness";
import { productLabel } from "@/services/products/normalize";
import { getAdapter, healthReport, safeHealth } from "@/services/retailers/registry";
import type {
  AuditRecord,
  CanonicalProduct,
  Cents,
  MatchResult,
  PipelineResult,
  PriceObservation,
  RetailerId,
  SavingsOpportunity,
  StoreContext,
  UnverifiedItem,
} from "@/types";

export interface PipelineInput {
  items: PipelineItem[];
  storeContext: StoreContext;
  thresholdCents?: Cents;
  now?: Date;
}

export interface PipelineItem {
  canonical: CanonicalProduct;
  /**
   * Shelf price the user typed in. Optional, but without it (and without a
   * working current-retailer adapter) no savings figure can be produced.
   */
  manualCurrentPriceCents?: Cents | null;
}

export async function runPipeline(
  input: PipelineInput,
): Promise<PipelineResult> {
  const now = input.now ?? new Date();
  const runId = `run-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const threshold = input.thresholdCents ?? SAVINGS.defaultThresholdCents;
  const ctx = input.storeContext;

  const opportunities: SavingsOpportunity[] = [];
  const unverified: UnverifiedItem[] = [];
  const audit: AuditRecord[] = [];
  const observations: PriceObservation[] = [];

  // Process cart items in parallel; each item fans out across competitors.
  const perItem = await Promise.all(
    input.items.map((item) => processItem(item, ctx, now)),
  );

  for (const result of perItem) {
    observations.push(...result.observations);

    if (result.kind === "unverified") {
      unverified.push(result.unverified);
      audit.push(
        auditRow({
          runId,
          now,
          canonical: result.canonical,
          currentRetailerId: ctx.retailerId,
          competitor: null,
          currentPrice: result.currentPrice,
          savings: null,
          eligibility: "EXCLUDED",
          reason: `${result.unverified.reason}: ${result.unverified.detail}`,
        }),
      );
      continue;
    }

    for (const evaluated of result.evaluated) {
      const { competitor, match, verdict, savingsCents } = evaluated;

      const passesThreshold = meetsThreshold(savingsCents, threshold);
      const displayable =
        verdict.suppress.length === 0 && savingsCents > 0 && passesThreshold;

      audit.push(
        auditRow({
          runId,
          now,
          canonical: result.canonical,
          currentRetailerId: ctx.retailerId,
          competitor,
          currentPrice: result.currentPrice,
          savings: savingsCents,
          matchScore: match.score,
          matchLevel: match.level,
          eligibility: displayable ? verdict.state : "EXCLUDED",
          reason: displayable
            ? verdict.reason
            : verdict.suppress.length > 0
              ? verdict.reason
              : `Savings ${savingsCents}¢ below threshold ${threshold}¢.`,
        }),
      );

      if (!displayable) continue;

      opportunities.push({
        id: `${result.canonical.id}::${competitor.retailerId}`,
        canonical: result.canonical,
        currentStore: result.currentPrice!,
        competitor,
        match,
        savingsCents,
        state: verdict.state,
        competitorFreshness: verdict.competitorFreshness,
        checkoutReady: verdict.checkoutReady,
        proofPoints: verdict.proofPoints,
        displayReason: verdict.reason,
        isMock: competitor.isMock || Boolean(result.currentPrice?.isMock),
      });
    }

    // An item that produced no displayable row still deserves an explanation.
    const produced = opportunities.some(
      (o) => o.canonical.id === result.canonical.id,
    );
    if (!produced) {
      unverified.push({
        canonical: result.canonical,
        detected: null,
        reason: "No qualifying price match",
        detail: bestExcuse(result.evaluated, threshold),
      });
    }
  }

  const ranked = sortOpportunities(opportunities);

  await saveObservations(observations);
  await saveAudit(audit);

  return {
    runId,
    createdAt: now.toISOString(),
    storeContext: ctx,
    thresholdCents: threshold,
    opportunities: ranked,
    unverified,
    totalSavingsCents: sumCents(ranked.map((o) => o.savingsCents)),
    qualifyingCount: ranked.length,
    adapterHealth: await healthReport(),
    dataMode: env.dataMode,
    containsMockData: ranked.some((o) => o.isMock) || observations.some((o) => o.isMock),
  };
}

// ---------------------------------------------------------------------------
// Per-item processing
// ---------------------------------------------------------------------------

interface EvaluatedCompetitor {
  competitor: PriceObservation;
  match: MatchResult;
  verdict: ReturnType<typeof evaluateEligibility>;
  savingsCents: Cents;
}

type ItemResult =
  | {
      kind: "unverified";
      canonical: CanonicalProduct;
      currentPrice: PriceObservation | null;
      unverified: UnverifiedItem;
      observations: PriceObservation[];
    }
  | {
      kind: "evaluated";
      canonical: CanonicalProduct;
      currentPrice: PriceObservation;
      evaluated: EvaluatedCompetitor[];
      observations: PriceObservation[];
    };

async function processItem(
  item: PipelineItem,
  ctx: StoreContext,
  now: Date,
): Promise<ItemResult> {
  const observations: PriceObservation[] = [];
  const canonical = item.canonical;

  // --- 1. Establish the price at the store the user is standing in --------
  const currentPrice = await resolveCurrentPrice(item, ctx, now);
  if (currentPrice) observations.push(currentPrice);

  if (!currentPrice) {
    return {
      kind: "unverified",
      canonical,
      currentPrice: null,
      observations,
      unverified: {
        canonical,
        detected: null,
        reason: "Current store price could not be independently verified",
        detail: `Enter the shelf price for ${productLabel(canonical)} to continue.`,
      },
    };
  }

  // --- 2. Fan out across competitors in parallel --------------------------
  const competitors = competitorsFor(ctx.retailerId);
  const results = await Promise.all(
    competitors.map((r) => priceAtCompetitor(canonical, r.id, ctx)),
  );

  const evaluated: EvaluatedCompetitor[] = [];
  for (const r of results) {
    if (!r.observation) continue;
    observations.push(r.observation);

    const verdict = evaluateEligibility({
      currentStore: currentPrice,
      competitor: r.observation,
      match: r.match!,
      now,
    });

    // Arithmetic in code. Always.
    const savingsCents = calculateSavingsCents(
      currentPrice.price,
      r.observation.price,
    );

    evaluated.push({
      competitor: r.observation,
      match: r.match!,
      verdict,
      savingsCents,
    });
  }

  return {
    kind: "evaluated",
    canonical,
    currentPrice,
    evaluated,
    observations,
  };
}

/**
 * Current-store price. Manual entry wins when supplied — it is what the user
 * can actually see on the shelf — but it is recorded as USER_ENTERED and never
 * described as independently verified.
 */
async function resolveCurrentPrice(
  item: PipelineItem,
  ctx: StoreContext,
  now: Date,
): Promise<PriceObservation | null> {
  if (
    typeof item.manualCurrentPriceCents === "number" &&
    item.manualCurrentPriceCents > 0
  ) {
    return {
      id: `manual-${item.canonical.id}-${now.getTime()}`,
      retailerId: ctx.retailerId,
      storeId: ctx.storeId,
      postalCode: ctx.postalCode,
      canonicalProductId: item.canonical.id,
      retailerProductId: null,
      productName: productLabel(item.canonical),
      productUrl: null,
      price: item.manualCurrentPriceCents,
      regularPrice: null,
      salePrice: null,
      currency: "CAD",
      availability: "IN_STOCK",
      observedAt: now.toISOString(),
      sourceUrl: null,
      sourceType: "USER_ENTERED",
      priceConfidence: 1, // The user read the shelf tag; it is what they will pay.
      matchConfidence: 100,
      checkoutProofStatus: "VERIFICATION_REQUIRED",
      sourceReliability: "CONDITIONALLY_VERIFIED",
      validity: null,
      restrictions: ["Entered manually by the shopper"],
      notes: ["Shelf price entered by the user; not independently verified."],
      rawSourceReference: null,
      isMock: false,
    };
  }

  const r = await priceAtCompetitor(item.canonical, ctx.retailerId, ctx);
  return r.observation;
}

interface CompetitorPrice {
  retailerId: RetailerId;
  observation: PriceObservation | null;
  match: MatchResult | null;
  failure: string | null;
}

/**
 * One retailer, one product. Every failure mode returns a null observation
 * with a human-readable `failure` — never a fabricated price.
 */
async function priceAtCompetitor(
  canonical: CanonicalProduct,
  retailerId: RetailerId,
  ctx: StoreContext,
): Promise<CompetitorPrice> {
  const adapter = getAdapter(retailerId);

  try {
    const health = await safeHealth(adapter);
    if (health.status === "UNAVAILABLE") {
      return { retailerId, observation: null, match: null, failure: health.reason };
    }

    const search = await adapter.searchProduct(canonical, ctx);
    if (!search.ok) {
      return {
        retailerId,
        observation: null,
        match: null,
        failure: search.error.message,
      };
    }

    const best = selectBestCandidate(canonical, search.data);
    if (!best) {
      return {
        retailerId,
        observation: null,
        match: null,
        failure: `${getRetailer(retailerId).displayName} has no product we can confirm is identical.`,
      };
    }

    const priced = await adapter.getPrice(best.candidate, canonical, ctx);
    if (!priced.ok) {
      return {
        retailerId,
        observation: null,
        match: best.match,
        failure: priced.error.message,
      };
    }

    const observation: PriceObservation = {
      ...priced.data,
      matchConfidence: best.match.score,
      checkoutProofStatus: best.match.eligibleForCheckoutProof
        ? "VERIFICATION_REQUIRED"
        : "NOT_ELIGIBLE",
    };

    return { retailerId, observation, match: best.match, failure: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      retailerId,
      observation: null,
      match: null,
      failure: `${getRetailer(retailerId).displayName} price service temporarily unavailable — ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Sorting (spec §24: savings alone must not decide the order)
// ---------------------------------------------------------------------------

const STATE_RANK: Record<SavingsOpportunity["state"], number> = {
  CHECKOUT_READY_PROOF: 3,
  POTENTIAL_PRICE_MATCH: 2,
  CHEAPER_ELSEWHERE: 1,
};

const FRESHNESS_RANK: Record<string, number> = {
  FRESH: 3,
  ACCEPTABLE: 2,
  STALE: 1,
  EXPIRED: 0,
};

/**
 * Strength of proof outranks raw savings, so a $1.50 exact verified match
 * sorts above a $2.00 match we are less sure about.
 */
export function sortOpportunities(
  rows: SavingsOpportunity[],
): SavingsOpportunity[] {
  return [...rows].sort((a, b) => {
    if (a.checkoutReady !== b.checkoutReady) return a.checkoutReady ? -1 : 1;

    const stateDiff = STATE_RANK[b.state] - STATE_RANK[a.state];
    if (stateDiff !== 0) return stateDiff;

    const scoreDiff = b.match.score - a.match.score;
    if (Math.abs(scoreDiff) >= 5) return scoreDiff;

    const freshDiff =
      (FRESHNESS_RANK[b.competitorFreshness] ?? 0) -
      (FRESHNESS_RANK[a.competitorFreshness] ?? 0);
    if (freshDiff !== 0) return freshDiff;

    return b.savingsCents - a.savingsCents;
  });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function auditRow(args: {
  runId: string;
  now: Date;
  canonical: CanonicalProduct;
  currentRetailerId: RetailerId;
  competitor: PriceObservation | null;
  currentPrice: PriceObservation | null;
  savings: Cents | null;
  matchScore?: number;
  matchLevel?: AuditRecord["matchLevel"];
  eligibility: AuditRecord["eligibility"];
  reason: string;
}): AuditRecord {
  const { competitor } = args;
  return {
    id: `${args.runId}-${args.canonical.id}-${competitor?.retailerId ?? "none"}`,
    runId: args.runId,
    createdAt: args.now.toISOString(),
    canonicalProductId: args.canonical.id,
    productLabel: productLabel(args.canonical),
    currentRetailerId: args.currentRetailerId,
    competitorRetailerId: competitor?.retailerId ?? null,
    currentPriceCents: args.currentPrice?.price ?? null,
    competitorPriceCents: competitor?.price ?? null,
    savingsCents: args.savings,
    matchLevel: args.matchLevel ?? "NO_MATCH",
    matchScore: args.matchScore ?? 0,
    gtin: args.canonical.gtin,
    priceConfidence: competitor?.priceConfidence ?? 0,
    sourceUrl: competitor?.sourceUrl ?? null,
    observedAt: competitor?.observedAt ?? null,
    freshness: competitor ? classifyFreshness(competitor, args.now) : null,
    checkoutProofStatus: competitor?.checkoutProofStatus ?? "NOT_ELIGIBLE",
    eligibility: args.eligibility,
    reason: args.reason,
    isMock: Boolean(competitor?.isMock || args.currentPrice?.isMock),
  };
}

function bestExcuse(
  evaluated: EvaluatedCompetitor[],
  threshold: Cents,
): string {
  if (evaluated.length === 0) {
    return "No competitor returned a product we could confirm is identical.";
  }
  const positive = evaluated.filter((e) => e.savingsCents > 0);
  if (positive.length === 0) {
    return "No competitor was cheaper than the current store.";
  }
  const clean = positive.filter((e) => e.verdict.suppress.length === 0);
  if (clean.length > 0) {
    const best = Math.max(...clean.map((e) => e.savingsCents));
    return `Best saving found was ${best}¢, below your ${threshold}¢ threshold.`;
  }
  return positive[0]!.verdict.suppress[0] ?? "Could not verify a cheaper price.";
}
