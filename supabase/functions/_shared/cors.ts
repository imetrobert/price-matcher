/**
 * CORS for the Edge Functions.
 *
 * The static site lives on a different origin from Supabase, so every function
 * needs these headers and an OPTIONS preflight handler.
 *
 * ALLOWED_ORIGINS is an explicit allowlist rather than `*`. These endpoints
 * spend your Gemini quota and act on an authenticated session, so it is worth
 * naming who may call them from a browser. It is not a security boundary on
 * its own — CORS is enforced by browsers, not by attackers with curl — the JWT
 * check is what actually protects the function. This just stops a random page
 * on the internet from silently burning your quota through a visitor's
 * session.
 *
 * Set CARTMATCH_ALLOWED_ORIGINS as a Supabase secret, comma-separated:
 *   supabase secrets set CARTMATCH_ALLOWED_ORIGINS=https://pricecheck.imetrobert.com
 */

const DEFAULT_ORIGINS = ["http://localhost:3000"];

function allowedOrigins(): string[] {
  const raw = Deno.env.get("CARTMATCH_ALLOWED_ORIGINS") ?? "";
  const configured = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");
  return configured.length > 0
    ? [...configured, ...DEFAULT_ORIGINS]
    : DEFAULT_ORIGINS;
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = allowedOrigins();
  // Echo the origin only when it is on the list; never reflect an arbitrary one.
  const value = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": value,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", {
    headers: corsHeaders(req.headers.get("origin")),
  });
}

export function json(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
