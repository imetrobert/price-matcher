/**
 * Persistence facade.
 *
 * Backend selection is automatic and explicit:
 *   - Supabase, when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.
 *   - Local JSONL file store otherwise (zero-config local development).
 *
 * The rest of the codebase imports only from here, so swapping or adding a
 * backend touches this directory and nothing else.
 */

import "server-only";

import * as fileStore from "@/lib/store/file";
import { supabaseEnabled, supabaseStore } from "@/lib/store/supabase";
import type { AuditRecord, MatchValidationReport, PriceObservation } from "@/types";

export { supabaseEnabled, supabaseHealth } from "@/lib/store/supabase";

export type StoreBackend = "supabase" | "file";

export function activeBackend(): StoreBackend {
  return supabaseEnabled() ? "supabase" : "file";
}

export async function saveObservations(rows: PriceObservation[]): Promise<void> {
  if (rows.length === 0) return;
  if (supabaseEnabled()) return supabaseStore.saveObservations(rows);
  return fileStore.saveObservations(rows);
}

export async function recentObservations(limit = 500): Promise<PriceObservation[]> {
  if (supabaseEnabled()) return supabaseStore.recentObservations(limit);
  return fileStore.recentObservations(limit);
}

export async function saveAudit(rows: AuditRecord[]): Promise<void> {
  if (rows.length === 0) return;
  if (supabaseEnabled()) return supabaseStore.saveAudit(rows);
  return fileStore.saveAudit(rows);
}

export async function recentAudit(limit = 500): Promise<AuditRecord[]> {
  if (supabaseEnabled()) return supabaseStore.recentAudit(limit);
  return fileStore.recentAudit(limit);
}

export async function saveValidation(report: MatchValidationReport): Promise<void> {
  if (supabaseEnabled()) return supabaseStore.saveValidation(report);
  return fileStore.saveValidation(report);
}

export async function recentValidations(limit = 200): Promise<MatchValidationReport[]> {
  if (supabaseEnabled()) return supabaseStore.recentValidations(limit);
  return fileStore.recentValidations(limit);
}

/** Aggregate real-world feedback per retailer — input to reliability ratings. */
export async function validationSummary(): Promise<
  Record<string, { total: number; priceMatched: number; accepted: number }>
> {
  const rows = await recentValidations(1000);
  const out: Record<
    string,
    { total: number; priceMatched: number; accepted: number }
  > = {};
  for (const r of rows) {
    const key = r.competitorRetailerId;
    const bucket = out[key] ?? { total: 0, priceMatched: 0, accepted: 0 };
    bucket.total += 1;
    if (r.priceMatched === true) bucket.priceMatched += 1;
    if (r.priceMatchRequestAccepted === true) bucket.accepted += 1;
    out[key] = bucket;
  }
  return out;
}
