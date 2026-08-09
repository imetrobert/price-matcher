/**
 * Minimal file-backed persistence for the MVP.
 *
 * Why not SQLite/Postgres: the only things that need to outlive a request are
 * the audit trail, price observations and validation feedback — all
 * append-only, low volume, and read by a single developer on an admin page.
 * A JSON-lines file needs no native module, no daemon and no migration story.
 *
 * Everything goes through this narrow interface, so swapping in a real
 * database later means replacing this file and nothing else.
 *
 * No user photographs and no personal data are written here — postal code is
 * the only location detail stored, and only inside audit records.
 */

import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import { env } from "@/config/env";
import type { AuditRecord, MatchValidationReport, PriceObservation } from "@/types";

type Collection = "observations" | "audit" | "validations";

function fileFor(collection: Collection): string {
  return path.join(process.cwd(), env.dataDir, `${collection}.jsonl`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(path.join(process.cwd(), env.dataDir), { recursive: true });
}

async function append<T>(collection: Collection, row: T): Promise<void> {
  try {
    await ensureDir();
    await fs.appendFile(fileFor(collection), `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    // Persistence is a debugging aid, never load-bearing for a user request.
    // A read-only filesystem must not break price checking.
  }
}

async function readAll<T>(collection: Collection, limit: number): Promise<T[]> {
  try {
    const raw = await fs.readFile(fileFor(collection), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const tail = lines.slice(-limit);
    const out: T[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // Skip corrupt lines rather than failing the whole read.
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

// --- Price observations -----------------------------------------------------

export async function saveObservations(
  rows: PriceObservation[],
): Promise<void> {
  for (const row of rows) await append("observations", row);
}

export async function recentObservations(
  limit = 500,
): Promise<PriceObservation[]> {
  return readAll<PriceObservation>("observations", limit);
}

// --- Audit trail ------------------------------------------------------------

export async function saveAudit(rows: AuditRecord[]): Promise<void> {
  for (const row of rows) await append("audit", row);
}

export async function recentAudit(limit = 500): Promise<AuditRecord[]> {
  return readAll<AuditRecord>("audit", limit);
}

// --- Real-world validation feedback ----------------------------------------

export async function saveValidation(
  report: MatchValidationReport,
): Promise<void> {
  await append("validations", report);
}

export async function recentValidations(
  limit = 200,
): Promise<MatchValidationReport[]> {
  return readAll<MatchValidationReport>("validations", limit);
}

/** Aggregate feedback per retailer — the input to a future reliability rating. */
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
