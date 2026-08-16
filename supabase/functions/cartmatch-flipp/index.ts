/**
 * POST /functions/v1/cartmatch-flipp
 *
 *   { action: "list", postalCode }            -> flyers running now, per banner
 *   { action: "fetch", flyerId, merchantName } -> that flyer's offers, normalised
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SPLIT INTO TWO CALLS
 * ---------------------------------------------------------------------------
 * Because the upstream is slow. A flyer listing for a postal code it has not
 * cached took roughly SIXTY SECONDS when measured from a phone — long enough
 * that one request per banner in a single invocation would exceed any sensible
 * function timeout and take the whole week's import down with it.
 *
 * So `list` is one call, and each `fetch` is one flyer. The client queues them
 * and a person watches six rows tick over instead of watching one spinner and
 * wondering. The same shape the flyer-page worker already uses, for the same
 * reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not write to the database. It fetches, normalises and returns; the
 * caller decides what to store. That keeps the awkward part — an undocumented
 * upstream that can change shape without notice — behind a boundary where a
 * bad response produces an error message rather than a table full of wrong
 * prices.
 *
 * It also never quotes a saving. Every offer it emits is condition-unknown;
 * see `_shared/flipp.ts` for the measurement that forced that, which is the
 * single most important thing to understand before changing any of this.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

import { normaliseFlyerItems, retailerFromMerchant } from "../_shared/flipp.ts";

export const FUNCTION_BUILD = "2026-08-16-flipp-1";

const BASE = "https://backflipp.wishabi.com/flipp";

/**
 * Generous, because the upstream genuinely is slow. Measured at ~60s for an
 * uncached postal code; 90 leaves room without hanging a screen forever.
 */
const TIMEOUT_MS = 90_000;

/** Honest identification. A client pretending to be a browser is a client that
 *  has decided the operator would object if they knew. */
const USER_AGENT =
  "CartMatch/1.0 (personal grocery price comparison; one household; weekly)";

/** The same rule the endpoint enforces, checked here so a typo is not a round trip. */
const POSTAL_RE = /^(\d{5}|[a-z]\d[a-z][ -]?\d[a-z]\d)$/i;

// ===========================================================================
// SECTION 1 — CORS  (identical to the other functions)
// ===========================================================================

const DEFAULT_ORIGINS = ["http://localhost:3000"];

function allowedOrigins(): string[] {
  const raw = Deno.env.get("CARTMATCH_ALLOWED_ORIGINS") ?? "";
  const configured = raw.split(",").map((o) => o.trim()).filter((o) => o !== "");
  return configured.length > 0 ? [...configured, ...DEFAULT_ORIGINS] : DEFAULT_ORIGINS;
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

type AuthOutcome = { ok: true } | { ok: false; status: number; error: string };

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

  return { ok: true };
}

// ===========================================================================
// SECTION 3 — THE UPSTREAM
// ===========================================================================

/**
 * One GET, with a timeout and no retry.
 *
 * No retry on purpose: a request that takes a minute and fails has already
 * cost the caller a minute, and doing it again risks two minutes and a second
 * helping of load on somebody else's servers. The client queues these, so a
 * failed banner is retried by a person pressing a button, knowingly.
 */
async function getJson(
  url: string,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Upstream answered HTTP ${res.status}. ${text.slice(0, 200)}`,
      };
    }

    try {
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, error: "Upstream answered 200 but not JSON." };
    }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: timedOut
        ? `Upstream did not answer within ${TIMEOUT_MS / 1000} seconds. It is slow by nature — try that banner again.`
        : err instanceof Error
          ? err.message
          : "The upstream request failed.",
    };
  }
}

/**
 * The endpoint reports its own errors as {"code":n,"message":"..."}.
 *
 * Passed back verbatim, because their message is better than anything written
 * here — the postal-code rule arrived that way, as a regex, and saying it back
 * is more use than "the request failed".
 */
function upstreamComplaint(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const row = body as { message?: unknown; code?: unknown };
  if (typeof row.message !== "string") return null;
  return typeof row.code === "number"
    ? `${row.message} (code ${row.code})`
    : row.message;
}

/** Find a list of flyer records in the listing response, wherever it sits. */
function extractFlyers(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null);
  }
  if (typeof body === "object" && body !== null) {
    for (const key of ["flyers", "items", "results", "data"]) {
      const value = (body as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        return value.filter(
          (f): f is Record<string, unknown> => typeof f === "object" && f !== null,
        );
      }
    }
  }
  return [];
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

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Body must be JSON." }, 400, origin);
  }

  const action = typeof payload.action === "string" ? payload.action : "";

  // -- list: which flyers are running, for the banners we compare -----------
  if (action === "list") {
    const postalCode = String(payload.postalCode ?? "").trim();
    if (!POSTAL_RE.test(postalCode)) {
      return json(
        {
          ok: false,
          error:
            "A full postal code is required (H4V1H6 or 'H4V 1H6'). A three-character prefix is refused by the upstream.",
        },
        400,
        origin,
      );
    }

    const url =
      `${BASE}/flyers?locale=en-CA&postal_code=${encodeURIComponent(postalCode)}`;
    const result = await getJson(url);
    if (!result.ok) return json({ ok: false, error: result.error }, 502, origin);

    const complaint = upstreamComplaint(result.body);
    if (complaint) return json({ ok: false, error: complaint }, 502, origin);

    /*
      Only the banners this app compares, and only those it can name. A flyer
      from a shop with no RetailerId cannot be filed anywhere, so listing it
      would offer somebody a button that cannot work.
    */
    const flyers = extractFlyers(result.body)
      .map((f) => {
        const merchant = f.merchant ?? f.merchant_name ?? f.name;
        return {
          flyerId: String(f.id ?? f.flyer_id ?? ""),
          merchantName: typeof merchant === "string" ? merchant : "",
          retailerId: retailerFromMerchant(merchant),
          validFrom: typeof f.valid_from === "string" ? f.valid_from.slice(0, 10) : null,
          validTo: typeof f.valid_to === "string" ? f.valid_to.slice(0, 10) : null,
        };
      })
      .filter((f) => f.retailerId !== null && f.flyerId !== "");

    return json({ ok: true, build: FUNCTION_BUILD, flyers }, 200, origin);
  }

  // -- fetch: one flyer's contents, normalised ------------------------------
  if (action === "fetch") {
    const flyerId = String(payload.flyerId ?? "").trim();
    if (!/^\d+$/.test(flyerId)) {
      return json({ ok: false, error: "flyerId must be a number." }, 400, origin);
    }

    const result = await getJson(`${BASE}/flyers/${flyerId}`);
    if (!result.ok) return json({ ok: false, error: result.error }, 502, origin);

    const complaint = upstreamComplaint(result.body);
    if (complaint) return json({ ok: false, error: complaint }, 502, origin);

    const body = result.body as Record<string, unknown>;
    const items = Array.isArray(body.items) ? body.items : [];

    /*
      The merchant name comes from the caller, taken from the listing, because
      the flyer detail response carries the items but not reliably the banner.
      Passing it in beats guessing, and `normaliseFlyerItems` drops everything
      when it cannot name the shop rather than filing offers under the wrong one.
    */
    const merchantName = String(payload.merchantName ?? "");
    const { offers, rejected } = normaliseFlyerItems(items, merchantName, flyerId);

    return json(
      {
        ok: true,
        build: FUNCTION_BUILD,
        flyerId,
        received: items.length,
        offers,
        // Reported, not swallowed. A feed that halves overnight should be
        // visible as a count of discards rather than as a quiet week.
        rejected,
      },
      200,
      origin,
    );
  }

  return json(
    { ok: false, error: 'action must be "list" or "fetch".' },
    400,
    origin,
  );
}

Deno.serve(handler);
