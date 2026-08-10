/**
 * Price freshness and validity windows.
 *
 * Pure functions with an injectable `now` so the tests are deterministic and
 * do not depend on wall-clock time.
 */

import {
  FRESHNESS_HOURS,
  RETAILER_FRESHNESS_OVERRIDES,
} from "@/config/thresholds";
import type { Freshness, PriceObservation, RetailerId, ValidityPeriod } from "@/types";

const HOUR_MS = 60 * 60 * 1000;

export function ageHours(observedAt: string, now: Date = new Date()): number {
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / HOUR_MS;
}

export function windowFor(retailerId: RetailerId): {
  fresh: number;
  acceptable: number;
} {
  return (
    RETAILER_FRESHNESS_OVERRIDES[retailerId] ?? {
      fresh: FRESHNESS_HOURS.fresh,
      acceptable: FRESHNESS_HOURS.acceptable,
    }
  );
}

/**
 * Classify an observation.
 *
 * EXPIRED beats everything: a flyer price outside its printed validity window
 * is not "stale", it is simply not a price any more, even if we fetched it a
 * minute ago.
 */
export function classifyFreshness(
  observation: Pick<PriceObservation, "observedAt" | "retailerId" | "validity">,
  now: Date = new Date(),
): Freshness {
  if (observation.validity && !validityCovers(observation.validity, now)) {
    return "EXPIRED";
  }
  const w = windowFor(observation.retailerId);
  const age = ageHours(observation.observedAt, now);
  if (age < 0) {
    // Clock skew / future timestamp — do not treat as fresh.
    return "STALE";
  }
  if (age <= w.fresh) return "FRESH";
  if (age <= w.acceptable) return "ACCEPTABLE";
  return "STALE";
}

/** Is `now` inside the flyer window? Open-ended bounds are permissive. */
export function validityCovers(
  validity: ValidityPeriod,
  now: Date = new Date(),
): boolean {
  const t = now.getTime();
  if (validity.startsAt) {
    const s = Date.parse(validity.startsAt);
    if (Number.isFinite(s) && t < s) return false;
  }
  if (validity.endsAt) {
    const e = Date.parse(validity.endsAt);
    if (Number.isFinite(e) && t > e) return false;
  }
  return true;
}

/** Only FRESH and ACCEPTABLE prices may back a checkout claim. */
export function freshnessAllowsCheckout(f: Freshness): boolean {
  return f === "FRESH" || f === "ACCEPTABLE";
}

export function describeFreshness(
  observation: Pick<PriceObservation, "observedAt" | "retailerId" | "validity">,
  now: Date = new Date(),
): string {
  const f = classifyFreshness(observation, now);
  if (f === "EXPIRED") {
    const end = observation.validity?.endsAt;
    return end
      ? `Promotional price expired ${formatDate(end)}`
      : "Promotional price is outside its validity period";
  }
  const age = ageHours(observation.observedAt, now);
  if (!Number.isFinite(age)) return "Observation time unknown";
  if (age < 1) return "Checked less than an hour ago";
  if (age < 24) return `Checked ${Math.floor(age)} h ago`;
  const days = Math.floor(age / 24);
  return `Checked ${days} day${days === 1 ? "" : "s"} ago`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown date";
  return d.toLocaleDateString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
