/**
 * POST /functions/v1/cartmatch-retailer
 *
 *   { action: "probe", url }  -> what a retailer actually returns to a
 *                               datacenter, and whether the page is parseable
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Every parser in this project was written against pages a person captured in
 * a browser. None of it has been exercised against a page fetched by a server.
 * Those are different situations: retailers commonly serve a bot challenge to
 * datacenter addresses, and Supabase Edge Functions run in one. Maxi's own
 * config carries `captchaSiteKey` fields, so the machinery is there.
 *
 * This answers that question with evidence instead of speculation. It reports
 * what came back — status, content type, whether a schema.org Product survived,
 * whether the body looks like a challenge — and never pretends a challenge page
 * is a product page.
 *
 * ---------------------------------------------------------------------------
 * THIS FETCHES A CLIENT-SUPPLIED URL. READ BEFORE CHANGING IT.
 * ---------------------------------------------------------------------------
 * A function that fetches whatever URL it is handed is a server-side request
 * forgery hole. It runs inside Supabase's network, so `http://localhost`,
 * `http://169.254.169.254` (cloud instance metadata) and any internal service
 * are all reachable from here even though they are not reachable from the
 * caller. That is the entire value of the attack.
 *
 * Three constraints, and none of them is optional:
 *
 *   HOST ALLOWLIST. Only the six retailers this app compares. Not "any https
 *   URL", not "any URL matching a pattern" — an explicit list of hosts.
 *
 *   HTTPS ONLY. An http:// URL is refused rather than upgraded.
 *
 *   REDIRECTS ARE FOLLOWED MANUALLY, and every hop is checked against the same
 *   allowlist. An allowlisted host that redirects to somewhere else is exactly
 *   how an allowlist gets bypassed, and `redirect: "follow"` would do it
 *   silently.
 *
 * If you add a retailer, add its host here. If you find yourself wanting to
 * relax any of the three, you are building the hole this comment describes.
 *
 * ---------------------------------------------------------------------------
 * DEPLOYING
 * ---------------------------------------------------------------------------
 * Dashboard: Edge Functions -> Deploy a new function -> Via Editor. Name it
 * `cartmatch-retailer`, paste this file, **Verify JWT OFF**.
 *
 * Sections 1 and 2 are the third copy of the same auth and CORS code, which is
 * the point at which duplication stops being acceptable. The dashboard editor
 * cannot resolve `../_shared/`, so the fix is to move to CLI deploys and a
 * shared module — not to keep pasting.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

// ===========================================================================
// SECTION 1 — CORS  (identical to cartmatch-vision and cartmatch-location)
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
// SECTION 2 — THE SECURITY BOUNDARY  (identical to the other two functions)
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
    return {
      ok: false,
      status: 503,
      error: "Could not verify app access.",
    };
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
// SECTION 3 — THE PROBE
// ===========================================================================

/**
 * The only hosts this function may fetch. See the SSRF note in the header.
 * Exact matches — no suffix matching, because "notmaxi.ca" ends with "maxi.ca".
 */
const ALLOWED_HOSTS = new Set([
  "www.maxi.ca",
  "www.iga.ca",
  "www.superc.ca",
  "www.metro.ca",
  "www.walmart.ca",
  "www.provigo.ca",
]);

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20_000;
/** Enough to diagnose a challenge page; far short of storing the page. */
const BODY_PREVIEW = 600;

/**
 * Identifies the app honestly rather than impersonating a browser.
 *
 * Sending a fake Chrome string to slip past a bot check is the kind of evasion
 * this project does not do — if a retailer does not want automated reads, the
 * correct outcome is to find that out, not to disguise the request.
 */
const USER_AGENT =
  "CartMatch/1.0 (personal grocery price comparison; https://pricecheck.imetrobert.com)";

/** Markers that mean "you got a challenge, not a page". */
const CHALLENGE_MARKERS = [
  "captcha",
  "are you a human",
  "just a moment",
  "checking your browser",
  "access denied",
  "request unsuccessful",
  "incapsula",
  "cf-browser-verification",
  "px-captcha",
  "bot detection",
];

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  const pre = preflight(req);
  if (pre) return pre;
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

  if (payload.action !== "probe") {
    return json({ ok: false, error: 'action must be "probe".' }, 400, origin);
  }

  const target = typeof payload.url === "string" ? payload.url : "";
  const check = validateTarget(target);
  if (!check.ok) return json({ ok: false, error: check.error }, 400, origin);

  return await probe(check.url, origin);
});

type TargetCheck = { ok: true; url: URL } | { ok: false; error: string };

function validateTarget(raw: string): TargetCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Not a URL." };
  }
  // Refused rather than upgraded: silently rewriting a caller's scheme hides
  // what was actually asked for.
  if (url.protocol !== "https:") {
    return { ok: false, error: "Only https:// URLs are permitted." };
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      error: `${url.hostname} is not a retailer this app compares. Permitted: ${[...ALLOWED_HOSTS].join(", ")}.`,
    };
  }
  return { ok: true, url };
}

async function probe(url: URL, origin: string | null): Promise<Response> {
  const hops: string[] = [];
  let current = url;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      // Manual, so every hop is re-validated. `redirect: "follow"` would let an
      // allowlisted host bounce us anywhere it liked.
      const res = await fetch(current.toString(), {
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8",
        },
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          return json(
            { ok: true, result: summarise(res, "", current, hops, "redirect with no location") },
            200,
            origin,
          );
        }
        const next = new URL(location, current);
        hops.push(next.toString());
        const recheck = validateTarget(next.toString());
        if (!recheck.ok) {
          // Deliberately does not follow. An allowlist that redirects off itself
          // is the bypass the allowlist exists to prevent.
          return json(
            {
              ok: false,
              error: `Redirected to a host that is not permitted (${next.hostname}). Not followed.`,
              hops,
            },
            502,
            origin,
          );
        }
        current = recheck.url;
        continue;
      }

      // The body is read on failure too. A 403's body and headers say WHICH
      // protection refused — Akamai, Cloudflare, PerimeterX all identify
      // themselves — and "403 from something unnamed" is a much weaker finding
      // to act on than "403 from a named WAF".
      const body = await res.text().catch(() => "");
      return json({ ok: true, result: summarise(res, body, current, hops, null) }, 200, origin);
    }

    return json(
      { ok: false, error: `More than ${MAX_REDIRECTS} redirects.`, hops },
      502,
      origin,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(
      {
        ok: false,
        error: message.toLowerCase().includes("abort")
          ? `No response within ${TIMEOUT_MS}ms.`
          : `Request failed: ${message}`,
        hops,
      },
      502,
      origin,
    );
  } finally {
    clearTimeout(timer);
  }
}

interface ProbeResult {
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  /** True when a schema.org Product block survived the round trip. */
  hasJsonLdProduct: boolean;
  /** Price read from it, so success is provable rather than asserted. */
  priceFromJsonLd: string | null;
  looksLikeChallenge: boolean;
  challengeMarkers: string[];
  hops: string[];
  note: string | null;
  bodyPreview: string;
  /** Headers that name the protection doing the refusing. */
  signals: Record<string, string>;
}

/**
 * Response headers worth recording. Each is a fingerprint of a particular
 * protection vendor, and knowing which one refused is the difference between
 * "blocked" and a finding someone can act on.
 */
const SIGNAL_HEADERS = [
  "server",
  "cf-ray",
  "cf-mitigated",
  "x-akamai-transformed",
  "akamai-grn",
  "x-iinfo",
  "x-cdn",
  "x-served-by",
  "set-cookie",
  "retry-after",
];

function summarise(
  res: Response,
  body: string,
  url: URL,
  hops: string[],
  note: string | null,
): ProbeResult {
  const lower = body.slice(0, 20000).toLowerCase();
  const markers = CHALLENGE_MARKERS.filter((m) => lower.includes(m));
  const product = firstJsonLdProduct(body);

  const signals: Record<string, string> = {};
  for (const name of SIGNAL_HEADERS) {
    const value = res.headers.get(name);
    if (value) {
      // Cookies can carry session material even in a rejection; the name of the
      // cookie identifies the vendor and the value never needs to leave the
      // function.
      signals[name] = name === "set-cookie" ? value.split("=")[0]! : value.slice(0, 120);
    }
  }

  return {
    signals,
    finalUrl: url.toString(),
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    bytes: body.length,
    hasJsonLdProduct: product !== null,
    // The whole point: a price proves the page came through intact. A 200 with
    // no product is a challenge or a placeholder, however healthy it looks.
    priceFromJsonLd: product ? String(product) : null,
    looksLikeChallenge: markers.length > 0 || (res.status === 200 && body.length < 2000),
    challengeMarkers: markers,
    hops,
    note,
    bodyPreview: body.slice(0, BODY_PREVIEW),
  };
}

function firstJsonLdProduct(html: string): unknown | null {
  const pattern =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    try {
      const node = JSON.parse(match[1]!);
      if (node && node["@type"] === "Product") {
        return node?.offers?.price ?? "present but no price";
      }
    } catch {
      // Next block.
    }
  }
  return null;
}
