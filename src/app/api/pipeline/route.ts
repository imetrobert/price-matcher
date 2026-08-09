/**
 * POST /api/pipeline — confirmed cart items -> verified savings opportunities.
 *
 * The client sends product attributes (never a canonical id it made up) plus
 * an optional manually entered shelf price. Normalization, matching, price
 * lookup, verification and arithmetic all happen server-side.
 */

import { NextResponse } from "next/server";

import { SAVINGS } from "@/config/thresholds";
import { isRetailerId } from "@/config/retailers";
import { isInSupportedRegion, normalizePostalCode, unsupportedRegionMessage } from "@/lib/region";
import { buildCanonicalProduct } from "@/services/products/normalize";
import { runPipeline, type PipelineItem } from "@/services/pipeline/run";
import type { StoreContext } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IncomingItem {
  brand?: unknown;
  productName?: unknown;
  variant?: unknown;
  fatPercentage?: unknown;
  size?: unknown;
  packageQuantity?: unknown;
  visibleUpc?: unknown;
  manualCurrentPriceCents?: unknown;
}

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

  const body = payload as {
    retailerId?: unknown;
    storeId?: unknown;
    postalCode?: unknown;
    thresholdCents?: unknown;
    items?: unknown;
  };

  if (typeof body.retailerId !== "string" || !isRetailerId(body.retailerId)) {
    return NextResponse.json(
      { ok: false, error: "Select the store you are shopping at." },
      { status: 400 },
    );
  }

  const postal = normalizePostalCode(String(body.postalCode ?? ""));
  if (!postal) {
    return NextResponse.json(
      { ok: false, error: "A valid Canadian postal code is required." },
      { status: 400 },
    );
  }
  if (!isInSupportedRegion(postal)) {
    return NextResponse.json(
      { ok: false, error: unsupportedRegionMessage(postal) },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No confirmed cart items were supplied." },
      { status: 400 },
    );
  }

  const items: PipelineItem[] = [];
  for (const raw of body.items as IncomingItem[]) {
    const brand = str(raw.brand);
    const name = str(raw.productName);
    if (!brand && !name) continue;

    items.push({
      canonical: buildCanonicalProduct({
        brand: brand ?? "",
        name: name ?? "",
        variant: str(raw.variant),
        fatPercentage: str(raw.fatPercentage),
        size: str(raw.size),
        packageCount: num(raw.packageQuantity),
        gtin: str(raw.visibleUpc),
        identitySource: str(raw.visibleUpc) ? "VISIBLE_BARCODE" : "USER_ENTERED",
      }),
      manualCurrentPriceCents: num(raw.manualCurrentPriceCents),
    });
  }

  if (items.length === 0) {
    return NextResponse.json(
      { ok: false, error: "None of the supplied items had a brand or name." },
      { status: 400 },
    );
  }

  const storeContext: StoreContext = {
    retailerId: body.retailerId,
    storeId: typeof body.storeId === "string" && body.storeId ? body.storeId : null,
    storeName: null,
    postalCode: postal,
    capturedAt: new Date().toISOString(),
  };

  const thresholdCents =
    typeof body.thresholdCents === "number" && body.thresholdCents >= 0
      ? Math.trunc(body.thresholdCents)
      : SAVINGS.defaultThresholdCents;

  try {
    const result = await runPipeline({ items, storeContext, thresholdCents });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `Comparison failed: ${message}` },
      { status: 500 },
    );
  }
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function num(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}
