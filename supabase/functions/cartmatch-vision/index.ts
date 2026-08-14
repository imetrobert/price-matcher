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

import { quotaMessage } from "../_shared/quota.ts";
import { DEFAULT_MODEL_CHAIN, modelChain } from "../_shared/models.ts";

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

/**
 * The model used when CARTMATCH_GEMINI_MODEL is unset.
 *
 * An ALIAS, deliberately, after a pinned version broke twice. Google retires
 * model ids, and a key issued after a retirement cannot call the retired id at
 * all — a key created on 8 August could not call gemini-2.5-flash, which had
 * been the default here. Worse, ListModels still ADVERTISES the retired id, so
 * the error and the list of alternatives contradicted each other.
 *
 * "gemini-flash-latest" follows whatever the current flash model is, which is
 * the right tier for this work: reading a flyer is dense transcription, not
 * reasoning. Pinning a version buys reproducibility nobody here needs and
 * costs a breakage every time Google moves on.
 *
 * The default is a LIST, of concrete versions with an alias behind them. An
 * alias is NOT the safe choice it appears to be: a real key listed
 * gemini-flash-latest among its available models and then answered 404 to it
 * on every page. Google advertises ids it will not serve, so the only reliable
 * strategy is a chain, walked until one answers.
 *
 * CARTMATCH_GEMINI_MODEL overrides, and accepts the same comma-separated form.
 */
const DEFAULT_MODEL = DEFAULT_MODEL_CHAIN;
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

Also report how much of the cart you could NOT read, which is as important as what you could:
- "obscured_count": how many DISTINCT items are visibly present but cannot be identified at all — buried under other items, facing away, wrapped in an opaque bag, cut off by the edge of the frame. Count the items you can see are there but cannot name. Do not include them in "products"; a guess is worse than an admission.
- "obscured_note": one short sentence saying why, in plain words a shopper would recognise — for example "three items underneath the bread are not visible" or "the back row is facing away". Null when nothing is obscured.
- Count an item once. If you can read a product but not its size, that is a low-confidence PRODUCT, not an obscured one.
- If the whole cart is clearly visible, return 0 and null.

Return JSON only, matching the provided schema.`;

/**
 * Reading a flyer page.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PRICE IS ASKED FOR AS TWO INTEGERS
 * ---------------------------------------------------------------------------
 * A grocery flyer sets the dollars enormous and the cents as a small
 * superscript: 4 with a raised 99 beside it. There is no decimal point on the
 * page at all, and Quebec flyers that do print one use a comma. Asking for
 * "the price" invites a model to render that as 4.99, 499, 4,99 or 4 99, and
 * one of those is a hundredfold error in a number shown to a cashier.
 *
 * Asking for the two numerals it can literally see removes the decision.
 * Assembling them into cents is arithmetic, and arithmetic is done in code —
 * the model transcribes, it never calculates.
 *
 * ---------------------------------------------------------------------------
 * WHY basis IS REQUIRED
 * ---------------------------------------------------------------------------
 * "/lb" is printed in six-point type beside a price set forty points tall. An
 * extraction that overlooks it produces a number that looks comparable to a
 * package price and is not. Required, with no default, so an omission is a
 * failure rather than a silent PER_ITEM.
 */
const FLYER_PROMPT =
  "You are reading one page of a Canadian grocery flyer. List EVERY advertised " +
  "product offer on the page — work across the whole page, tile by tile, and " +
  "do not stop after the first few. A full page of a Montreal grocery flyer " +
  "typically carries between ten and thirty offers; a page of this kind with " +
  "no offers at all is rare and usually means a section divider or a page of " +
  "policy text. If a page really has none, return an empty list, but check the " +
  "whole page first.\n\n" +
  "For each offer:\n" +
  "- advertisedText: the product wording exactly as printed, in the flyer's own " +
  "language. Do not translate, tidy or expand it.\n" +
  "- brand: the brand name if one is printed, otherwise null.\n" +
  "- size: the pack size as printed (\"551 mL\", \"375 g\", \"1 kg\"), otherwise null.\n" +
  "- retailerSku: the retailer's article number if the tile prints one, such as " +
  "\"N° 51087737\" — digits only, otherwise null.\n" +
  "- priceDollars and priceCents: the two numerals of the sale price exactly as " +
  "shown. A price displayed as a large 4 with a small 99 is priceDollars 4, " +
  "priceCents 99. A price shown as 44 cents is priceDollars 0, priceCents 44.\n" +
  "- basis: PER_ITEM when the price is for the item as sold (\"each\", \"chacun\", " +
  "\"le paquet\", or no unit shown), PER_LB when marked /lb, PER_KG when marked " +
  "/kg, PER_100G or PER_100ML when marked per 100 g or 100 ml. Look carefully: " +
  "the unit is printed much smaller than the price.\n" +
  "- regularDollars and regularCents: the struck-through or \"reg.\" price if the " +
  "tile prints one, otherwise null for both.\n" +
  "- regularBasis: what the REGULAR price is per, using the same values as " +
  "basis. Flyers often print a sale price per pound beside a regular price per " +
  "kilogram — read each one's own unit, do not copy the sale price's. Null " +
  "when there is no regular price.\n" +
  "- condition: UNIT_PRICE for a plain price; MULTI_BUY for \"2 for $5\"; " +
  "LOYALTY_ONLY when a card is required; LIMIT_APPLIES when a quantity limit is " +
  "printed; WITH_PURCHASE when it depends on buying something else.\n" +
  "- conditionText: the qualifying words exactly as printed (\"limite 4\", " +
  "\"2 for $5\", \"avec carte\"), otherwise null.\n\n" +
  "Also report validFrom and validTo: the dates this flyer runs, as YYYY-MM-DD, " +
  "if they are printed on this page — flyers print them as \"du 13 au 19 aout\" " +
  "or \"valid August 13 to 19\". Use ONLY the year printed on the page; if no " +
  "year is printed, return null for both rather than assuming the current one. " +
  "Return null for both if no dates appear on this page.\n\n" +
  "Also report retailerName: the name of the store whose logo or branding " +
  "appears on this page — Maxi, IGA, Walmart, Metro, Super C, Provigo — or " +
  "null if no store branding is visible. Report the brand printed on the page, " +
  "never a guess from the products.\n\n" +
  "Report only what is printed on this page. If you cannot read a price " +
  "clearly, omit that offer entirely rather than guessing at it. Do not infer a " +
  "price from a similar product elsewhere on the page.";

const FLYER_SCHEMA = {
  type: "object",
  properties: {
    retailerName: { type: "string", nullable: true },
    validFrom: { type: "string", nullable: true },
    validTo: { type: "string", nullable: true },
    offers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          advertisedText: { type: "string" },
          brand: { type: "string", nullable: true },
          size: { type: "string", nullable: true },
          retailerSku: { type: "string", nullable: true },
          priceDollars: { type: "integer" },
          priceCents: { type: "integer" },
          basis: {
            type: "string",
            enum: ["PER_ITEM", "PER_LB", "PER_KG", "PER_100G", "PER_100ML"],
          },
          regularDollars: { type: "integer", nullable: true },
          regularCents: { type: "integer", nullable: true },
          regularBasis: {
            type: "string",
            nullable: true,
            enum: ["PER_ITEM", "PER_LB", "PER_KG", "PER_100G", "PER_100ML"],
          },
          condition: {
            type: "string",
            enum: [
              "UNIT_PRICE",
              "MULTI_BUY",
              "LOYALTY_ONLY",
              "LIMIT_APPLIES",
              "WITH_PURCHASE",
            ],
          },
          conditionText: { type: "string", nullable: true },
        },
        required: [
          "advertisedText",
          "priceDollars",
          "priceCents",
          "basis",
          "condition",
        ],
      },
    },
  },
  required: ["offers"],
} as const;

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
    /**
     * How much of the cart could not be read at all.
     *
     * A list of six products from a photograph containing eleven is not a
     * reading of that cart, and until now nothing distinguished the two. The
     * shopper is the only one who can decide whether to take another photo,
     * and they can only decide that if they are told what was missed.
     */
    obscured_count: { type: "integer", nullable: true },
    obscured_note: { type: "string", nullable: true },
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

  // Answered before any image is required: "which models may I use" is a
  // question about the API key, not about a photo. Asking it should not need a
  // cart photo to hand.
  if (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { mode?: unknown }).mode === "models"
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return json(
        {
          ok: true,
          mode: "models",
          configured: Deno.env.get("CARTMATCH_GEMINI_MODEL") ?? DEFAULT_MODEL,
          availableModels: await listUsableModels(apiKey, controller.signal),
        },
        200,
        origin,
      );
    } finally {
      clearTimeout(timer);
    }
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
  // A LIST, not a name. CARTMATCH_GEMINI_MODEL may be one id or several
  // separated by commas, tried in order — because "this model is busy right
  // now" is a fact about one model at one moment, and a key that can call
  // three of them should not be stopped by the first being under load.
  const models = modelChain(Deno.env.get("CARTMATCH_GEMINI_MODEL"));
  const model = models[0] ?? DEFAULT_MODEL;
  const thinkingBudget = Number.parseInt(
    Deno.env.get("CARTMATCH_GEMINI_THINKING_BUDGET") ?? "0",
    10,
  );

  // One function, two readers. A flyer page and a cart photo need different
  // prompts and different schemas, and nothing else — so this stays one
  // deployment holding one Gemini key rather than a fourth copy of the auth
  // and CORS code that already exists three times.
  const flyerMode =
    typeof payload === "object" &&
    payload !== null &&
    (payload as { mode?: unknown }).mode === "flyer";

  const parts: unknown[] = [{ text: flyerMode ? FLYER_PROMPT : VISION_PROMPT }];
  for (const img of images.slice(0, MAX_IMAGES)) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // Walk the list until one answers. A 503 or 429 moves to the next model
    // immediately rather than after a client-side wait: falling through costs
    // one request, and waiting out a busy model costs the caller half a minute
    // for something another model would have answered at once.
    let res: Response | null = null;
    let used = model;
    for (const candidate of models) {
      used = candidate;
      res = await callGemini(
        apiKey,
        candidate,
        parts,
        flyerMode,
        supportsThinking(candidate),
        Number.isFinite(thinkingBudget) ? thinkingBudget : 0,
        controller.signal,
      );
      if (res.ok) break;
      // 404 means this key cannot call that id at all — try the next one
      // rather than reporting a name the caller never chose.
      if (res.status !== 503 && res.status !== 429 && res.status !== 404) break;
      if (candidate !== models[models.length - 1]) {
        console.warn(`[cartmatch] ${candidate} returned ${res.status}; trying next model.`);
      }
    }
    if (!res) {
      return json({ ok: false, error: "No model was configured." }, 500, origin);
    }

    // Every configured name refused with 404, and Google's own model list
    // contradicts that — it advertises the very ids it just declined. Rather
    // than report a configuration error nobody can act on, ask what this key
    // may use and try the best of those once.
    //
    // The self-correction is bounded: one extra attempt, on a name the API
    // supplied this second, and if that fails too the error names both what
    // was configured and what was tried.
    if (!res.ok && res.status === 404) {
      const available = await listUsableModels(apiKey, controller.signal);
      const suggested = available.find((m) => !models.includes(m));
      if (suggested) {
        console.warn(
          `[cartmatch] ${models.join(", ")} all refused; trying ${suggested} from the live model list.`,
        );
        const retry = await callGemini(
          apiKey,
          suggested,
          parts,
          flyerMode,
          supportsThinking(suggested),
          Number.isFinite(thinkingBudget) ? thinkingBudget : 0,
          controller.signal,
        );
        if (retry.ok) {
          res = retry;
          used = suggested;
        }
      }
    }

    // thinkingConfig only exists on 2.5+. If the gate guessed wrong for a
    // future model family, drop it and retry rather than failing a scan.
    if (!res.ok && res.status === 400 && supportsThinking(used)) {
      const detail = await res.text();
      if (/thinking/i.test(detail)) {
        console.warn(
          `[cartmatch] ${used} rejected thinkingConfig; retrying without it.`,
        );
        res = await callGemini(apiKey, used, parts, flyerMode, false, 0, controller.signal);
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

      // A 404 on the model is not a failure to answer — it is the wrong name.
      // Google retires model ids, and a key issued later than a retirement
      // cannot use the id at all: "no longer available to new users". Guessing
      // a replacement name fails the same way, so ASK, and put the real
      // answer in front of whoever has to fix it.
      if (res.status === 404) {
        const available = await listUsableModels(apiKey, controller.signal);
        return json(
          {
            ok: false,
            code: "MODEL_NOT_AVAILABLE",
            model: used,
            availableModels: available,
            error:
              available.length > 0
                ? `Gemini does not offer ${models.map((m) => `"${m}"`).join(" or ")} to this API key. Set CARTMATCH_GEMINI_MODEL to one of: ${available.slice(0, 20).join(", ")}.`
                : `Gemini does not offer "${used}" to this API key, and the model list could not be read. ${detail.slice(0, 200)}`,
          },
          502,
          origin,
        );
      }

      // Busy is not broken. 503 means the model is under load and 429 means
      // this key is going too fast; both are answered by waiting, and neither
      // says anything about the page. Labelled so the caller can retry rather
      // than record a page as unreadable — a flyer that loses five pages of
      // eight to a passing spike is a flyer nobody can shop from.
      // Busy and too-fast are both answered by waiting, and they are answered
      // by waiting DIFFERENTLY. A 503 demand spike passes in seconds; a 429 is
      // a quota measured per minute, so a fifteen-second retry just spends
      // another request against the same window. Reported separately so the
      // caller can pace itself rather than back off blindly.
      if (res.status === 503 || res.status === 429) {
        return json(
          {
            ok: false,
            code: res.status === 429 ? "RATE_LIMITED" : "OVERLOADED",
            retryAfterSeconds: Number(res.headers.get("retry-after") ?? "") || null,
            error:
              res.status === 503
                ? `The ${model} model is busy right now.`
                : quotaMessage(detail),
          },
          503,
          origin,
        );
      }

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
    return json({ ok: true, raw: parsed, model: used, mode: flyerMode ? "flyer" : "cart" }, 200, origin);
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


/**
 * Which models this key may actually call.
 *
 * Asked rather than assumed. The model an app was written against gets retired,
 * and a key issued after the retirement gets a 404 with a message that is
 * accurate and unactionable — a newer model, but not which one. Google knows
 * the answer; this reads it back so nobody has to guess a name and redeploy to
 * find out whether the guess was right.
 *
 * Only models that can generateContent are returned. The list also carries
 * embedding and other models that would 404 differently and just as usefully.
 */
/**
 * Could this model read a page of a flyer?
 *
 * generateContent is necessary and not sufficient. Text-to-speech variants,
 * video and image-generation models and embedding models all advertise it and
 * none of them can look at a flyer tile and return structured offers — so
 * listing them as alternatives is advice that wastes somebody's evening.
 *
 * Gemma is excluded for a subtler reason: it does not support the response
 * schema this function relies on, so it would answer with free text that the
 * parser correctly rejects, page after page, looking like a bad flyer rather
 * than a bad model choice.
 */
function canReadAFlyerPage(name: string): boolean {
  return !/tts|embedding|aqa|imagen|veo|image-generation|video|gemma|learnlm/i.test(
    name,
  );
}

/**
 * Best candidate first, measured rather than assumed.
 *
 * Aliases used to rank first, on the reasoning that a "-latest" id cannot be
 * retired underneath a configuration. Then a real key returned
 * gemini-flash-latest in its own list of available models and then answered
 * 404 to it, sixteen pages in a row — Google advertises ids it will not serve,
 * so an alias is no safer than anything else and is harder to diagnose.
 *
 * Concrete flash versions now lead, newest first, because those are what
 * actually answered: gemini-3.5-flash read 257 offers off a Maxi flyer that
 * gemini-flash-latest could not open. Lite variants follow — cheaper, and they
 * lose the fine print first, which on a flyer is the size and the unit.
 * Aliases sit after those as a fallback, and pro last: slower, and this is
 * transcription rather than reasoning.
 */
function rankModel(name: string): number {
  const version = Number(/gemini-(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? "0");
  // Negated so a higher version sorts earlier within each band.
  if (/flash/.test(name) && !/lite|latest|image|preview/.test(name)) {
    return 100 - version;
  }
  if (/flash/.test(name) && !/latest/.test(name)) return 200 - version;
  if (/flash/.test(name)) return 300;
  if (/pro/.test(name)) return 400;
  return 500;
}

async function listUsableModels(
  apiKey: string,
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`,
      { signal },
    );
    if (!res.ok) return [];
    const body = await res.json();
    const models = Array.isArray(body?.models) ? body.models : [];
    return models
      .filter((m: { supportedGenerationMethods?: unknown }) =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent"),
      )
      .map((m: { name?: unknown }) => String(m.name ?? "").replace(/^models\//, ""))
      .filter((name: string) => name !== "" && canReadAFlyerPage(name))
      // Aliases first. A "-latest" id follows whatever the current model is,
      // so it cannot be retired underneath a configuration — which is exactly
      // how this broke twice.
      .sort((a: string, b: string) => rankModel(a) - rankModel(b));
  } catch {
    // The point of this call is to improve an error message. Failing to
    // improve it must never replace the original error with a worse one.
    return [];
  }
}

function callGemini(
  apiKey: string,
  model: string,
  parts: unknown[],
  flyerMode: boolean,
  withThinking: boolean,
  thinkingBudget: number,
  signal: AbortSignal,
): Promise<Response> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseSchema: flyerMode ? FLYER_SCHEMA : CART_VISION_SCHEMA,
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
