"use client";

/**
 * Persistence, from the browser, under Row Level Security.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SECRET KEY IS GONE
 * ---------------------------------------------------------------------------
 * This used to write with the Supabase secret (service-role) key from a
 * server. There is no server now, and that key can never go in a static
 * bundle — it bypasses RLS entirely, and this repository is public.
 *
 * So writes go through the ordinary authenticated client instead, and
 * Postgres decides what is permitted. `supabase/policies.sql` grants inserts
 * to `authenticated` only, with `user_id` forced to `auth.uid()`, so a row can
 * only ever be written as yourself. That is a stronger arrangement than the
 * old one: previously any code path holding the secret key could write
 * anything; now the database enforces it regardless of what the client tries.
 *
 * Writes are best-effort. The audit trail is a debugging and evidence aid, and
 * a Supabase outage must never stop someone checking a price in a shop.
 */

import { createClient } from "@/lib/auth/client";
import { supabaseConfigured } from "@/config/env";
import { getSession } from "@/lib/auth/session";
import type { AuditRecord, MatchValidationReport, PriceObservation } from "@/types";

export type StoreBackend = "supabase" | "none";

export function activeBackend(): StoreBackend {
  return supabaseConfigured() ? "supabase" : "none";
}

const TABLES = {
  observations: "cartmatch_price_observations",
  audit: "cartmatch_audit_records",
  validations: "cartmatch_validations",
} as const;

/**
 * Every row names its owner explicitly.
 *
 * The column also carries `default auth.uid()`, so this looks redundant — it is
 * not. The insert policy is `with check (has_app_access('cartmatch') and
 * user_id = auth.uid())`. If these tables are ever recreated without that
 * default, every row would arrive with user_id NULL, fail the check, and be
 * dropped into the console warning below rather than raised. The app would look
 * like it was working and persist nothing. Naming the owner in code means
 * correctness does not depend on a column default nobody looks at.
 */
async function insert(
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0 || !supabaseConfigured()) return;
  try {
    const { user } = await getSession();
    if (!user) {
      // Not an error worth shouting about: signed-out users can still run the
      // pipeline in mock mode, and RLS would refuse the write anyway.
      return;
    }

    const supabase = createClient();
    const { error } = await supabase
      .from(table)
      .insert(rows.map((r) => ({ ...r, user_id: user.id })));
    if (error) {
      // Surfaced in the console rather than thrown: losing an audit row is not
      // a reason to fail a price check.
      //
      // A persistent RLS error here means one of two things, and they are worth
      // telling apart: supabase/policies.sql has not been applied, or this
      // account has no 'cartmatch' row in public.app_access.
      console.warn(
        `[cartmatch] write failed table=${table} code=${error.code} message=${error.message}`,
      );
    }
  } catch (err) {
    console.warn(`[cartmatch] write threw table=${table}`, err);
  }
}

async function selectRecent<T>(table: string, limit: number): Promise<T[]> {
  if (!supabaseConfigured()) return [];
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from(table)
      .select("payload")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      console.warn(`[cartmatch] read failed table=${table} message=${error.message}`);
      return [];
    }
    return (data ?? [])
      .map((r) => (r as { payload: T }).payload)
      .filter(Boolean);
  } catch {
    return [];
  }
}

// --- Price observations -----------------------------------------------------

export async function saveObservations(rows: PriceObservation[]): Promise<void> {
  await insert(
    TABLES.observations,
    rows.map((r) => ({
      id: r.id,
      created_at: r.observedAt,
      retailer_id: r.retailerId,
      canonical_product_id: r.canonicalProductId,
      price_cents: r.price,
      is_mock: r.isMock,
      payload: r,
    })),
  );
}

export async function recentObservations(limit = 500): Promise<PriceObservation[]> {
  return selectRecent<PriceObservation>(TABLES.observations, limit);
}

// --- Audit trail ------------------------------------------------------------

export async function saveAudit(rows: AuditRecord[]): Promise<void> {
  await insert(
    TABLES.audit,
    rows.map((r) => ({
      id: r.id,
      created_at: r.createdAt,
      run_id: r.runId,
      canonical_product_id: r.canonicalProductId,
      current_retailer_id: r.currentRetailerId,
      competitor_retailer_id: r.competitorRetailerId,
      savings_cents: r.savingsCents,
      eligibility: r.eligibility,
      is_mock: r.isMock,
      payload: r,
    })),
  );
}

export async function recentAudit(limit = 500): Promise<AuditRecord[]> {
  return selectRecent<AuditRecord>(TABLES.audit, limit);
}

// --- Real-world validation feedback ----------------------------------------

export async function saveValidation(report: MatchValidationReport): Promise<void> {
  await insert(TABLES.validations, [
    {
      id: report.id,
      created_at: report.recordedAt,
      opportunity_id: report.opportunityId,
      retailer_id: report.retailerId,
      competitor_retailer_id: report.competitorRetailerId,
      price_matched: report.priceMatched,
      request_accepted: report.priceMatchRequestAccepted,
      payload: report,
    },
  ]);
}

export async function recentValidations(limit = 200): Promise<MatchValidationReport[]> {
  return selectRecent<MatchValidationReport>(TABLES.validations, limit);
}

/**
 * Aggregate YOUR OWN validation reports per retailer.
 *
 * Not measured retailer reliability, and must not be presented as such. RLS
 * returns only the caller's rows (an app_admin sees everyone's, which is its
 * own kind of misleading), so this is a personal tally — with three users on
 * the project, typically a handful of reports.
 *
 * Turning this into real evidence for `priceReliability` in
 * src/config/retailers.ts needs a cross-user aggregate, and that cannot be a
 * view: see the note at the end of supabase/policies.sql for the shape.
 */
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
