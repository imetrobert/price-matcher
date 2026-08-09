/**
 * Auth configuration, client-side.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TREATING ANYTHING HERE AS A SECURITY CONTROL
 * ---------------------------------------------------------------------------
 * On a static site, nothing in the browser protects anything. The bundle is
 * downloadable, the repository is public, and a determined person can read or
 * skip any check in this file. The allowlist below is a UX affordance: it
 * tells someone they are not set up for this app instead of showing them a
 * broken screen.
 *
 * The REAL boundary is elsewhere, and it is enforced by servers:
 *   - Supabase Edge Functions verify the JWT and re-check the allowlist before
 *     spending a Gemini call (supabase/functions/_shared/auth.ts).
 *   - Supabase Row Level Security decides what rows the session may read or
 *     write, enforced by Postgres.
 *
 * Change the allowlist here and you change what the UI shows. Change it in the
 * Edge Function secrets and you change what is actually permitted. Keep the
 * two in step — DEPLOY.md says so in both places.
 */

import { env, supabaseConfigured } from "@/config/env";

export interface PublicAuthConfig {
  url: string;
  anonKey: string;
}

export function publicAuthConfig(): PublicAuthConfig | null {
  if (!supabaseConfigured()) return null;
  return { url: env.supabaseUrl, anonKey: env.supabaseAnonKey };
}

export function authConfigured(): boolean {
  return supabaseConfigured();
}

// ---------------------------------------------------------------------------
// Per-app allowlist (display only — see the header)
// ---------------------------------------------------------------------------

/**
 * Supabase Auth is scoped to a PROJECT, not an app. Several apps sharing one
 * project share one `auth.users` table, so a valid session for any of them is
 * a valid session here. This list keeps CartMatch's membership separate.
 *
 * Unset admits every project user, so a forgotten variable cannot lock the
 * owner out. The app reports that state rather than letting you assume
 * otherwise.
 */
export function allowedEmails(): string[] {
  const raw = process.env.NEXT_PUBLIC_CARTMATCH_ALLOWED_EMAILS ?? "";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
}

export function allowlistActive(): boolean {
  return allowedEmails().length > 0;
}

export function emailAllowed(email: string | null | undefined): boolean {
  if (!allowlistActive()) return true;
  if (!email) return false;
  return allowedEmails().includes(email.trim().toLowerCase());
}
