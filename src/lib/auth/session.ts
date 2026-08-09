"use client";

/**
 * Client-side session access.
 *
 * Returns the current Supabase session, the caller's identity, and the access
 * token that Edge Functions use to authenticate the request. The token is the
 * only part that matters for security — everything else here is for rendering.
 */

import { createClient } from "@/lib/auth/client";
import { authConfigured } from "@/lib/auth/config";

export interface SessionUser {
  id: string;
  email: string | null;
}

export interface SessionState {
  user: SessionUser | null;
  accessToken: string | null;
  /** False until the first check completes, so the UI can avoid flashing. */
  ready: boolean;
}

export async function getSession(): Promise<SessionState> {
  if (!authConfigured()) {
    return { user: null, accessToken: null, ready: true };
  }
  try {
    const supabase = createClient();
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) {
      return { user: null, accessToken: null, ready: true };
    }
    const u = data.session.user;
    return {
      user: { id: u.id, email: u.email ?? null },
      accessToken: data.session.access_token,
      ready: true,
    };
  } catch {
    return { user: null, accessToken: null, ready: true };
  }
}

export async function signOut(): Promise<void> {
  if (!authConfigured()) return;
  try {
    const supabase = createClient();
    await supabase.auth.signOut();
  } catch {
    // Already signed out, or storage unavailable.
  }
}

/**
 * Access token for an Edge Function call.
 *
 * Returns null when signed out, which callers must treat as "do not call" —
 * the function would reject it anyway, but failing here saves a round trip and
 * gives a better message.
 */
export async function getAccessToken(): Promise<string | null> {
  const s = await getSession();
  return s.accessToken;
}
