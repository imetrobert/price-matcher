/**
 * GET /api/admin/audit — recent audit records and validation feedback.
 *
 * Development aid (spec §48, §49). Contains no personal data beyond the
 * postal code recorded on an observation.
 */

import { NextResponse } from "next/server";

import { recentAudit, recentObservations, validationSummary } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1),
    1000,
  );

  const [audit, observations, validation] = await Promise.all([
    recentAudit(limit),
    recentObservations(limit),
    validationSummary(),
  ]);

  return NextResponse.json({ ok: true, audit, observations, validation });
}
