/**
 * Server-only environment access.
 *
 * Nothing in this module may be imported from a Client Component. Values are
 * read lazily from process.env so that a missing key is a runtime "feature
 * unavailable" rather than a build failure.
 */

import "server-only";

import type { DataMode } from "@/types";

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;
}

function bool(name: string, fallback = false): boolean {
  const v = str(name);
  if (v === "") return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(str(name), 10);
  return Number.isFinite(v) ? v : fallback;
}

export const env = {
  get geminiApiKey(): string {
    return str("GEMINI_API_KEY");
  },
  get geminiModel(): string {
    return str("GEMINI_MODEL", "gemini-2.5-flash");
  },
  /**
   * Thinking budget for the 2.5+ series, in tokens. `0` disables thinking.
   *
   * Cart recognition is an extraction task — read what is on the packages —
   * not a reasoning one, and the shopper is standing in a store waiting. So
   * the default is 0: spend the latency budget on the answer, not on
   * deliberation. Raise it if you find the model misreading cluttered carts.
   */
  get geminiThinkingBudget(): number {
    const raw = str("GEMINI_THINKING_BUDGET");
    if (raw === "") return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  },
  get googleSearchApiKey(): string {
    return str("GOOGLE_SEARCH_API_KEY");
  },
  get googleSearchEngineId(): string {
    return str("GOOGLE_SEARCH_ENGINE_ID");
  },
  get dataMode(): DataMode {
    return str("CARTMATCH_DATA_MODE", "MOCK").toUpperCase() === "LIVE"
      ? "LIVE"
      : "MOCK";
  },
  get retailerFetchTimeoutMs(): number {
    return int("RETAILER_FETCH_TIMEOUT_MS", 12_000);
  },
  get persistPhotos(): boolean {
    return bool("CARTMATCH_PERSIST_PHOTOS", false);
  },
  get dataDir(): string {
    return str("CARTMATCH_DATA_DIR", ".data");
  },
} as const;

/** True when real vision is possible. Drives the MOCK banner in the UI. */
export function hasGeminiKey(): boolean {
  return env.geminiApiKey !== "";
}

export function hasGoogleSearch(): boolean {
  return env.googleSearchApiKey !== "" && env.googleSearchEngineId !== "";
}
