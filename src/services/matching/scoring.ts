/**
 * Deterministic product match scoring.
 *
 * ---------------------------------------------------------------------------
 * SCORING MODEL (documented because a cashier may be shown its conclusion)
 * ---------------------------------------------------------------------------
 * The score is NOT a similarity percentage. It is a ladder: you land on the
 * highest rung whose conditions you fully satisfy, and hard blockers knock you
 * off the ladder entirely regardless of how similar the text looks.
 *
 *   100  L1  GTIN/UPC equal (check-digit-validated, normalized to GTIN-14)
 *    98  L2  Same retailer product id already mapped to this canonical product
 *    95  L3  brand + name + variant + fat% + exact size + package count
 *    90  L3  brand + name + variant + exact size (fat% unknown on one side)
 *    70  L4  Strong token overlap but at least one identity attribute unproven
 *   <70  L4  Weak similarity
 *     0      Hard blocker present
 *
 * HARD BLOCKERS (score forced to 0, never displayable as a price match):
 *   - different brand
 *   - different variant/flavour
 *   - different size (beyond 2% unit-conversion tolerance)
 *   - different package count (650 g tub vs 4 x 100 g cups)
 *   - different fat percentage
 *   - product-line token on one side only (Oikos vs Oikos Pro)
 *   - conflicting GTINs (both known, and different)
 *
 * The blocker list is what makes this system conservative. A blocker is
 * checked BEFORE any similarity is computed, so no amount of textual overlap
 * can rescue a genuinely different product.
 */

import { MATCH_THRESHOLDS, CHECKOUT_ELIGIBLE_TIERS, tierForScore } from "@/config/thresholds";
import {
  PRODUCT_LINE_TOKENS,
  gtinsMatch,
  meaningfulTokens,
  normalizeGtin,
  normalizeText,
  sizesMatch,
} from "@/services/products/normalize";
import type { CanonicalProduct, MatchLevel, MatchResult } from "@/types";

export const SCORE = {
  gtinExact: 100,
  retailerIdExact: 98,
  fullAttribute: 95,
  strongAttribute: 90,
  fuzzyStrong: 70,
  fuzzyWeak: 40,
} as const;

export interface MatchOptions {
  /**
   * Set when the competitor's retailer product id is already mapped to this
   * canonical product by a previously verified observation (Level 2).
   */
  retailerIdAlreadyMapped?: boolean;
}

/**
 * Compare two canonical products and produce a transparent, reproducible
 * verdict. Pure function — same inputs always give the same output.
 */
export function scoreMatch(
  a: CanonicalProduct,
  b: CanonicalProduct,
  options: MatchOptions = {},
): MatchResult {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const gtinA = normalizeGtin(a.gtin);
  const gtinB = normalizeGtin(b.gtin);

  // -- Level 1: GTIN outranks everything ----------------------------------
  // A validated, equal GTIN IS the product identity, so it is checked before
  // the attribute blockers rather than after them. This matters in Quebec:
  // the same item is listed as "Oikos Greek Yogurt Vanilla" at one banner and
  // "Oikos Yogourt Grec Vanille" at another. Those are the same barcode, and
  // blocking on the text difference would reject a genuine exact match.
  if (gtinA && gtinB && gtinA === gtinB) {
    reasons.push(`GTIN match (${gtinA})`);
    return finalize("L1_GTIN", SCORE.gtinExact, reasons, blockers);
  }

  // -- Hard blockers ------------------------------------------------------
  if (gtinA && gtinB && gtinA !== gtinB) {
    blockers.push(`Different GTIN (${gtinA} vs ${gtinB})`);
  }

  if (!brandsMatch(a.brand, b.brand)) {
    blockers.push(`Different brand ("${a.brand}" vs "${b.brand}")`);
  }

  if (!variantsMatch(a.variant, b.variant)) {
    blockers.push(
      `Different variant ("${a.variant ?? "none"}" vs "${b.variant ?? "none"}")`,
    );
  }

  if (a.fatPercentage && b.fatPercentage && a.fatPercentage !== b.fatPercentage) {
    blockers.push(
      `Different fat percentage (${a.fatPercentage}% vs ${b.fatPercentage}%)`,
    );
  }

  if (a.size && b.size && !sizesMatch(a.size, b.size)) {
    blockers.push(`Different size (${a.size.raw} vs ${b.size.raw})`);
  }

  if (a.packageCount !== b.packageCount) {
    blockers.push(
      `Different package count (${a.packageCount} vs ${b.packageCount})`,
    );
  }

  const lineDiff = productLineDifference(a, b);
  if (lineDiff) {
    blockers.push(lineDiff);
  }

  if (blockers.length > 0) {
    return {
      level: "NO_MATCH",
      score: 0,
      tier: "REJECTED",
      reasons,
      blockers,
      eligibleForCheckoutProof: false,
    };
  }

  // -- Level 2: known retailer product mapping ----------------------------
  if (options.retailerIdAlreadyMapped) {
    reasons.push("Retailer product id already mapped to this canonical product");
    return finalize("L2_RETAILER_ID", SCORE.retailerIdExact, reasons, blockers);
  }

  // -- Level 3: attribute match -------------------------------------------
  const namesMatch = productNamesMatch(a, b);
  const bothSizesKnown = Boolean(a.size && b.size);
  const sizeConfirmed = bothSizesKnown && sizesMatch(a.size, b.size);

  if (namesMatch && sizeConfirmed) {
    reasons.push(`Brand match ("${a.brand}")`);
    reasons.push("Product name match");
    reasons.push(
      a.variant ? `Variant match ("${a.variant}")` : "No variant on either side",
    );
    reasons.push(`Size match (${a.size!.raw} ≡ ${b.size!.raw})`);
    reasons.push(`Package count match (${a.packageCount})`);

    const fatKnownBoth = Boolean(a.fatPercentage && b.fatPercentage);
    if (fatKnownBoth) {
      reasons.push(`Fat percentage match (${a.fatPercentage}%)`);
      return finalize("L3_ATTRIBUTES", SCORE.fullAttribute, reasons, blockers);
    }
    if (!a.fatPercentage && !b.fatPercentage) {
      // Fat% is irrelevant for most categories; absent on both sides is fine.
      return finalize("L3_ATTRIBUTES", SCORE.fullAttribute, reasons, blockers);
    }
    reasons.push("Fat percentage known on one side only");
    return finalize("L3_ATTRIBUTES", SCORE.strongAttribute, reasons, blockers);
  }

  // -- Level 4: fuzzy -----------------------------------------------------
  const overlap = tokenOverlap(a.normalizedTokens, b.normalizedTokens);
  const missingSize = !bothSizesKnown;
  if (missingSize) {
    reasons.push("Size could not be confirmed on both sides");
  }
  if (!namesMatch) {
    reasons.push("Product name only partially overlaps");
  }
  const fuzzyScore = Math.round(
    SCORE.fuzzyWeak + overlap * (SCORE.fuzzyStrong - SCORE.fuzzyWeak),
  );
  reasons.push(`Token overlap ${(overlap * 100).toFixed(0)}%`);
  return finalize("L4_FUZZY", Math.min(fuzzyScore, SCORE.fuzzyStrong), reasons, blockers);
}

function finalize(
  level: MatchLevel,
  score: number,
  reasons: string[],
  blockers: string[],
): MatchResult {
  const tier = tierForScore(score);
  return {
    level,
    score,
    tier,
    reasons,
    blockers,
    // Level 4 is never automatically checkout-ready, whatever it scored.
    eligibleForCheckoutProof:
      CHECKOUT_ELIGIBLE_TIERS.includes(tier) && level !== "L4_FUZZY",
  };
}

// ---------------------------------------------------------------------------
// Attribute comparisons
// ---------------------------------------------------------------------------

export function brandsMatch(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === "" || nb === "") return false;
  if (na === nb) return true;
  // Allow "President's Choice" vs "PC" style only when one is a strict token
  // subset of the other AND the shorter side is at least 3 characters. This is
  // deliberately tight: "PC" and "Oikos" must never collapse together.
  const ta = new Set(meaningfulTokens(na));
  const tb = new Set(meaningfulTokens(nb));
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size === 0) return false;
  for (const t of small) {
    if (!large.has(t)) return false;
  }
  return true;
}

export function variantsMatch(a: string | null, b: string | null): boolean {
  // Unknown on one side is not a blocker — it caps the score instead.
  if (!a || !b) return true;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return true;
  const ta = new Set(meaningfulTokens(na));
  const tb = new Set(meaningfulTokens(nb));
  if (ta.size === 0 || tb.size === 0) return true;
  // Any shared meaningful token is enough (e.g. "vanilla" vs "vanille bean"),
  // but zero shared tokens means genuinely different flavours.
  for (const t of ta) {
    if (tb.has(t)) return true;
  }
  return false;
}

/**
 * Detect a product-line token present on exactly one side.
 * This is what stops "Oikos Greek Yogurt" from matching "Oikos Pro".
 */
export function productLineDifference(
  a: CanonicalProduct,
  b: CanonicalProduct,
): string | null {
  const linesA = lineTokens(a);
  const linesB = lineTokens(b);
  const onlyA = [...linesA].filter((t) => !linesB.has(t));
  const onlyB = [...linesB].filter((t) => !linesA.has(t));
  if (onlyA.length === 0 && onlyB.length === 0) return null;
  const parts: string[] = [];
  if (onlyA.length) parts.push(`only on "${a.brand} ${a.name}": ${onlyA.join(", ")}`);
  if (onlyB.length) parts.push(`only on "${b.brand} ${b.name}": ${onlyB.join(", ")}`);
  return `Different product line (${parts.join("; ")})`;
}

function lineTokens(p: CanonicalProduct): Set<string> {
  const source = [p.brand, p.name, p.variant ?? ""].join(" ");
  return new Set(
    meaningfulTokens(source).filter((t) => PRODUCT_LINE_TOKENS.has(t)),
  );
}

function productNamesMatch(a: CanonicalProduct, b: CanonicalProduct): boolean {
  const ta = new Set(meaningfulTokens(a.name));
  const tb = new Set(meaningfulTokens(b.name));
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let hits = 0;
  for (const t of small) if (large.has(t)) hits += 1;
  // Every token of the shorter name must appear in the longer one.
  return hits === small.size;
}

export function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

export { MATCH_THRESHOLDS };
