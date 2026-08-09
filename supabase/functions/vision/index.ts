/**
 * POST /functions/v1/vision — cart photo -> structured product list.
 *
 * This function exists for exactly one reason: GEMINI_API_KEY cannot live in a
 * static site. On GitHub Pages the bundle is public (and so is the repo), so a
 * key shipped to the browser is a published key. Here it stays in Supabase
 * secrets and never leaves the function.
 *
 * Deploy:
 *   supabase functions deploy vision
 *   supabase secrets set GEMINI_API_KEY=...
 *
 * Verification status: written against the documented Gemini REST contract and
 * the Supabase Edge Function runtime, but never executed — no Gemini key and no
 * Supabase project were reachable from the environment this was written in.
 * The first real call is the acceptance test.
 */

import { authenticate } from "../_shared/auth.ts";
import { json, preflight } from "../_shared/cors.ts";

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

  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
  if (apiKey === "") {
    return json(
      {
        ok: false,
        code: "NO_API_KEY",
        error:
          "GEMINI_API_KEY is not set on this Edge Function. Run: supabase secrets set GEMINI_API_KEY=...",
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
    return json(
      { ok: false, error: "No images supplied." },
      400,
      origin,
    );
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

  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
  const thinkingBudget = Number.parseInt(
    Deno.env.get("GEMINI_THINKING_BUDGET") ?? "0",
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
        console.warn(`[cartmatch] ${model} rejected thinkingConfig; retrying without it.`);
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
