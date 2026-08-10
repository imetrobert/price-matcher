/**
 * Configuration available to the browser.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING HERE IS PUBLIC. THAT IS THE POINT.
 * ---------------------------------------------------------------------------
 * This is a static site: the bundle is downloadable and the repository is
 * public, so anything read here is world-readable. Only values that are
 * harmless in the open belong in this file, and every one is prefixed
 * `NEXT_PUBLIC_` so that is impossible to forget.
 *
 * Secrets — the Gemini key, the Supabase secret key — live in Supabase Edge
 * Function secrets and are never referenced from this codebase's client
 * bundle. If you find yourself wanting to add one here, it belongs in an Edge
 * Function instead.
 *
 * Next.js inlines `NEXT_PUBLIC_*` at BUILD time, and only for statically
 * analysable references. Each one is written out in full below; a dynamic
 * lookup like `process.env[name]` would silently be `undefined` in the
 * browser.
 */

import type { DataMode } from "@/types";

export const env = {
  /** Supabase project URL. Public. */
  get supabaseUrl(): string {
    return process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  },
  /** Publishable (formerly "anon") key. Designed to be public; RLS gates it. */
  get supabaseAnonKey(): string {
    return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  },
  /**
   * Retailer PRICE data only.
   *
   * MOCK serves fixtures, labelled as such everywhere.
   * LIVE permits only real adapters — which today means "no prices", because
   * no retailer adapter is implemented.
   */
  get dataMode(): DataMode {
    return (process.env.NEXT_PUBLIC_CARTMATCH_DATA_MODE ?? "MOCK").toUpperCase() ===
      "LIVE"
      ? "LIVE"
      : "MOCK";
  },

  /**
   * Photo recognition, decided SEPARATELY from prices.
   *
   * These were one flag, and that was wrong: it meant the only way to use real
   * cart recognition was to also demand real retailer prices, which do not
   * exist. So a working Gemini deployment sat unused behind MOCK, handing back
   * fixture products that had nothing to do with the photo just taken — in a
   * shop, that is worse than an error, because it looks like an answer.
   *
   * They are not the same decision. Recognition is real and works today;
   * retailer integration does not exist. The default reflects that: if a
   * Supabase project is configured there is an Edge Function to call, so call
   * it. Set NEXT_PUBLIC_CARTMATCH_VISION_MODE=MOCK to force fixtures — useful
   * for UI work, and for a reproducible run that costs no quota.
   *
   * Mock PRICES stay mock either way. Recognising a real product never makes a
   * fixture price real, and nothing mock-priced can reach Checkout Mode.
   */
  get visionMode(): DataMode {
    const explicit = process.env.NEXT_PUBLIC_CARTMATCH_VISION_MODE;
    if (explicit) return explicit.toUpperCase() === "LIVE" ? "LIVE" : "MOCK";
    return supabaseConfigured() ? "LIVE" : "MOCK";
  },
} as const;

/** Is the Supabase project configured at all? */
export function supabaseConfigured(): boolean {
  return env.supabaseUrl !== "" && env.supabaseAnonKey !== "";
}

/**
 * URL of a deployed Edge Function.
 *
 * Derived from the project URL rather than configured separately, so there is
 * one fewer value to get wrong.
 */
export function edgeFunctionUrl(name: string): string {
  const base = env.supabaseUrl.replace(/\/+$/, "");
  return `${base}/functions/v1/${name}`;
}

/**
 * Whether photo recognition is even possible.
 *
 * The browser cannot know if GEMINI_API_KEY is set on the Edge Function — that
 * is the whole point of it being a secret. It can only know whether there is a
 * function to call. A missing key surfaces as a clear 503 from the function
 * itself, not as a guess made here.
 */
export function visionAvailable(): boolean {
  return supabaseConfigured();
}

export function visionProviderName(): string {
  if (env.visionMode === "MOCK") {
    return supabaseConfigured() ? "MOCK (forced by env)" : "MOCK (fixtures)";
  }
  return supabaseConfigured()
    ? "Gemini via cartmatch-vision Edge Function"
    : "unavailable (Supabase not configured)";
}
