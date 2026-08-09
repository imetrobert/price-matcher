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
  if (env.dataMode === "MOCK") return "MOCK (fixtures)";
  return supabaseConfigured()
    ? "Gemini via Supabase Edge Function"
    : "unavailable (Supabase not configured)";
}
