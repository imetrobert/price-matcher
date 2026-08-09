"use client";

/**
 * Vision entry point (browser).
 *
 * Real recognition is a call to the `vision` Supabase Edge Function, which
 * holds GEMINI_API_KEY. The browser never sees that key — on a static site it
 * could not hold one safely, and this repository is public besides.
 *
 * The Edge Function returns Gemini's raw JSON; validation and normalisation
 * happen here with the same `parseVisionResponse` the mock path uses, so there
 * is exactly one implementation of that logic and one place to test it.
 */

import { edgeFunctionUrl, env, supabaseConfigured, visionProviderName } from "@/config/env";
import { getAccessToken } from "@/lib/auth/session";
import { mockRecognizeCart } from "@/services/vision/mock";
import { parseVisionResponse } from "@/services/vision/schema";
import type { DetectedProduct } from "@/types";

export { visionProviderName };

export interface VisionImage {
  /** Base64 without the data: URL prefix. */
  base64: string;
  mimeType: string;
}

export type VisionErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_SIGNED_IN"
  | "NO_IMAGES"
  | "API_ERROR"
  | "BAD_RESPONSE";

export type VisionOutcome =
  | { ok: true; products: DetectedProduct[]; isMock: boolean; note: string }
  | { ok: false; error: string; code: VisionErrorCode };

export async function analyzeCartPhotos(
  images: VisionImage[],
): Promise<VisionOutcome> {
  if (images.length === 0) {
    return { ok: false, code: "NO_IMAGES", error: "No images supplied." };
  }

  // In MOCK mode use fixtures even when everything is configured, so a mock
  // run is reproducible and costs nothing.
  if (env.dataMode === "MOCK") {
    return mockRecognizeCart(images, { reason: "NEXT_PUBLIC_CARTMATCH_DATA_MODE=MOCK" });
  }

  if (!supabaseConfigured()) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      error:
        "Supabase is not configured, so photo recognition is unavailable. Use Manual Product Test instead.",
    };
  }

  const token = await getAccessToken();
  if (!token) {
    return {
      ok: false,
      code: "NOT_SIGNED_IN",
      error: "Sign in before scanning — photo recognition requires a session.",
    };
  }

  try {
    // Named for this app, not for what it does: the Supabase project is shared
    // with other apps, and a function called "vision" is exactly the name
    // another one would pick — deploying would silently overwrite it.
    const res = await fetch(edgeFunctionUrl("cartmatch-vision"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // What the Edge Function actually authenticates on.
        Authorization: `Bearer ${token}`,
        apikey: env.supabaseAnonKey,
      },
      body: JSON.stringify({ images }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        code: res.status === 401 || res.status === 403 ? "NOT_SIGNED_IN" : "API_ERROR",
        error:
          data?.error ??
          `Recognition failed (HTTP ${res.status}). Check that the vision Edge Function is deployed.`,
      };
    }

    const products = parseVisionResponse(data.raw, { isMock: false });
    return {
      ok: true,
      products,
      isMock: false,
      note: `Recognized by ${data.model ?? "Gemini"} via Supabase Edge Function.`,
    };
  } catch (err) {
    return {
      ok: false,
      code: "API_ERROR",
      error: err instanceof Error ? err.message : "Recognition request failed.",
    };
  }
}
