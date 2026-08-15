/**
 * POST /functions/v1/cartmatch-flyer-fetch
 *
 *   { url } -> { ok, filename, bytes, base64 }
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The weekly import asks somebody to download six PDFs and hand them back to
 * the app. Half of that is pointless: they already have the link. But this site
 * is a static export, so the browser would have to fetch the PDF itself, and
 * cross-origin fetches of a flyer host are refused — no CORS headers, no bytes.
 * The fetch has to happen somewhere with no browser sitting on it, which is
 * here.
 *
 * ---------------------------------------------------------------------------
 * THIS FETCHES A CLIENT-SUPPLIED URL. READ BEFORE CHANGING IT.
 * ---------------------------------------------------------------------------
 * The same warning as cartmatch-retailer, and for the same reason: a function
 * that fetches whatever URL it is handed runs inside Supabase's network, where
 * localhost, 169.254.169.254 and every internal service are reachable even
 * though the caller cannot reach them. That is the whole value of the attack,
 * and requiring a signed-in account changes who can ask, not what can be
 * reached.
 *
 * The rules live in `_shared/pdfUrl.ts` because they are testable there and
 * they are tested. What is enforced here and cannot move:
 *
 *   EVERY HOP IS CHECKED. Redirects are followed by hand, and each one goes
 *   through the same rules as the URL that was typed. `redirect: "follow"`
 *   would let an allowed host bounce the request anywhere it liked, silently.
 *
 *   ADMIN WIDENS THE HOST LIST AND NOTHING ELSE. Loopback, link-local and
 *   private ranges stay refused for everybody. An admin exception exists to
 *   reach a flyer on a host nobody listed, not to reach the inside of the
 *   machine doing the fetching.
 *
 *   THE BYTES ARE CHECKED, NOT THE CONTENT-TYPE. A header is a claim. A PDF
 *   starts "%PDF-".
 *
 *   SIZE IS CAPPED BEFORE THE BODY IS READ, then again while reading it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not discover, crawl, search or follow links, and it holds no list of
 * flyer URLs to poll. It fetches one document a person pasted, which is the
 * same document that person could have downloaded by clicking the link. Making
 * it walk a site looking for flyers would be a different act with different
 * obligations to the sites involved.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  MAX_PDF_BYTES,
  checkPdfUrl,
  filenameFromUrl,
  looksLikePdf,
} from "../_shared/pdfUrl.ts";

export const FUNCTION_BUILD = "2026-08-15-flyer-fetch-1";

/** Long enough for a slow blob host, short enough not to hang the screen. */
const TIMEOUT_MS = 60_000;

/** How many redirects to follow before concluding it is a loop. */
const MAX_HOPS = 5;

// ===========================================================================
// SECTION 1 — CORS  (identical to the other functions)
// ===========================================================================

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

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = allowedOrigins();
  const value = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": value,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders(req.headers.get("origin")) });
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

// ===========================================================================
// SECTION 2 — THE SECURITY BOUNDARY
// ===========================================================================

type AuthOutcome =
  | { ok: true; isAdmin: boolean }
  | { ok: false; status: number; error: string };

async function authenticate(req: Request): Promise<AuthOutcome> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing bearer token." };
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey =
    Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
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

  const { data: granted, error: rpcError } = await supabase.rpc("has_app_access", {
    app_name: "cartmatch",
  });
  if (rpcError) {
    console.error(`[cartmatch] has_app_access failed: ${rpcError.message}`);
    return { ok: false, status: 503, error: "Could not verify app access." };
  }
  if (granted !== true) {
    return {
      ok: false,
      status: 403,
      error: "Your account does not have access to CartMatch.",
    };
  }

  // The role widens which hosts may be fetched. A role that cannot be read is
  // not an admin role — the failure direction has to be the narrow one.
  const { data: role, error: roleError } = await supabase.rpc("app_role", {
    app_name: "cartmatch",
  });
  if (roleError) {
    console.error(`[cartmatch] app_role failed: ${roleError.message}`);
    return { ok: true, isAdmin: false };
  }

  return { ok: true, isAdmin: role === "app_admin" };
}

// ===========================================================================
// SECTION 3 — THE FETCH
// ===========================================================================

interface Fetched {
  filename: string;
  bytes: number;
  base64: string;
}

/**
 * Fetch one PDF, checking every hop.
 *
 * Redirects are followed manually. An allowed host that answers 302 with a
 * Location pointing at an internal address is the ordinary way an allow-list
 * is defeated, and it is invisible if the runtime follows redirects for you.
 */
async function fetchPdf(
  startUrl: string,
  isAdmin: boolean,
  signal: AbortSignal,
): Promise<{ ok: true; value: Fetched } | { ok: false; error: string }> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const verdict = checkPdfUrl(current, isAdmin);
    if (!verdict.ok) {
      return {
        ok: false,
        error: hop === 0 ? verdict.reason : `Redirected somewhere it may not go: ${verdict.reason}`,
      };
    }

    const res = await fetch(verdict.url, {
      redirect: "manual",
      signal,
      headers: {
        // Honest about what is asking. A site that would rather not serve a
        // program can see one and decide.
        "User-Agent": "CartMatch/1.0 (personal flyer import; one file per request)",
        Accept: "application/pdf,*/*",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, error: `Redirect with no destination (HTTP ${res.status}).` };
      // Relative Locations are legal and common.
      current = new URL(location, verdict.url).toString();
      await res.body?.cancel();
      continue;
    }

    if (!res.ok) {
      return {
        ok: false,
        error: `That link answered HTTP ${res.status}. Check it opens in a browser.`,
      };
    }

    // Refuse on the declared length before reading a byte, when it is declared.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
      await res.body?.cancel();
      return { ok: false, error: `That file is ${Math.round(declared / 1048576)} MB, which is too large.` };
    }

    const buffer = new Uint8Array(await res.arrayBuffer());
    // And again on what actually arrived: content-length is a claim too.
    if (buffer.byteLength > MAX_PDF_BYTES) {
      return { ok: false, error: "That file is too large." };
    }
    if (!looksLikePdf(buffer)) {
      return {
        ok: false,
        error:
          "That link did not return a PDF. Some sites answer a bad link with a web page and a 200 — open it in a browser and copy the link the PDF itself opens at.",
      };
    }

    return {
      ok: true,
      value: {
        filename: filenameFromUrl(new URL(verdict.url)),
        bytes: buffer.byteLength,
        base64: encodeBase64(buffer),
      },
    };
  }

  return { ok: false, error: "That link redirects in a loop." };
}

/** Bytes to base64, in chunks so a large PDF does not blow the argument list. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ===========================================================================
// SECTION 4 — HANDLER
// ===========================================================================

async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");

  const pre = preflight(req);
  if (pre) return pre;

  if (req.method === "GET") {
    return json({ ok: true, build: FUNCTION_BUILD }, 200, origin);
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST." }, 405, origin);
  }

  const auth = await authenticate(req);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, origin);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "Body must be JSON." }, 400, origin);
  }

  const raw =
    typeof payload === "object" && payload !== null
      ? (payload as { url?: unknown }).url
      : undefined;
  if (typeof raw !== "string") {
    return json({ ok: false, error: "Supply a url." }, 400, origin);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const result = await fetchPdf(raw, auth.isAdmin, controller.signal);
    if (!result.ok) return json({ ok: false, error: result.error }, 400, origin);
    return json({ ok: true, build: FUNCTION_BUILD, ...result.value }, 200, origin);
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `That link did not answer within ${TIMEOUT_MS / 1000} seconds.`
        : err instanceof Error
          ? err.message
          : "The fetch failed.";
    return json({ ok: false, error: message }, 502, origin);
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(handler);
