/**
 * POST /api/validate — "Verify This Match" feedback (spec §55).
 *
 * Records what actually happened in the store so retailer reliability can
 * eventually be based on measured outcomes instead of assumptions.
 */

import { NextResponse } from "next/server";

import { isRetailerId } from "@/config/retailers";
import { saveValidation } from "@/lib/store";
import type { MatchValidationReport } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const b = payload as Record<string, unknown>;

  if (
    typeof b.retailerId !== "string" ||
    !isRetailerId(b.retailerId) ||
    typeof b.competitorRetailerId !== "string" ||
    !isRetailerId(b.competitorRetailerId)
  ) {
    return NextResponse.json(
      { ok: false, error: "Both retailer ids are required." },
      { status: 400 },
    );
  }

  const report: MatchValidationReport = {
    id: `val-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    opportunityId: typeof b.opportunityId === "string" ? b.opportunityId : "",
    retailerId: b.retailerId,
    competitorRetailerId: b.competitorRetailerId,
    pageExisted: tri(b.pageExisted),
    exactProductMatched: tri(b.exactProductMatched),
    priceMatched: tri(b.priceMatched),
    itemAvailable: tri(b.itemAvailable),
    cashierAcceptedPrice: tri(b.cashierAcceptedPrice),
    priceMatchRequestAccepted: tri(b.priceMatchRequestAccepted),
    notes: typeof b.notes === "string" ? b.notes.slice(0, 2000) : "",
    recordedAt: new Date().toISOString(),
  };

  await saveValidation(report);
  return NextResponse.json({ ok: true, id: report.id });
}

function tri(v: unknown): boolean | null {
  if (v === true) return true;
  if (v === false) return false;
  return null;
}
