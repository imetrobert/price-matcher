/**
 * POST /functions/v1/cartmatch-vision — cart photo -> structured product list.
 *
 * This function exists for exactly one reason: GEMINI_API_KEY cannot live in a
 * static site. On GitHub Pages the bundle is public (and so is the repo), so a
 * key shipped to the browser is a published key. Here it stays in Supabase
 * secrets and never leaves the function.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE FILE
 * ---------------------------------------------------------------------------
 * CORS and authentication would normally live in `_shared/`. They are inlined
 * because this project is deployed from the Supabase dashboard editor, which
 * bundles a single function folder and cannot resolve `../_shared/`. One
 * function, one file, no import paths to get wrong.
 *
 * When a second function arrives (the retailer fetcher is the obvious one),
 * extract the two sections below into `_shared/` and switch to CLI deploys.
 * Duplicating an auth check across two functions is how one of them ends up
 * quietly missing it.
 *
 * ---------------------------------------------------------------------------
 * DEPLOYING
 * ---------------------------------------------------------------------------
 * Dashboard: Edge Functions -> Deploy a new function -> Via Editor. Name it
 * `cartmatch-vision`, paste this file, deploy. **Turn "Verify JWT" OFF.** That
 * gate rejects the browser's CORS preflight, which carries no Authorization
 * header, and this function performs a stricter check of its own anyway: a
 * valid token is necessary but not sufficient, because the caller must also be
 * on CARTMATCH_ALLOWED_EMAILS.
 *
 * CLI equivalent:
 *   supabase functions deploy cartmatch-vision --no-verify-jwt
 *
 * THE NAME MATTERS. This Supabase project is shared with other apps, and
 * `vision` is precisely the name another app would choose. Deploying over an
 * existing function replaces it. Every name this app owns is prefixed.
 *
 * Secrets (Edge Functions -> Secrets, or `supabase secrets set`). Note these
 * are PROJECT-WIDE, visible to every function on the project, which is why the
 * CartMatch-specific ones are prefixed:
 *   CARTMATCH_ALLOWED_ORIGINS        e.g. https://pricecheck.imetrobert.com
 *   CARTMATCH_GEMINI_API_KEY         optional; falls back to GEMINI_API_KEY
 *   CARTMATCH_GEMINI_MODEL           optional; default gemini-2.5-flash
 *   CARTMATCH_GEMINI_THINKING_BUDGET optional; default 0
 *
 * CARTMATCH_ALLOWED_EMAILS is GONE. Who may use this app is answered by
 * public.app_access via has_app_access('cartmatch') — one place, no redeploy.
 * If that secret still exists on the project, delete it: a stale allowlist that
 * nothing reads is worse than none, because the next person to debug an access
 * problem will edit it and wait for something to change.
 *
 * SUPABASE_URL and SUPABASE_ANON_KEY are injected by the platform.
 *
 * Verification status: written against the documented Gemini REST contract and
 * the Supabase Edge Function runtime, but never executed — no Gemini key and no
 * Supabase project were reachable from the environment this was written in.
 * The first real call is the acceptance test.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

// ===========================================================================
// SECTION 1 — CORS
// ===========================================================================
// The static site is on a different origin from Supabase, so every response
// needs these headers and OPTIONS needs a preflight handler.
//
// The allowlist is explicit rather than `*`. This is NOT a security boundary —
// CORS is enforced by browsers, not by an attacker with curl; the JWT check in
// section 2 is what protects the function. It stops a random page on the
// internet from silently burning your Gemini quota through a visitor's session.

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
// On a static site the UI cannot protect anything: the bundle is public and
// readable, so anyone can skip the login screen and call this endpoint
// directly. This function therefore decides for itself who is calling, from
// the JWT, server-side.
//
// Two checks, both required:
//   1. The token identifies a real Supabase user. getUser() turns it into an
//      identity and rejects an expired or revoked token.
//   2. That user holds a 'cartmatch' grant in public.app_access, read through
//      public.has_app_access('cartmatch'). Supabase Auth is scoped to a
//      PROJECT shared by six apps, so a perfectly valid token routinely belongs
//      to someone with no business here.
//
// The grant check used to be an email list in this function's secrets. It was
// replaced because it was a second source of truth: the same question —
// "may this person use CartMatch?" — was answered by app_access in Postgres and
// by an env var here, and nothing kept them in step. Granting access meant
// editing two places, and forgetting one produced a sign-in that worked
// followed by a 403 on every scan. app_access is now the only answer, and
// granting is a single INSERT that takes effect immediately with no redeploy.

interface Caller {
  id: string;
  email: string | null;
}

type AuthOutcome =
  | { ok: true; caller: Caller }
  | { ok: false; status: number; error: string };

async function authenticate(req: Request): Promise<AuthOutcome> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing bearer token." };
  }

  const url = Deno.env.get("SUPABASE_URL");
  // Platform-injected. The fallback covers projects on the newer key naming.
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

  const caller: Caller = { id: data.user.id, email: data.user.email ?? null };

  // Asked as the CALLER, not as a privileged role: has_app_access is SECURITY
  // DEFINER and reads app_access for whoever is executing it, so this client —
  // built from the anon key with the caller's Authorization header — is what
  // makes the answer about them.
  const { data: granted, error: rpcError } = await supabase.rpc(
    "has_app_access",
    { app_name: "cartmatch" },
  );

  if (rpcError) {
    // Fail closed. The alternative — admitting everyone when the check itself
    // is broken — turns a deployment error into an open endpoint.
    console.error(`[cartmatch] has_app_access failed: ${rpcError.message}`);
    return {
      ok: false,
      status: 503,
      error:
        "Could not verify app access. public.has_app_access('cartmatch') did not answer — check the platform access model is deployed on this project.",
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

  return { ok: true, caller };
}

// ===========================================================================
// SECTION 3 — CART RECOGNITION
// ===========================================================================

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_IMAGES = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 45_000;

const VISION_PROMPT =
  `You are identifying grocery products visible in a photograph of a shopping cart, taken in a store in Montreal, Quebec, Canada. Packaging may be in French, English, or bilingual.

For each DISTINCT product you can actually see, return one entry.

Rules you must follow:
- Report only what is legible in the image. If you cannot read the size, return null for size. Do not infer a typical size from product knowledge.
- Do the same for every field: an unreadable field is null, never a guess.
- "confidence" is your confidence that a shopper would agree with your reading of the visible package, from 0 to 1. Use values below 0.5 freely when the package is partly hidden, blurry, or at a steep angle.
- If the same product appears multiple times, return it once and set package_quantity to the number of identical units visible.
- package_quantity means units of that product in the cart. Multi-packs printed on the label (for example "4 x 100 g") belong in "size", not package_quantity.
- Copy "size" exactly as printed, including units, for example "650 g", "1.89 L", "4 x 100 g".
- fat_percentage applies to dairy and similar products; give just the number as a string, for example "0" or "3.25". Null when not shown.
- variant means the flavour or sub-type as printed, for example "Vanilla", "Vanille", "Old Cheddar", "Classic Roast".
- If a barcode is legible, put the digits in visible_upc. Never transcribe a barcode you cannot read clearly, and never invent digits.
- If a product line is printed on the package (for example "Pro", "Zero", "Light", "Organic"), include it in product_name exactly as shown. This distinction matters.
- Ignore non-product items: the cart itself, shelves, hands, floor, other shoppers.

Return JSON only, matching the provided schema.`;

const CART_VISION_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          brand: { type: "string", nullable: true },
          product_name: { type: "string", nullable: true },
          product_type: { type: "string", nullable: true },
          variant: { type: "string", nullable: true },
          fat_percentage: { type: "string", nullable: true },
          size: { type: "string", nullable: true },
          package_quantity: { type: "integer", nullable: true },
          visible_upc: { type: "string", nullable: true },
          language: { type: "string", nullable: true },
          manufacturer: { type: "string", nullable: true },
          notes: { type: "string", nullable: true },
          confidence: { type: "number" },
        },
        required: ["confidence"],
      },
    },
  },
  required: ["products"],
};

interface IncomingImage {
  base64: string;
  mimeType: string;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST." }, 405, origin);
  }

  // --- The security boundary. Nothing above this line costs anything. -----
  const auth = await authenticate(req);
  if (!auth.ok) {
    return json({ ok: false, error: auth.error }, auth.status, origin);
  }

  // Prefixed first, shared second. Supabase secrets are project-wide, and this
  // project is shared with other apps, so GEMINI_API_KEY may already exist and
  // belong to something else. Reusing it works and needs no setup; adding
  // CARTMATCH_GEMINI_API_KEY later isolates this app without touching the
  // other one — including its revocation.
  const apiKey =
    Deno.env.get("CARTMATCH_GEMINI_API_KEY") ??
    Deno.env.get("GEMINI_API_KEY") ??
    "";
  if (apiKey === "") {
    return json(
      {
        ok: false,
        code: "NO_API_KEY",
        error:
          "No Gemini key found. Set CARTMATCH_GEMINI_API_KEY (or GEMINI_API_KEY) under Edge Functions -> Secrets.",
      },
      503,
      origin,
    );
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "Body must be JSON." }, 400, origin);
  }

  const images = extractImages(payload);
  if (images.length === 0) {
    return json({ ok: false, error: "No images supplied." }, 400, origin);
  }
  for (const img of images) {
    if (Math.floor((img.base64.length * 3) / 4) > MAX_BYTES) {
      return json(
        { ok: false, error: "One of the photos is too large." },
        413,
        origin,
      );
    }
  }

  // Deliberately does NOT fall back to a bare GEMINI_MODEL. Secrets are
  // project-wide: if another app on this project sets GEMINI_MODEL for its own
  // reasons, inheriting it would silently change which model reads your cart.
  // Unset means the default below, never another app's choice.
  const model = Deno.env.get("CARTMATCH_GEMINI_MODEL") ?? "gemini-2.5-flash";
  const thinkingBudget = Number.parseInt(
    Deno.env.get("CARTMATCH_GEMINI_THINKING_BUDGET") ?? "0",
    10,
  );

  const parts: unknown[] = [{ text: VISION_PROMPT }];
  for (const img of images.slice(0, MAX_IMAGES)) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let res = await callGemini(
      apiKey,
      model,
      parts,
      supportsThinking(model),
      Number.isFinite(thinkingBudget) ? thinkingBudget : 0,
      controller.signal,
    );

    // thinkingConfig only exists on 2.5+. If the gate guessed wrong for a
    // future model family, drop it and retry rather than failing a scan.
    if (!res.ok && res.status === 400 && supportsThinking(model)) {
      const detail = await res.text();
      if (/thinking/i.test(detail)) {
        console.warn(
          `[cartmatch] ${model} rejected thinkingConfig; retrying without it.`,
        );
        res = await callGemini(apiKey, model, parts, false, 0, controller.signal);
      } else {
        return json(
          { ok: false, error: `Gemini returned HTTP 400. ${detail.slice(0, 400)}` },
          502,
          origin,
        );
      }
    }

    if (!res.ok) {
      const detail = await res.text();
      return json(
        {
          ok: false,
          // Never echo the key back, even indirectly.
          error: `Gemini returned HTTP ${res.status}. ${detail.slice(0, 400)}`,
        },
        502,
        origin,
      );
    }

    const body = await res.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      return json(
        { ok: false, error: "Gemini response contained no JSON payload." },
        502,
        origin,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json(
        { ok: false, error: "Gemini returned text that was not valid JSON." },
        502,
        origin,
      );
    }

    // The raw shape is returned as-is; the browser validates and normalises it
    // with the same parseVisionResponse() used everywhere else, so there is
    // exactly one implementation of that logic.
    return json({ ok: true, raw: parsed, model }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = message.toLowerCase().includes("abort");
    return json(
      {
        ok: false,
        error: aborted
          ? `Gemini request timed out after ${TIMEOUT_MS}ms.`
          : `Gemini request failed: ${message}`,
      },
      502,
      origin,
    );
  } finally {
    clearTimeout(timer);
  }
});

function callGemini(
  apiKey: string,
  model: string,
  parts: unknown[],
  withThinking: boolean,
  thinkingBudget: number,
  signal: AbortSignal,
): Promise<Response> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseSchema: CART_VISION_SCHEMA,
    temperature: 0.1,
  };
  if (withThinking) {
    generationConfig.thinkingConfig = { thinkingBudget };
  }

  return fetch(
    `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig,
      }),
      signal,
    },
  );
}

function supportsThinking(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes("2.0") || m.includes("1.5") || m.includes("1.0")) return false;
  return /gemini-(\d+)\.(\d+)/.test(m);
}

function extractImages(payload: unknown): IncomingImage[] {
  if (typeof payload !== "object" || payload === null) return [];
  const raw = (payload as { images?: unknown }).images;
  if (!Array.isArray(raw)) return [];

  const out: IncomingImage[] = [];
  for (const item of raw.slice(0, MAX_IMAGES)) {
    if (typeof item !== "object" || item === null) continue;
    const { base64, mimeType } = item as {
      base64?: unknown;
      mimeType?: unknown;
    };
    if (typeof base64 !== "string" || base64 === "") continue;
    const mt = typeof mimeType === "string" ? mimeType : "image/jpeg";
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(mt)) continue;
    out.push({
      base64: base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64,
      mimeType: mt,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// END OF FILE — the lines below are deliberately comments.
//
// This function is deployed by pasting it into the Supabase dashboard editor,
// and a paste from a phone silently loses the tail. When the last thing in the
// file was a closing brace, losing it produced "Expected '}', got '<eof>'" —
// which happened, and cost a deploy cycle to diagnose.
//
// Ending on comment lines means a truncated paste most likely drops commentary
// rather than code, and the file still compiles. Keep something harmless here.
// ---------------------------------------------------------------------------
