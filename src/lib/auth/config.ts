/**
 * Auth configuration.
 *
 * ---------------------------------------------------------------------------
 * THE TWO SUPABASE KEYS ARE NOT INTERCHANGEABLE — READ THIS
 * ---------------------------------------------------------------------------
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` is *designed* to ship to the browser. It
 * carries no privileges of its own; every request it makes is evaluated
 * against Row Level Security as the signed-in user. Prefixing it
 * `NEXT_PUBLIC_` is correct and required — the login form runs client-side.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` (used by src/lib/store/supabase.ts) BYPASSES RLS
 * entirely. It must never be prefixed `NEXT_PUBLIC_`, never imported from a
 * Client Component, and never sent to the browser. Those two rules are the
 * whole security boundary of this app.
 *
 * Both keys come from the same Supabase project, which is the point: signing
 * in to CartMatch uses the same email and password as your other apps on that
 * project, because it is literally the same `auth.users` table.
 */

/** Values needed by both the browser and the server to talk to Supabase Auth. */
export interface PublicAuthConfig {
  url: string;
  anonKey: string;
}

/**
 * Read from `process.env` at module scope rather than via a helper, because
 * Next.js inlines `NEXT_PUBLIC_*` at build time only for statically analysable
 * references. A dynamic lookup like `process.env[name]` would silently produce
 * `undefined` in the browser bundle.
 */
export function publicAuthConfig(): PublicAuthConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function authConfigured(): boolean {
  return publicAuthConfig() !== null;
}

/**
 * When true, the app refuses to serve anything without a session, and fails
 * closed if auth is not configured.
 *
 * Defaults to true in production so a missing environment variable can never
 * silently expose a deployed instance, and false in development so the app
 * still runs with no keys at all.
 */
export function authRequired(): boolean {
  const explicit = (process.env.CARTMATCH_REQUIRE_AUTH ?? "").trim().toLowerCase();
  if (explicit === "true" || explicit === "1") return true;
  if (explicit === "false" || explicit === "0") return false;
  return process.env.NODE_ENV === "production";
}

/** Paths reachable without a session. Everything else requires one. */
export const PUBLIC_PATHS = [
  "/login",
  "/auth/callback",
  "/not-authorized",
  "/api/health",
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

// ---------------------------------------------------------------------------
// Per-app allowlist
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS
 *
 * Supabase Auth is scoped to a PROJECT, not to an app. When several apps share
 * one project — as they do here — they share one `auth.users` table, so a
 * valid session for any of them is a valid session for all of them. Adding a
 * contractor to a different app on the same project silently grants them this
 * one too, with no action and no signal.
 *
 * `CARTMATCH_ALLOWED_EMAILS` decouples them: membership of the project becomes
 * necessary but not sufficient, and access to CartMatch becomes a deliberate
 * act.
 *
 * When UNSET, every confirmed project user is admitted — the original
 * behaviour, kept so that a forgotten variable cannot lock you out of your own
 * app. That default is reported by /api/health and shown in the UI, because a
 * silently-inactive access control is worse than none.
 */
export function allowedEmails(): string[] {
  const raw = process.env.CARTMATCH_ALLOWED_EMAILS ?? "";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
}

/** True when an allowlist is configured and therefore being enforced. */
export function allowlistActive(): boolean {
  return allowedEmails().length > 0;
}

/**
 * Is this email admitted to CartMatch specifically?
 *
 * Compared case-insensitively against the address Supabase verified, not
 * anything the client supplied.
 */
export function emailAllowed(email: string | null | undefined): boolean {
  if (!allowlistActive()) return true;
  if (!email) return false;
  return allowedEmails().includes(email.trim().toLowerCase());
}
