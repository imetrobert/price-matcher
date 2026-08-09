/**
 * Caller identification for the Edge Functions.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE SECURITY BOUNDARY
 * ---------------------------------------------------------------------------
 * On a static site the UI cannot protect anything — the bundle is public and
 * readable. So every function that spends money or touches data has to decide
 * for itself who is calling, from the JWT, on the server side. That decision
 * happens here.
 *
 * Two checks, both required:
 *   1. The JWT is valid and identifies a real Supabase user. Supabase verifies
 *      the signature before the function runs; we call getUser() to turn it
 *      into an identity and to reject an expired or revoked token.
 *   2. That user's email is on CARTMATCH_ALLOWED_EMAILS. Supabase Auth is
 *      project-scoped, so a valid token may belong to a user of a completely
 *      different app on the same project.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

export interface Caller {
  id: string;
  email: string | null;
}

export type AuthOutcome =
  | { ok: true; caller: Caller }
  | { ok: false; status: number; error: string };

export async function authenticate(req: Request): Promise<AuthOutcome> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing bearer token." };
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    return {
      ok: false,
      status: 500,
      error: "Edge Function is missing SUPABASE_URL / SUPABASE_ANON_KEY.",
    };
  }

  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return { ok: false, status: 401, error: "Invalid or expired session." };
  }

  const caller: Caller = { id: data.user.id, email: data.user.email ?? null };

  if (!emailAllowed(caller.email)) {
    return {
      ok: false,
      status: 403,
      error:
        "Your account is not authorised for CartMatch. Ask the owner to add your email to CARTMATCH_ALLOWED_EMAILS.",
    };
  }

  return { ok: true, caller };
}

/**
 * Unset admits any authenticated project user — matching the web app, and
 * chosen so a forgotten secret cannot lock the owner out of their own tool.
 * The app reports when it is unset rather than letting you assume otherwise.
 */
function emailAllowed(email: string | null): boolean {
  const raw = Deno.env.get("CARTMATCH_ALLOWED_EMAILS") ?? "";
  const list = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
  if (list.length === 0) return true;
  if (!email) return false;
  return list.includes(email.trim().toLowerCase());
}
