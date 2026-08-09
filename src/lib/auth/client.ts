"use client";

/**
 * Browser-side Supabase client for the login form.
 *
 * Uses the anon key only. Sessions are stored in cookies (not localStorage) so
 * the Next.js middleware and Server Components can read them on the same
 * request — that is what `@supabase/ssr` buys over the plain JS client.
 */

import { createBrowserClient } from "@supabase/ssr";

import { publicAuthConfig } from "@/lib/auth/config";

export function createClient() {
  const cfg = publicAuthConfig();
  if (!cfg) {
    throw new Error(
      "Supabase auth is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }
  return createBrowserClient(cfg.url, cfg.anonKey);
}
