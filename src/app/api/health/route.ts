/**
 * GET /api/health — adapter and configuration status.
 *
 * Used by the home screen and /admin so a developer can see, without reading
 * logs, exactly which retailers can and cannot be queried right now.
 */

import { NextResponse } from "next/server";

import { env, hasGeminiKey, hasGoogleSearch } from "@/config/env";
import { RETAILERS } from "@/config/retailers";
import { healthReport } from "@/services/retailers/registry";
import { visionProviderName } from "@/services/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const adapters = await healthReport();

  return NextResponse.json({
    ok: true,
    dataMode: env.dataMode,
    vision: {
      provider: visionProviderName(),
      geminiConfigured: hasGeminiKey(),
    },
    googleSearchConfigured: hasGoogleSearch(),
    retailers: Object.values(RETAILERS).map((r) => ({
      id: r.id,
      displayName: r.displayName,
      enabled: r.enabled,
      priceReliability: r.priceReliability,
      reliabilityNote: r.reliabilityNote,
    })),
    adapters,
  });
}
