/**
 * POST /functions/v1/cartmatch-flyer-worker
 *
 * Reads queued flyer pages after the browser tab has closed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Reading a seventeen-page flyer takes upwards of half an hour, nearly all of
 * it waiting out an API quota. The browser used to drive that loop, so the tab
 * had to stay open — and on an iPhone Safari suspends background tabs, so even
 * an open tab stalls when the screen locks.
 *
 * The browser now does only what it alone can do: render the PDF, which never
 * leaves the device, upload the page images, and queue a row per page. That
 * takes about two minutes. This function does the rest, on a schedule, whether
 * or not anybody is watching. A quota that resets tomorrow morning is picked
 * up by the next tick instead of needing somebody to notice.
 *
 * ---------------------------------------------------------------------------
 * A FEW PAGES PER TICK, THEN RETURN
 * ---------------------------------------------------------------------------
 * Deliberately not a loop that drains the queue. A scheduled function that
 * runs for twenty minutes is a function that gets killed halfway through and
 * leaves rows claimed by a worker that no longer exists. Short ticks recover
 * naturally: whatever was not finished is still PENDING a minute later.
 *
 * ---------------------------------------------------------------------------
 * THIS RUNS WITH SERVICE CREDENTIALS. READ BEFORE CHANGING IT.
 * ---------------------------------------------------------------------------
 * There is no user session at three in the morning, so this uses the service
 * role key and Row Level Security does not apply to it. Two consequences, both
 * load-bearing:
 *
 *   IT IS GATED BY A SHARED SECRET, not by a user's token. Without
 *   CARTMATCH_WORKER_KEY matching, nothing happens. That header is the only
 *   thing between the open internet and a service-role database connection.
 *
 *   EVERY ROW IT WRITES CARRIES THE QUEUE ROW'S user_id. The worker never
 *   chooses an owner; it copies the one the browser recorded. So the offers it
 *   produces are governed by exactly the same RLS as offers written by hand,
 *   and one person's flyer cannot produce another person's data.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

import { parseFlyerExtraction } from "../_shared/parseOffers.ts";
import { quotaMessage } from "../_shared/quota.ts";

/** Which build answered. Same reason as the other functions: a silent stale
 *  deploy is indistinguishable from a working one until you check. */
const FUNCTION_BUILD = "2026-08-14-worker-5";

/**
 * Pages per tick.
 *
 * Small on purpose. Each page is a Gemini call that can take twenty seconds,
 * and an Edge Function has a wall-clock limit — three is comfortably inside it
 * even when every page is slow, and the queue drains at roughly three pages a
 * minute, which finishes a five-flyer week in under half an hour.
 */
const PAGES_PER_TICK = 3;

/**
 * How many times a page is attempted before it is left alone.
 *
 * A wrong model name or a corrupt image fails identically however often it is
 * asked, and a queue that never drains is a quota spent on nothing. Five is
 * enough to ride out a bad afternoon and few enough to stop.
 */
const MAX_ATTEMPTS = 5;

const DEFAULT_MODEL = "gemini-3.7-flash,gemini-3.5-flash,gemini-flash-latest";
const TIMEOUT_MS = 90_000;
const FLYER_BUCKET = "cartmatch-flyers";

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    // The whole handler, wrapped. A scheduled job posting into a function that
    // throws gets "Internal Server Error" and cron records a success, so the
    // failure is invisible from both ends. The message goes in the body where
    // net._http_response will keep it.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cartmatch-worker] ${message}`);
    return json(
      { ok: false, build: FUNCTION_BUILD, error: message.slice(0, 500) },
      500,
    );
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST." }, 405);
  }

  // The whole security boundary. Nothing below this line is reachable without
  // the shared secret, because everything below it runs as service role.
  const expected = Deno.env.get("CARTMATCH_WORKER_KEY") ?? "";
  if (expected === "") {
    return json(
      { ok: false, error: "CARTMATCH_WORKER_KEY is not set; refusing to run." },
      503,
    );
  }
  if (req.headers.get("x-cartmatch-worker-key") !== expected) {
    return json({ ok: false, error: "Not authorised." }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (url === "" || serviceKey === "") {
    return json({ ok: false, error: "Missing Supabase service credentials." }, 500);
  }
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  const apiKey =
    Deno.env.get("CARTMATCH_GEMINI_API_KEY") ??
    Deno.env.get("GEMINI_API_KEY") ??
    "";
  if (apiKey === "") {
    return json({ ok: false, error: "No Gemini key configured." }, 503);
  }

  // Free any page a previous tick claimed and never finished.
  //
  // try/catch rather than .catch(): a supabase-js query builder is PromiseLike
  // and does not reliably carry a .catch method, so calling one throws a
  // TypeError before the query is even sent — which is how this function
  // answered 500 to every scheduled tick with nothing in the body to say why.
  try {
    await supabase.rpc("cartmatch_release_stale_pages");
  } catch {
    // Nothing to release, or the function is missing. Neither should stop a
    // tick from doing the work it came for.
  }

  const { data: queued, error: queueError } = await supabase
    .from("cartmatch_flyer_pages")
    .select("*")
    .eq("status", "PENDING")
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(PAGES_PER_TICK);

  if (queueError) {
    return json({ ok: false, error: queueError.message }, 500);
  }
  if (!queued || queued.length === 0) {
    return json({ ok: true, build: FUNCTION_BUILD, processed: 0, note: "Queue empty." }, 200);
  }

  const models = (Deno.env.get("CARTMATCH_GEMINI_MODEL") ?? DEFAULT_MODEL)
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m !== "");

  const results: unknown[] = [];

  for (const page of queued) {
    // Claim first. Two ticks overlapping is normal when one runs long, and a
    // page read twice would write its offers twice.
    const { error: claimError } = await supabase
      .from("cartmatch_flyer_pages")
      .update({
        status: "READING",
        claimed_at: new Date().toISOString(),
        attempts: page.attempts + 1,
      })
      .eq("id", page.id)
      .eq("status", "PENDING");
    if (claimError) continue;

    const outcome = await readOnePage(supabase, apiKey, models, page);
    results.push(outcome);

    // A quota belongs to the key, not to the page. Once it is gone the next
    // two pages of this tick would spend nothing but time and come back with
    // the same refusal, so the tick ends here and the next one picks up.
    if ((outcome as { quotaGone?: boolean }).quotaGone) {
      return json(
        {
          ok: true,
          build: FUNCTION_BUILD,
          processed: results.length,
          note: "Stopped: the key is out of quota. Pages stay queued.",
          results,
        },
        200,
      );
    }
  }

  return json(
    { ok: true, build: FUNCTION_BUILD, processed: results.length, results },
    200,
  );
}

async function readOnePage(
  supabase: ReturnType<typeof createClient>,
  apiKey: string,
  models: string[],
  page: Record<string, unknown>,
): Promise<unknown> {
  const id = String(page.id);
  const pageNumber = Number(page.page_number);
  const flyerId = String(page.flyer_id);
  const userId = String(page.user_id);
  const path = String(page.storage_path);

  /**
   * Put the page back without spending one of its lives.
   *
   * `attempts` exists to stop a page that fails the same way however often it
   * is asked — a corrupt image, a name no model answers to. A quota is not
   * that. It is the key saying "not now", and the page is untouched.
   *
   * Counting it was quietly destructive: five pages a tick against a daily cap
   * that resets tomorrow morning would mark every remaining page FAILED within
   * the hour, and a flyer whose offers were merely late would become a flyer
   * whose offers were gone. The claim above already incremented the counter,
   * so this writes the original value back rather than leaving it.
   */
  const requeue = async (error: string) => {
    await supabase
      .from("cartmatch_flyer_pages")
      .update({
        status: "PENDING",
        claimed_at: null,
        attempts: Number(page.attempts),
        last_error: error.slice(0, 500),
        errored_at: new Date().toISOString(),
      })
      .eq("id", id);
    return { page: pageNumber, ok: false, error, quotaGone: true };
  };

  const fail = async (error: string) => {
    // Back to PENDING unless it has run out of attempts. The distinction
    // matters: PENDING will be tried again by a later tick, FAILED will not,
    // and the row keeps the reason either way.
    const attempts = Number(page.attempts) + 1;
    await supabase
      .from("cartmatch_flyer_pages")
      .update({
        status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
        claimed_at: null,
        last_error: error.slice(0, 500),
        errored_at: new Date().toISOString(),
      })
      .eq("id", id);
    return { page: pageNumber, ok: false, error };
  };

  const { data: file, error: downloadError } = await supabase.storage
    .from(FLYER_BUCKET)
    .download(path);
  if (downloadError || !file) {
    return await fail(`Could not read the stored page: ${downloadError?.message ?? "missing"}`);
  }

  const base64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: Response | null = null;
    let used = models[0] ?? DEFAULT_MODEL;

    for (const candidate of models) {
      used = candidate;
      res = await callGemini(apiKey, candidate, base64, controller.signal);
      if (res.ok) break;
      // Busy, rate-limited or unavailable: try the next model in the same
      // tick. Anything else fails the same way whoever is asked.
      if (res.status !== 503 && res.status !== 429 && res.status !== 404) break;
    }

    // Every configured name refused with 404 while Google's own list advertises
    // them. Ask what this key may actually use and try the best of those once,
    // rather than failing a page over a name.
    if (res && !res.ok && res.status === 404) {
      const available = await listUsableModels(apiKey, controller.signal);
      const suggested = available.find((m) => !models.includes(m));
      if (suggested) {
        const retry = await callGemini(apiKey, suggested, base64, controller.signal);
        if (retry.ok) {
          res = retry;
          used = suggested;
        }
      }
    }

    if (!res || !res.ok) {
      const body = res ? await res.text() : "";
      const detail = body.slice(0, 300) || "no response";

      // Told apart because the two answers are different: a per-minute cap
      // refills before the next tick, a per-day cap does not refill until
      // tomorrow. Neither is the page's fault, so neither costs it an attempt.
      if (res && res.status === 429) {
        return await requeue(quotaMessage(body));
      }

      return await fail(`Gemini ${res?.status ?? 0} on ${used}: ${detail}`);
    }

    const body = await res.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      return await fail("Gemini returned no JSON payload.");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return await fail("Gemini returned text that was not valid JSON.");
    }

    // The same parser the browser runs. See _shared/parseOffers.ts — one copy
    // of the rules that decide whether a number can reach a cashier.
    const { offers, rejected } = parseFlyerExtraction(raw, pageNumber);

    if (offers.length > 0) {
      const rows = offers.map((offer, index) => ({
        id: `${flyerId}:p${pageNumber}:${index}`,
        flyer_id: flyerId,
        // Copied from the queue row, never chosen. This is what keeps a
        // service-role write governed by the same RLS as a hand-written one.
        user_id: userId,
        advertised_text: offer.advertisedText,
        brand: offer.brand,
        size: offer.size,
        retailer_sku: offer.retailerSku,
        price_cents: offer.price,
        currency: offer.currency,
        regular_price_cents: offer.regularPrice,
        regular_basis: offer.regularBasis,
        basis: offer.basis,
        condition: offer.condition,
        condition_text: offer.conditionText,
        flyer_page: pageNumber,
        confirmed_at: null,
      }));

      const { error: insertError } = await supabase
        .from("cartmatch_flyer_offers")
        .upsert(rows, { onConflict: "id" });
      if (insertError) return await fail(`Saving offers failed: ${insertError.message}`);
    }

    await supabase
      .from("cartmatch_flyer_pages")
      .update({
        status: "DONE",
        claimed_at: null,
        read_at: new Date().toISOString(),
        model: used,
        offers_found: offers.length,
        last_error: rejected.length > 0 ? `${rejected.length} tiles discarded` : null,
        errored_at: null,
      })
      .eq("id", id);

    // The flyer's own tally, so the home screen can say how much is read
    // without counting rows on every visit.
    try {
      await supabase.rpc("cartmatch_recount_flyer", { flyer: flyerId });
    } catch {
      // The tally is a convenience for the home screen; the offers are already
      // saved, and a failed recount must not fail a page that was read.
    }

    // The extraction-sized image has done its job. The proof-sized copy is a
    // separate object and stays for the till.
    try {
      await supabase.storage.from(FLYER_BUCKET).remove([path]);
    } catch {
      // A leftover extraction image costs storage and nothing else.
    }

    return { page: pageNumber, ok: true, offers: offers.length, model: used };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await fail(
      message.toLowerCase().includes("abort")
        ? `Timed out after ${TIMEOUT_MS}ms.`
        : message,
    );
  } finally {
    clearTimeout(timer);
  }
}

function callGemini(
  apiKey: string,
  model: string,
  base64: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: FLYER_PROMPT },
              { inline_data: { mime_type: "image/jpeg", data: base64 } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: FLYER_SCHEMA,
          temperature: 0,
        },
      }),
    },
  );
}

/**
 * Which models this key may actually call, best first.
 *
 * Asked, not assumed — and filtered, because generateContent is necessary and
 * nowhere near sufficient: text-to-speech, video and Gemma models all
 * advertise it and none can read a flyer tile into structured offers.
 */
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
      .filter(
        (name: string) =>
          name !== "" &&
          !/tts|embedding|aqa|imagen|veo|image-generation|video|gemma|learnlm/i.test(
            name,
          ),
      )
      .sort((a: string, b: string) => rankModel(a) - rankModel(b));
  } catch {
    // Improving an error must never replace it with a worse one.
    return [];
  }
}

/** Concrete flash first, newest first; then lite, then aliases, then pro. */
function rankModel(name: string): number {
  const version = Number(/gemini-(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? "0");
  if (/flash/.test(name) && !/lite|latest|image|preview/.test(name)) {
    return 100 - version;
  }
  if (/flash/.test(name) && !/latest/.test(name)) return 200 - version;
  if (/flash/.test(name)) return 300;
  if (/pro/.test(name)) return 400;
  return 500;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ===========================================================================
// The prompt and schema, identical in intent to cartmatch-vision's flyer mode.
// ===========================================================================

const FLYER_PROMPT =
  "You are reading one page of a Canadian grocery flyer. List EVERY advertised " +
  "product offer on the page — work across the whole page, tile by tile, and " +
  "do not stop after the first few. A full page of a Montreal grocery flyer " +
  "typically carries between ten and thirty offers.\n\n" +
  "For each offer:\n" +
  "- advertisedText: the product wording exactly as printed, in the flyer's own " +
  "language. Do not translate or tidy it.\n" +
  "- brand: the brand name if printed, otherwise null.\n" +
  "- size: the pack size as printed (\"551 mL\", \"375 g\"), otherwise null.\n" +
  "- retailerSku: the retailer's article number if the tile prints one, digits " +
  "only, otherwise null.\n" +
  "- priceDollars and priceCents: the two numerals of the sale price exactly as " +
  "shown. A large 4 with a small 99 is priceDollars 4, priceCents 99. A price " +
  "shown as 44 cents is priceDollars 0, priceCents 44.\n" +
  "- basis: PER_ITEM when the price is for the item as sold, PER_LB when marked " +
  "/lb, PER_KG when marked /kg, PER_100G or PER_100ML when marked per 100 g or " +
  "100 ml. Look carefully: the unit is printed much smaller than the price.\n" +
  "- regularDollars and regularCents: the struck-through or \"reg.\" price if " +
  "printed, otherwise null.\n" +
  "- regularBasis: what the REGULAR price is per. Flyers often print a sale " +
  "price per pound beside a regular price per kilogram — read each one's own " +
  "unit.\n" +
  "- condition: UNIT_PRICE for a plain price; MULTI_BUY for \"2 for $5\"; " +
  "LOYALTY_ONLY when a card is required; LIMIT_APPLIES for a quantity limit; " +
  "WITH_PURCHASE when it depends on buying something else.\n" +
  "- conditionText: the qualifying words exactly as printed, otherwise null.\n\n" +
  "Report only what is printed on this page. If you cannot read a price " +
  "clearly, omit that offer rather than guessing at it.";

const FLYER_SCHEMA = {
  type: "object",
  properties: {
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

// ---------------------------------------------------------------------------
// END OF FILE — the lines below are deliberately comments.
// Ending on commentary means a truncated paste drops prose rather than code.
// ---------------------------------------------------------------------------
