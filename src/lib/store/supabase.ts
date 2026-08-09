/**
 * Supabase persistence backend.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS / VERIFICATION STATUS
 * ---------------------------------------------------------------------------
 * You already run Supabase, so CartMatch should use it rather than ship its own
 * database. This backend activates automatically when SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY are set, and falls back to the local file store
 * otherwise — no code change needed to switch.
 *
 * It talks to PostgREST directly with `fetch`, so there is no @supabase/*
 * dependency to install, version or bundle. The three tables it needs are in
 * `supabase/schema.sql`; apply that to your project once.
 *
 * NOT YET EXERCISED: no Supabase project was reachable from the development
 * environment, so these requests have never run against a live instance. The
 * request shapes follow the documented PostgREST contract, but treat your
 * first run as the acceptance test. Failures are swallowed by design (see
 * below), so check `supabase_write_failed` warnings in the server log rather
 * than expecting an exception.
 */

import "server-only";

import type { AuditRecord, MatchValidationReport, PriceObservation } from "@/types";

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  schema: string;
}

export function supabaseConfig(): SupabaseConfig | null {
  const url = (process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (url === "" || key === "") return null;
  return {
    url,
    serviceRoleKey: key,
    schema: (process.env.SUPABASE_SCHEMA ?? "public").trim() || "public",
  };
}

export function supabaseEnabled(): boolean {
  return supabaseConfig() !== null;
}

/** Table names, overridable so CartMatch can live beside your existing tables. */
export const TABLES = {
  observations: process.env.SUPABASE_TABLE_OBSERVATIONS ?? "cartmatch_price_observations",
  audit: process.env.SUPABASE_TABLE_AUDIT ?? "cartmatch_audit_records",
  validations: process.env.SUPABASE_TABLE_VALIDATIONS ?? "cartmatch_validations",
} as const;

async function request(
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: string }> {
  const cfg = supabaseConfig();
  if (!cfg) return { ok: false, status: 0, body: "supabase not configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        "Content-Type": "application/json",
        "Accept-Profile": cfg.schema,
        "Content-Profile": cfg.schema,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Writes are best-effort: persistence is a debugging and audit aid, and a
 * Supabase outage must never stop a shopper from checking a price. Failures
 * are logged, not thrown.
 */
async function insert(table: string, rows: unknown[]): Promise<boolean> {
  if (rows.length === 0) return true;
  const res = await request(table, {
    method: "POST",
    body: JSON.stringify(rows),
    headers: { Prefer: "return=minimal" },
  });
  if (!res.ok) {
    console.warn(
      `[cartmatch] supabase_write_failed table=${table} status=${res.status} detail=${res.body.slice(0, 300)}`,
    );
  }
  return res.ok;
}

async function selectRecent<T>(table: string, limit: number): Promise<T[]> {
  const res = await request(
    `${table}?select=payload&order=created_at.desc&limit=${limit}`,
    { method: "GET" },
  );
  if (!res.ok) {
    console.warn(
      `[cartmatch] supabase_read_failed table=${table} status=${res.status} detail=${res.body.slice(0, 300)}`,
    );
    return [];
  }
  try {
    const rows = JSON.parse(res.body) as Array<{ payload: T }>;
    return rows.map((r) => r.payload).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Rows are stored as (id, created_at, payload jsonb). Keeping the domain object
 * whole in `payload` means adding a field to PriceObservation never needs a
 * migration, while the promoted columns keep the common queries indexable.
 */
export const supabaseStore = {
  async saveObservations(rows: PriceObservation[]): Promise<void> {
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
  },

  async recentObservations(limit: number): Promise<PriceObservation[]> {
    return selectRecent<PriceObservation>(TABLES.observations, limit);
  },

  async saveAudit(rows: AuditRecord[]): Promise<void> {
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
  },

  async recentAudit(limit: number): Promise<AuditRecord[]> {
    return selectRecent<AuditRecord>(TABLES.audit, limit);
  },

  async saveValidation(report: MatchValidationReport): Promise<void> {
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
  },

  async recentValidations(limit: number): Promise<MatchValidationReport[]> {
    return selectRecent<MatchValidationReport>(TABLES.validations, limit);
  },
};

/** Connectivity check surfaced on /admin so misconfiguration is visible. */
export async function supabaseHealth(): Promise<{
  configured: boolean;
  reachable: boolean;
  detail: string;
}> {
  const cfg = supabaseConfig();
  if (!cfg) {
    return {
      configured: false,
      reachable: false,
      detail:
        "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — using the local file store.",
    };
  }
  const res = await request(`${TABLES.audit}?select=id&limit=1`, {
    method: "GET",
  });
  if (res.ok) {
    return { configured: true, reachable: true, detail: "Connected." };
  }
  return {
    configured: true,
    reachable: false,
    detail:
      res.status === 404
        ? `Table "${TABLES.audit}" not found. Apply supabase/schema.sql to your project.`
        : `HTTP ${res.status}: ${res.body.slice(0, 200)}`,
  };
}
