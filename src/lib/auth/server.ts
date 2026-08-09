/**
 * Server-side Supabase auth helpers (Server Components and Route Handlers).
 *
 * Anon key only — this reads the caller's session, it does not act with
 * elevated privileges. The service-role key lives in src/lib/store/supabase.ts
 * and is never used for auth.
 */

import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { authConfigured, emailAllowed, publicAuthConfig } from "@/lib/auth/config";

export async function createServerSupabase() {
  const cfg = publicAuthConfig();
  if (!cfg) return null;

  const cookieStore = await cookies();

  return createServerClient(cfg.url, cfg.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // The middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}

export interface SessionUser {
  id: string;
  email: string | null;
}

/**
 * The signed-in user, or null.
 *
 * Uses `getUser()` rather than `getSession()` on purpose: `getSession()` trusts
 * the cookie as-is, while `getUser()` revalidates the token with Supabase. On
 * a server route that decides whether to show someone else's data, the
 * revalidating call is the correct one.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const identity = await getSignedInIdentity();
  if (!identity) return null;

  // Defence in depth: the middleware already blocks non-allowlisted accounts,
  // but a route must not depend on the matcher pattern being right. A user who
  // is signed in but not admitted to this app is treated as no user at all.
  if (!emailAllowed(identity.email)) return null;

  return identity;
}

/**
 * Who is signed in to the Supabase PROJECT, regardless of whether they are
 * admitted to this app.
 *
 * Only for telling someone why they were turned away — never for authorising
 * anything. Use `getSessionUser()` for that.
 */
export async function getSignedInIdentity(): Promise<SessionUser | null> {
  if (!authConfigured()) return null;
  const supabase = await createServerSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
