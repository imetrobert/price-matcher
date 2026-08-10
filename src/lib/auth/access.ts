"use client";

/**
 * Per-app access, read from the database.
 *
 * ---------------------------------------------------------------------------
 * NOT A SECURITY CONTROL
 * ---------------------------------------------------------------------------
 * This runs in the browser, on a static site, from a public repository. Anyone
 * can read it and skip it. It exists so a person without a grant sees a clear
 * explanation instead of an app that loads and then fails at everything.
 *
 * The same question is asked where it counts, and cannot be edited by the
 * person it is about:
 *   - Row Level Security calls has_app_access('cartmatch') on every row.
 *   - The cartmatch-vision Edge Function calls it before spending a Gemini call.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED AN EMAIL LIST
 * ---------------------------------------------------------------------------
 * Access used to be a comma-separated build variable, duplicated into the Edge
 * Function's secrets. Two copies of one fact, kept in step by hand: granting
 * access meant editing both and redeploying, and forgetting either produced a
 * sign-in that worked followed by a 403 on every scan — with nothing on screen
 * connecting the two.
 *
 * public.app_access is now the only answer. A grant is one INSERT and takes
 * effect on the next page load.
 *
 * Lives in its own module rather than config.ts because the Supabase client
 * reads its keys FROM config.ts, and the cycle that creates is the kind that
 * works until the day an import order changes.
 */

import { supabaseConfigured } from "@/config/env";
import { createClient } from "@/lib/auth/client";

/** This app's key in public.app_access. */
export const APP_NAME = "cartmatch";

export type AccessCheck =
  | { status: "granted"; role: string }
  | { status: "denied" }
  /**
   * The check itself failed. Deliberately distinct from "denied": callers must
   * not collapse the two. Telling someone they lack access when the access
   * model simply is not deployed sends them to ask for a grant they already
   * have, and silently treating it as granted would be worse.
   */
  | { status: "unavailable"; reason: string };

export async function checkAppAccess(): Promise<AccessCheck> {
  if (!supabaseConfigured()) {
    return { status: "unavailable", reason: "Supabase is not configured." };
  }
  try {
    const supabase = createClient();

    // Asked as the signed-in caller. has_app_access is SECURITY DEFINER and
    // resolves app_access for whoever executes it, so the browser's own session
    // is what makes this answer about them — there is no user id to pass, and
    // no way to ask about somebody else.
    const { data: granted, error } = await supabase.rpc("has_app_access", {
      app_name: APP_NAME,
    });
    if (error) return { status: "unavailable", reason: error.message };
    if (granted !== true) return { status: "denied" };

    // Only meaningful once access is confirmed; a failure here is not a reason
    // to deny someone, so it degrades to 'member' rather than propagating.
    const { data: role } = await supabase.rpc("app_role", {
      app_name: APP_NAME,
    });
    return { status: "granted", role: typeof role === "string" ? role : "member" };
  } catch (err) {
    return {
      status: "unavailable",
      reason: err instanceof Error ? err.message : "Access check failed.",
    };
  }
}
