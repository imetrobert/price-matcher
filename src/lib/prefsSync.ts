"use client";

/**
 * Preference sync between this device and your account.
 *
 * ---------------------------------------------------------------------------
 * LOCAL IS THE SOURCE OF TRUTH WHILE YOU USE THE APP
 * ---------------------------------------------------------------------------
 * `localStorage` stays the thing every screen reads. The server copy exists so
 * a new device starts with your postal code already filled in, not so that
 * opening the app waits on a network round trip. You are often standing in a
 * shop on poor wifi; a settings screen that blocks on Supabase would be worse
 * than one that occasionally lags a change made on another device.
 *
 * So: read local immediately, fetch the remote in the background, and adopt it
 * only when local has nothing. Writes go to both.
 *
 * ---------------------------------------------------------------------------
 * WHY LOCAL WINS A CONFLICT
 * ---------------------------------------------------------------------------
 * If both copies exist and differ, local wins and is pushed up. The person
 * holding this phone just told this device something; a value typed on a
 * laptop last week should not silently overwrite it. This is a one-user
 * setting, not collaborative state — the simple rule is the right one, and
 * last-write-wins across devices is exactly what someone would expect.
 */

import { createClient } from "@/lib/auth/client";
import { supabaseConfigured } from "@/config/env";
import { loadPrefs, savePrefs } from "@/lib/prefs";
import type { UserPreferences } from "@/types";

const TABLE = "cartmatch_user_prefs";

/**
 * Fetch the account's saved preferences.
 *
 * Returns null for "nothing saved" AND for "could not ask" — deliberately.
 * Every caller's response to both is identical: carry on with local values.
 * Distinguishing them would only invite someone to show an error for a state
 * that needs no action.
 */
export async function fetchRemotePrefs(): Promise<Partial<UserPreferences> | null> {
  if (!supabaseConfigured()) return null;
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from(TABLE)
      .select("postal_code, language, min_savings_cents")
      .maybeSingle();

    if (error || !data) return null;

    return {
      postalCode: typeof data.postal_code === "string" ? data.postal_code : "",
      language: data.language === "fr" ? "fr" : "en",
      minSavingsCents:
        typeof data.min_savings_cents === "number"
          ? data.min_savings_cents
          : undefined,
    } as Partial<UserPreferences>;
  } catch {
    return null;
  }
}

/**
 * Push preferences to the account. Best-effort by design.
 *
 * A failed sync must never block saving settings on this device — the app
 * still works entirely offline. It logs instead, because a silent failure that
 * is also invisible in the console is the kind you discover months later on a
 * new phone.
 */
export async function pushRemotePrefs(prefs: UserPreferences): Promise<void> {
  if (!supabaseConfigured()) return;
  try {
    const supabase = createClient();
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId) return;

    // Upsert on the primary key. user_id is set explicitly rather than left to
    // the column default, for the same reason as everywhere else: correctness
    // should not depend on a default nobody looks at.
    const { error } = await supabase.from(TABLE).upsert(
      {
        user_id: userId,
        postal_code: prefs.postalCode || null,
        language: prefs.language,
        min_savings_cents: prefs.minSavingsCents,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

    if (error) {
      console.warn(
        `[cartmatch] prefs sync failed code=${error.code} message=${error.message}`,
      );
    }
  } catch (err) {
    console.warn("[cartmatch] prefs sync threw", err);
  }
}

/**
 * Reconcile on load. Returns the preferences to use now.
 *
 * Three cases, and the middle one is the point of the whole feature:
 *   - local has a postal code  -> keep it, push it up (this device is current)
 *   - local is empty, remote is not -> adopt remote (new device, nothing typed)
 *   - both empty -> local, and the user is asked once
 */
export async function reconcilePrefs(): Promise<UserPreferences> {
  const local = loadPrefs();
  const remote = await fetchRemotePrefs();

  if (local.postalCode.trim() !== "") {
    if (remote?.postalCode !== local.postalCode) void pushRemotePrefs(local);
    return local;
  }

  if (remote?.postalCode) {
    const merged: UserPreferences = {
      ...local,
      postalCode: remote.postalCode,
      language: remote.language ?? local.language,
      minSavingsCents: remote.minSavingsCents ?? local.minSavingsCents,
    };
    savePrefs(merged);
    return merged;
  }

  return local;
}
