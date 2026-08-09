/**
 * GET /api/health — adapter and configuration status.
 *
 * This endpoint is deliberately reachable without a session, because the
 * sign-in screen and any uptime monitor need it. That makes it the one public
 * surface on a deployed instance, so it answers in two tiers:
 *
 *   signed out — only what an unauthenticated caller legitimately needs:
 *                is the app up, is sign-in configured. Nothing about storage,
 *                keys, retailers or internal error text.
 *   signed in  — the full diagnostic payload used by the home screen and
 *                /admin.
 *
 * The signed-out shape is a strict subset, so a client can read the same
 * fields either way.
 */

import { NextResponse } from "next/server";

import { env, hasGeminiKey, hasGoogleSearch } from "@/config/env";
import { RETAILERS } from "@/config/retailers";
import { authConfigured, authRequired } from "@/lib/auth/config";
import { getSessionUser } from "@/lib/auth/server";
import { activeBackend, supabaseHealth } from "@/lib/store";
import { healthReport } from "@/services/retailers/registry";
import { visionProviderName } from "@/services/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();

  // When auth is not configured at all, there is no session to have and the
  // instance is local-development-only (the middleware refuses to serve an
  // unconfigured instance in production). Withholding diagnostics there would
  // only break the developer's own home screen.
  const restricted = authConfigured() && !user;

  // --- Public tier --------------------------------------------------------
  if (restricted) {
    return NextResponse.json({
      ok: true,
      auth: {
        configured: authConfigured(),
        required: authRequired(),
        email: null,
      },
    });
  }

  // --- Authenticated tier -------------------------------------------------
  const [adapters, storage] = await Promise.all([
    healthReport(),
    supabaseHealth(),
  ]);

  return NextResponse.json({
    ok: true,
    dataMode: env.dataMode,
    auth: {
      configured: authConfigured(),
      required: authRequired(),
      email: user?.email ?? null,
    },
    storage: {
      backend: activeBackend(),
      ...storage,
    },
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
