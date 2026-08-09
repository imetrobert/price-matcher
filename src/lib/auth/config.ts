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
 *   - The cartmatch-vision Edge Function verifies the JWT and calls
 *     has_app_access('cartmatch') before spending a Gemini call.
 *   - Row Level Security applies the same has_app_access check to every row.
 *
 * Both read public.app_access. So does the function below. One source of truth,
 * queried from three places, rather than three lists to keep in step.
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
