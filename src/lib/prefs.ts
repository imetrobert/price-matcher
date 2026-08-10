"use client";

/**
 * User preferences, stored in localStorage only.
 *
 * Privacy (spec §50): postal code is the only location detail kept, and it
 * never leaves the device except as part of a price query. No account, no
 * identifiers, no photo retention.
 */

import { SAVINGS } from "@/config/thresholds";
import type { RetailerId, UserPreferences } from "@/types";

const KEY = "cartmatch.prefs.v1";

export const DEFAULT_PREFS: UserPreferences = {
  postalCode: "",
  language: "en",
  minSavingsCents: SAVINGS.defaultThresholdCents,
  currentRetailerId: null,
  currentStoreId: null,
};

export function loadPrefs(): UserPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    return {
      postalCode:
        typeof parsed.postalCode === "string" ? parsed.postalCode : "",
      language: parsed.language === "fr" ? "fr" : "en",
      minSavingsCents:
        typeof parsed.minSavingsCents === "number" && parsed.minSavingsCents >= 0
          ? parsed.minSavingsCents
          : SAVINGS.defaultThresholdCents,
      currentRetailerId: (parsed.currentRetailerId ?? null) as RetailerId | null,
      currentStoreId:
        typeof parsed.currentStoreId === "string" ? parsed.currentStoreId : null,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: UserPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private browsing / quota — preferences simply do not persist.
  }
}

export function updatePrefs(patch: Partial<UserPreferences>): UserPreferences {
  const next = { ...loadPrefs(), ...patch };
  savePrefs(next);
  return next;
}

export function prefsAreComplete(p: UserPreferences): boolean {
  return p.postalCode.trim() !== "";
}

// --- Last pipeline result, shared between /scan and /checkout ---------------

const RESULT_KEY = "cartmatch.lastResult.v1";

export function saveLastResult(result: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(RESULT_KEY, JSON.stringify(result));
  } catch {
    // Result too large or storage unavailable; Checkout Mode will ask the
    // user to re-run rather than showing anything stale.
  }
}

export function loadLastResult<T>(): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(RESULT_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function clearLastResult(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(RESULT_KEY);
  } catch {
    /* ignore */
  }
}
