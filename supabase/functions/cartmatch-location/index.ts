/**
 * POST /functions/v1/cartmatch-location
 *
 * Two location lookups against OpenStreetMap services, both of which must run
 * server-side:
 *
 *   { action: "reverse", lat, lon }   -> { postalCode }
 *   { action: "stores",  postalCode } -> { stores: [...] }
 *
 * ---------------------------------------------------------------------------
 * WHY NOT CALL OSM FROM THE BROWSER
 * ---------------------------------------------------------------------------
 * Nominatim's usage policy requires an identifying User-Agent on every request.
 * A browser cannot set that header — it is forbidden by fetch — so a browser
 * call is a policy violation by construction, and the polite outcome is being
 * blocked.
 *
 * It is also better for the user. Nominatim and Overpass see this function's
 * IP, not the shopper's, so "where is this person standing" is never revealed
 * to a third party alongside their address.
 *
 * ---------------------------------------------------------------------------
 * COORDINATES ARE NEVER PERSISTED
 * ---------------------------------------------------------------------------
 * The reverse lookup takes latitude and longitude, derives a postal code, and
 * returns only that. Nothing here writes to a database and nothing logs the
 * coordinates — note the error paths below log status codes, never the input.
 * A stored coordinate is location history; a postal code is a neighbourhood.
 *
 * ---------------------------------------------------------------------------
 * DUPLICATED AUTH — READ BEFORE EDITING
 * ---------------------------------------------------------------------------
 * Sections 1 and 2 are byte-identical to cartmatch-vision. They are duplicated
 * because the Supabase dashboard editor bundles one function folder and cannot
 * resolve `../_shared/`, and this project is deployed from the dashboard.
 *
 * That duplication is a known hazard: two copies of an auth check is how one of
 * them ends up quietly missing a fix. If you change either copy, change both —
 * and if a third function ever appears, stop duplicating and move to CLI
 * deploys with a shared module.
 *
 * ---------------------------------------------------------------------------
 * DEPLOYING
 * ---------------------------------------------------------------------------
 * Dashboard: Edge Functions -> Deploy a new function -> Via Editor. Name it
 * `cartmatch-location`, paste this file, **Verify JWT OFF** (it rejects the
 * browser's CORS preflight; this function does a stricter check of its own).
 *
 * CLI: supabase functions deploy cartmatch-location --no-verify-jwt
 *
 * Secrets: none of its own. Uses CARTMATCH_ALLOWED_ORIGINS and the
 * platform-injected SUPABASE_URL / SUPABASE_ANON_KEY.
 *
 * Verification status: written against the documented Nominatim and Overpass
 * APIs but never executed — neither host was reachable from the environment
 * this was written in. The first real call is the acceptance test.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

// ===========================================================================
// SECTION 1 — CORS  (identical to cartmatch-vision)
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
      // Postal codes and store lists are per-user answers to a per-user
      // question. Nothing in between should keep a copy.
      "Cache-Control": "no-store",
    },
  });
}

// ===========================================================================
// SECTION 2 — THE SECURITY BOUNDARY  (identical to cartmatch-vision)
// ===========================================================================

type AuthOutcome =
  | { ok: true }
  | { ok: false; status: number; error: string };

async function authenticate(req: Request): Promise<AuthOutcome> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing bearer token." };
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
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

  const { data: granted, error: rpcError } = await supabase.rpc(
    "has_app_access",
    { app_name: "cartmatch" },
  );

  if (rpcError) {
    console.error(`[cartmatch] has_app_access failed: ${rpcError.message}`);
    return {
      ok: false,
      status: 503,
      error:
        "Could not verify app access. public.has_app_access('cartmatch') did not answer.",
    };
  }

  if (granted !== true) {
    return {
      ok: false,
      status: 403,
      error:
        "Your account does not have access to CartMatch. Ask the owner to add a 'cartmatch' grant in public.app_access.",
    };
  }

  return { ok: true };
}

// ===========================================================================
// SECTION 3 — OPENSTREETMAP
// ===========================================================================

const NOMINATIM = "https://nominatim.openstreetmap.org";
const OVERPASS = "https://overpass-api.de/api/interpreter";

/**
 * Nominatim's usage policy requires this to identify the application and give
 * a way to make contact. Sending a generic or absent User-Agent is the fastest
 * route to being blocked, and would be discourteous to a free service.
 */
const USER_AGENT =
  "CartMatch/1.0 (grocery price-match assistant; https://pricecheck.imetrobert.com)";

const TIMEOUT_MS = 15_000;
/** Montreal is dense; 5 km reaches well past the nearest handful of banners. */
const STORE_RADIUS_M = 5000;
const MAX_STORES = 25;

interface StoreResult {
  /** OSM element id, stable enough to use as a React key. */
  id: string;
  name: string;
  brand: string | null;
  address: string | null;
  distanceM: number;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST." }, 405, origin);
  }

  const auth = await authenticate(req);
  if (!auth.ok) {
    return json({ ok: false, error: auth.error }, auth.status, origin);
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Body must be JSON." }, 400, origin);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    if (payload.action === "reverse") {
      return await handleReverse(payload, origin, controller.signal);
    }
    if (payload.action === "stores") {
      return await handleStores(payload, origin, controller.signal);
    }
    return json(
      { ok: false, error: 'action must be "reverse" or "stores".' },
      400,
      origin,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = message.toLowerCase().includes("abort");
    return json(
      {
        ok: false,
        error: aborted
          ? "OpenStreetMap did not respond in time. Try again, or type the postal code."
          : `Location lookup failed: ${message}`,
      },
      502,
      origin,
    );
  } finally {
    clearTimeout(timer);
  }
});

// --- reverse: coordinates -> postal code ------------------------------------

async function handleReverse(
  payload: Record<string, unknown>,
  origin: string | null,
  signal: AbortSignal,
): Promise<Response> {
  const lat = Number(payload.lat);
  const lon = Number(payload.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ ok: false, error: "lat and lon must be numbers." }, 400, origin);
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return json({ ok: false, error: "lat or lon out of range." }, 400, origin);
  }

  // zoom=18 asks for building-level detail, which is the level that carries a
  // postcode. Coarser zooms return a neighbourhood with no postcode at all.
  const url =
    `${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lon}` +
    `&zoom=18&addressdetails=1`;

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal,
  });

  if (!res.ok) {
    // Status only. The coordinates are the one thing worth not logging.
    console.error(`[cartmatch] nominatim reverse returned ${res.status}`);
    return json(
      { ok: false, error: `Address lookup returned HTTP ${res.status}.` },
      502,
      origin,
    );
  }

  const body = await res.json();
  const raw = body?.address?.postcode;
  const postalCode = typeof raw === "string" ? normalizePostal(raw) : null;

  if (!postalCode) {
    // A real and unremarkable outcome: plenty of Canadian coordinates have no
    // postcode in OSM. Say so plainly rather than dressing it up as an error,
    // because the fix is simply to type it.
    return json(
      {
        ok: false,
        code: "NO_POSTAL_CODE",
        error:
          "No postal code is recorded for this spot in OpenStreetMap. Type it instead.",
      },
      404,
      origin,
    );
  }

  return json({ ok: true, postalCode }, 200, origin);
}

/** Canadian postal codes are A1A 1A1. Anything else is not one. */
function normalizePostal(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z][0-9][A-Z][0-9][A-Z][0-9]$/.test(cleaned)) return null;
  return `${cleaned.slice(0, 3)} ${cleaned.slice(3)}`;
}

// --- stores: postal code -> nearby supermarkets -----------------------------

async function handleStores(
  payload: Record<string, unknown>,
  origin: string | null,
  signal: AbortSignal,
): Promise<Response> {
  const postalRaw = typeof payload.postalCode === "string" ? payload.postalCode : "";
  const postalCode = normalizePostal(postalRaw);
  if (!postalCode) {
    return json(
      { ok: false, error: "postalCode must be a Canadian postal code." },
      400,
      origin,
    );
  }

  // 1. Postal code -> a point to search around.
  const searchUrl =
    `${NOMINATIM}/search?format=jsonv2&limit=1&countrycodes=ca` +
    `&postalcode=${encodeURIComponent(postalCode)}`;

  const geo = await fetch(searchUrl, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal,
  });
  if (!geo.ok) {
    console.error(`[cartmatch] nominatim search returned ${geo.status}`);
    return json(
      { ok: false, error: `Postal code lookup returned HTTP ${geo.status}.` },
      502,
      origin,
    );
  }
  const hits = await geo.json();
  const first = Array.isArray(hits) ? hits[0] : null;
  const lat = Number(first?.lat);
  const lon = Number(first?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json(
      {
        ok: false,
        code: "UNKNOWN_POSTAL_CODE",
        error: `OpenStreetMap does not recognise ${postalCode}.`,
      },
      404,
      origin,
    );
  }

  // 2. Supermarkets around that point.
  //
  // `shop=supermarket` is the tag for a full grocery store. Convenience shops
  // and corner stores are deliberately excluded: they do not price-match, and
  // padding the list with them makes the real answer harder to find while
  // standing in an aisle.
  //
  // `out center` gives ways (buildings) a single coordinate, so nodes and
  // buildings can be treated identically below.
  const query = `[out:json][timeout:20];
(
  node["shop"="supermarket"](around:${STORE_RADIUS_M},${lat},${lon});
  way["shop"="supermarket"](around:${STORE_RADIUS_M},${lat},${lon});
);
out center tags ${MAX_STORES * 4};`;

  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });

  if (!res.ok) {
    console.error(`[cartmatch] overpass returned ${res.status}`);
    return json(
      {
        ok: false,
        error:
          res.status === 429
            ? "OpenStreetMap is rate-limiting requests. Wait a moment and try again."
            : `Store lookup returned HTTP ${res.status}.`,
      },
      502,
      origin,
    );
  }

  const body = await res.json();
  const elements = Array.isArray(body?.elements) ? body.elements : [];

  const stores: StoreResult[] = [];
  for (const el of elements) {
    const tags = el?.tags ?? {};
    const name = typeof tags.name === "string" ? tags.name.trim() : "";
    if (name === "") continue; // An unnamed shop cannot be chosen from a list.

    const elLat = Number(el.lat ?? el.center?.lat);
    const elLon = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(elLat) || !Number.isFinite(elLon)) continue;

    stores.push({
      id: `${el.type}/${el.id}`,
      name,
      brand: typeof tags.brand === "string" ? tags.brand.trim() : null,
      address: formatAddress(tags),
      distanceM: Math.round(haversineM(lat, lon, elLat, elLon)),
    });
  }

  stores.sort((a, b) => a.distanceM - b.distanceM);

  return json(
    {
      ok: true,
      postalCode,
      stores: stores.slice(0, MAX_STORES),
      // Shown in the UI. ODbL requires attribution wherever this data appears,
      // and carrying it in the payload means the UI cannot forget it.
      attribution: "© OpenStreetMap contributors",
    },
    200,
    origin,
  );
}

/**
 * Whatever the tags actually contain, never a placeholder.
 *
 * A store with no address returns null and the UI shows the name alone. An
 * invented or partial-looking address is worse than none: this list exists so
 * someone can confirm which building they are standing in.
 */
function formatAddress(tags: Record<string, unknown>): string | null {
  const num = str(tags["addr:housenumber"]);
  const street = str(tags["addr:street"]);
  const city = str(tags["addr:city"]);

  const line = [num, street].filter(Boolean).join(" ").trim();
  const parts = [line, city].filter((p) => p !== "");
  return parts.length > 0 ? parts.join(", ") : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Straight-line metres. Good enough to sort a list; not a walking route. */
function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
