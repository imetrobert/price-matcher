/**
 * POST /functions/v1/cartmatch-flipp
 *
 *   { action: "list", postalCode }              -> flyers running now, per banner
 *   { action: "fetch", flyerId, merchantName }   -> that flyer's offers, normalised
 *   { action: "retry", retailerId }              -> re-fetch and WRITE one retailer
 *
 * ---------------------------------------------------------------------------
 * WHY "retry" IS DIFFERENT FROM THE OTHER TWO
 * ---------------------------------------------------------------------------
 * list/fetch deliberately never write — see the section below, unchanged for
 * both. retry is a narrow, explicit exception: a person looking at "Nothing
 * yet" next to one retailer on the sources card, pressing a button for THAT
 * retailer specifically. It writes using this function's own service-role
 * client, the same way the scheduled import does — the browser is never
 * granted write access to cartmatch_flipp_offers itself, only the ability to
 * ask a trusted, has_app_access-gated function to write on its behalf. RLS
 * on that table still has no client-write policy; nothing here changes that.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

import { normaliseFlyerItems, retailerFromMerchant } from "../_shared/flipp.ts";

export const FUNCTION_BUILD = "2026-08-27-flipp-2";

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

  // -- retry: re-fetch and WRITE this one retailer's current banners -------
  if (action === "retry") {
    const retailerId = String(payload.retailerId ?? "").trim();
    const validRetailers = new Set([
      "maxi", "walmart", "superc", "metro", "iga", "provigo", "adonis",
    ]);
    if (!validRetailers.has(retailerId)) {
      return json({ ok: false, error: "retailerId must be a known retailer." }, 400, origin);
    }

    const postalCode = Deno.env.get("CARTMATCH_POSTAL_CODE");
    if (!postalCode) {
      return json({ ok: false, error: "CARTMATCH_POSTAL_CODE is not set." }, 500, origin);
    }

    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) {
      return json({ ok: false, error: "Missing SUPABASE_URL / SERVICE_ROLE_KEY." }, 500, origin);
    }
    // Service-role client used ONLY inside this action, after the user-session
    // check above already passed — the browser never gets this key, and
    // cartmatch_flipp_offers still has no client-write RLS policy. This is
    // the same trust shape as the scheduled import: check access in code,
    // then write with elevated credentials the caller never sees.
    const supabase = createClient(url, serviceKey);

    const listUrl =
      `${BASE}/flyers?locale=en-CA&postal_code=${encodeURIComponent(postalCode)}`;
    const listed = await getJson(listUrl);
    if (!listed.ok) return json({ ok: false, error: `list: ${listed.error}` }, 502, origin);

    const listComplaint = upstreamComplaint(listed.body);
    if (listComplaint) return json({ ok: false, error: listComplaint }, 502, origin);

    const banners = extractFlyers(listed.body)
      .map((f) => {
        const merchant = f.merchant ?? f.merchant_name ?? f.name;
        return {
          flyerId: String(f.id ?? f.flyer_id ?? ""),
          merchantName: typeof merchant === "string" ? merchant : "",
          retailerId: retailerFromMerchant(merchant),
        };
      })
      .filter((f) => f.retailerId === retailerId && f.flyerId !== "");

    // Genuinely nothing to retry — Flipp itself has no current banner for
    // this retailer at this postal code right now. Reported plainly rather
    // than as an error, since retrying again will not change this.
    if (banners.length === 0) {
      return json(
        {
          ok: true,
          build: FUNCTION_BUILD,
          retailerId,
          banners: 0,
          written: 0,
          errors: {},
          note: "Flipp has no current flyer for this retailer at this postal code.",
        },
        200,
        origin,
      );
    }

    const results = await Promise.all(
      banners.map(async (b) => {
        const fetched = await getJson(`${BASE}/flyers/${b.flyerId}`);
        if (!fetched.ok) {
          return { flyerId: b.flyerId, error: fetched.error, offers: [] };
        }
        const body = fetched.body as Record<string, unknown>;
        const items = Array.isArray(body.items) ? body.items : [];
        const { offers } = normaliseFlyerItems(items, b.merchantName, b.flyerId);
        return { flyerId: b.flyerId, error: null as string | null, offers };
      }),
    );

    let written = 0;
    const errors: Record<string, string> = {};
    for (const r of results) {
      if (r.error) {
        errors[r.flyerId] = r.error;
        continue;
      }
      // Replace only these flyers' rows — same reasoning as the scheduled
      // import: never touch another retailer's, never touch another flyer
      // under this same retailer that this call did not just re-fetch.
      await supabase.from("cartmatch_flipp_offers").delete().eq("flyer_id", r.flyerId);
      if (r.offers.length === 0) continue;
      const rows = r.offers.map((o) => ({
        id: o.id,
        flyer_id: o.flyerId,
        retailer_id: o.retailerId,
        advertised_text: o.advertisedText,
        brand: o.brand,
        brands: o.brands,
        size: o.size,
        size_ambiguous: o.sizeAmbiguous,
        price_cents: o.priceCents,
        discount_percent: o.discountPercent,
        basis: o.basis,
        image_url: o.imageUrl,
        multi_product: o.multiProduct,
        valid_from: o.validFrom,
        valid_to: o.validTo,
      }));
      const { error } = await supabase.from("cartmatch_flipp_offers").insert(rows);
      if (error) errors[r.flyerId] = error.message;
      else written += rows.length;
    }

    return json(
      { ok: true, build: FUNCTION_BUILD, retailerId, banners: banners.length, written, errors },
      200,
      origin,
    );
  }

  return json(
    { ok: false, error: 'action must be "list", "fetch", or "retry".' },
    400,
    origin,
  );
}

Deno.serve(handler);
