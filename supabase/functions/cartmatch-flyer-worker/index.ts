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

import { parseFlyerBatch, parseFlyerExtraction } from "../_shared/parseOffers.ts";
import { quotaMessage } from "../_shared/quota.ts";
import { DEFAULT_MODEL_CHAIN, modelChain } from "../_shared/models.ts";
import { affordableModels, workerCeiling } from "../_shared/budget.ts";
import { FLYER_PROMPT, FLYER_SCHEMA } from "../_shared/flyerPrompt.ts";

/** Which build answered. Same reason as the other functions: a silent stale
 *  deploy is indistinguishable from a working one until you check. */
const FUNCTION_BUILD = "2026-08-15-worker-14";

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

/**
 * How many pages ride in one request.
 *
 * A week of five flyers is about seventy pages, and at one request per page
 * that is seventy requests against a per-model daily allowance. Three pages to
 * a request turns the same week into about twenty-four, without reading any
 * fewer pages — the throughput of a tick is unchanged, only the number of times
 * it knocks on the door.
 *
 * Only pages that have never been attempted are batched. Anything that has
 * already struggled is read alone, where the model has one page to think about
 * and a failure names one page rather than three. Set to 1 to turn batching off
 * entirely.
 */
const PAGES_PER_REQUEST = Number(Deno.env.get("CARTMATCH_PAGES_PER_REQUEST") ?? "3");

/** See _shared/models.ts — one list, so the worker and the scan agree. */
const DEFAULT_MODEL = DEFAULT_MODEL_CHAIN;
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

  const configured = modelChain(Deno.env.get("CARTMATCH_GEMINI_MODEL"));

  // Hold back a few requests on every model so a scan can still be answered.
  // An import that waits an hour costs nothing; a shopper standing at a shelf
  // whose photograph will not read has no recourse at all.
  const used = await requestsToday(supabase);
  const models = affordableModels(configured, used);
  if (models.length === 0) {
    // Say so on the pages themselves, not only in this reply.
    //
    // Holding leaves them PENDING, which is correct — they will be read when
    // the allowance resets. But PENDING with nothing recorded is precisely the
    // shape the home card reads as "still working": a spinner over a queue
    // that will not move until tomorrow, with no reason on screen. That exact
    // failure cost an evening once already, and it must not be reintroduced by
    // the mechanism built to prevent a different one.
    //
    // Attempts and status are untouched. This is a note, not a verdict.
    const reason =
      "Today's model allowance is reserved for scanning. Reading resumes when it resets (midnight Pacific).";
    try {
      await supabase
        .from("cartmatch_flyer_pages")
        .update({ last_error: reason, errored_at: new Date().toISOString() })
        .in("id", queued.map((p) => p.id));
    } catch {
      // The reply below still carries the reason.
    }

    return json(
      {
        ok: true,
        build: FUNCTION_BUILD,
        processed: 0,
        note: reason,
        used,
        ceilings: Object.fromEntries(configured.map((m) => [m, workerCeiling(m)])),
      },
      200,
    );
  }

  const results: unknown[] = [];

  // Batching is only safe inside one flyer. Page labels are how a reply is
  // aligned back to the images it answered, and every flyer has a page 3 — so
  // a mixed batch could align perfectly and still put IGA's offers on Maxi's
  // page. Same flyer, or read alone.
  const fresh = queued.filter((p) => Number(p.attempts) === 0);
  const firstFlyer = fresh[0] ? String(fresh[0].flyer_id) : null;
  const batch =
    firstFlyer === null
      ? []
      : fresh
          .filter((p) => String(p.flyer_id) === firstFlyer)
          .slice(0, PAGES_PER_REQUEST);

  const batched = new Set(batch.map((p) => String(p.id)));
  // A batch of one is just a page. Anything already attempted is read alone,
  // where a failure names one page instead of three.
  const singles =
    batch.length > 1
      ? queued.filter((p) => !batched.has(String(p.id)))
      : queued;

  if (batch.length > 1) {
    const claimed: Record<string, unknown>[] = [];
    for (const page of batch) {
      if (await claim(supabase, page)) claimed.push(page);
    }
    // One survivor means another worker took the rest between the select and
    // the claim. It is already marked READING, so it has to be read here or it
    // waits out the stale sweep for nothing.
    if (claimed.length === 1) {
      results.push(await readOnePage(supabase, apiKey, models, claimed[0]!));
    } else if (claimed.length > 1) {
      const outcome = await readBatch(supabase, apiKey, models, claimed);
      results.push(outcome);
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
  }

  for (const page of singles) {
    if (!(await claim(supabase, page))) continue;

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

/**
 * What this app has sent today, by model.
 *
 * Best-effort on purpose. If the table or the function is missing — a
 * deployment where budget.sql has not been run — this returns nothing spent,
 * and the worker behaves exactly as it did before the budget existed. Reading
 * a counter must never be the reason a flyer goes unread.
 */
async function requestsToday(
  supabase: ReturnType<typeof createClient>,
): Promise<Record<string, number>> {
  try {
    const { data, error } = await supabase.rpc("cartmatch_requests_today");
    if (error || !Array.isArray(data)) return {};
    const out: Record<string, number> = {};
    for (const row of data) {
      out[String((row as { model: unknown }).model)] = Number(
        (row as { requests: unknown }).requests ?? 0,
      );
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Record one request, sent or refused.
 *
 * Counted on the way out rather than on success: a 429 is still a request as
 * far as Google's counter is concerned, and a budget that only counted the
 * successful ones would run out precisely when it claimed there was room.
 */
async function noteRequest(
  supabase: ReturnType<typeof createClient>,
  model: string,
): Promise<void> {
  try {
    await supabase.rpc("cartmatch_note_request", { model_name: model });
  } catch {
    // Bookkeeping. Never the reason a page fails.
  }
}

/**
 * Take a page, so a second worker does not take it too.
 *
 * The `status = PENDING` condition is what makes overlapping ticks safe: two
 * workers can both select the same row, and only one update matches. Returns
 * false when somebody else got there first.
 */
async function claim(
  supabase: ReturnType<typeof createClient>,
  page: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await supabase
    .from("cartmatch_flyer_pages")
    .update({
      status: "READING",
      claimed_at: new Date().toISOString(),
      attempts: Number(page.attempts) + 1,
    })
    .eq("id", page.id)
    .eq("status", "PENDING");
  return !error;
}

/**
 * Read several pages of one flyer in a single request.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SAVED AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * The saving is requests, not work. The same pages are read at the same size
 * with the same prompt; three of them simply travel together. A week of five
 * flyers goes from about seventy requests to about twenty-four, which is the
 * difference between a workload that fits inside a free daily allowance and one
 * that spills over several days.
 *
 * ---------------------------------------------------------------------------
 * A BATCH IS ALL OR NOTHING
 * ---------------------------------------------------------------------------
 * If the reply cannot be aligned to the pages sent — a group missing, a label
 * repeated, a page nobody asked for — every page in the batch goes back to the
 * queue and is read alone next time, because each has now spent an attempt.
 * Nothing from an unalignable reply is written.
 *
 * The reason is the citation. Offers filed under the wrong page number look
 * entirely normal and send somebody to a page that does not carry the product,
 * which is worse at a price-match desk than having no page at all.
 */
async function readBatch(
  supabase: ReturnType<typeof createClient>,
  apiKey: string,
  models: string[],
  pages: Record<string, unknown>[],
): Promise<unknown> {
  const flyerId = String(pages[0]!.flyer_id);
  const userId = String(pages[0]!.user_id);
  const numbers = pages.map((p) => Number(p.page_number));

  /** Hand the whole batch back, with a reason on every page. */
  const failAll = async (error: string, keepAttempts = false) => {
    for (const page of pages) {
      await supabase
        .from("cartmatch_flyer_pages")
        .update({
          status: keepAttempts
            ? "PENDING"
            : Number(page.attempts) + 1 >= MAX_ATTEMPTS
              ? "FAILED"
              : "PENDING",
          claimed_at: null,
          ...(keepAttempts ? { attempts: Number(page.attempts) } : {}),
          last_error: error.slice(0, 500),
          errored_at: new Date().toISOString(),
        })
        .eq("id", page.id);
    }
    return { pages: numbers, ok: false, error, quotaGone: keepAttempts };
  };

  const images: string[] = [];
  for (const page of pages) {
    const { data: file, error: downloadError } = await supabase.storage
      .from(FLYER_BUCKET)
      .download(String(page.storage_path));
    if (downloadError || !file) {
      return await failAll(
        `Could not read stored page ${page.page_number}: ${downloadError?.message ?? "missing"}`,
      );
    }
    images.push(encodeBase64(new Uint8Array(await file.arrayBuffer())));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: Response | null = null;
    let used = models[0] ?? DEFAULT_MODEL;
    for (const candidate of models) {
      used = candidate;
      res = await callGeminiBatch(apiKey, candidate, images, numbers, controller.signal);
      await noteRequest(supabase, candidate);
      if (res.ok) break;
      if (res.status !== 503 && res.status !== 429 && res.status !== 404) break;
    }

    if (!res || !res.ok) {
      const body = res ? await res.text() : "";
      if (res && res.status === 429) {
        // Not the pages' fault. They keep their attempts and stay batchable.
        return await failAll(quotaMessage(body), true);
      }
      return await failAll(
        `Gemini ${res?.status ?? 0} on ${used}: ${(body || "no response").slice(0, 260)}`,
      );
    }

    const payload = await res.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") return await failAll("Gemini returned no JSON payload.");

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return await failAll("Gemini returned text that was not valid JSON.");
    }

    const { byPage, error: alignError } = parseFlyerBatch(raw, numbers);
    if (alignError) {
      // Every page here now has one attempt against it, so the next tick reads
      // them singly. That is the fallback, and it needs no extra state.
      return await failAll(`Batch could not be aligned: ${alignError}`);
    }

    const written: { page: number; offers: number }[] = [];
    for (const page of pages) {
      const pageNumber = Number(page.page_number);
      const parsed = byPage.get(pageNumber)!;

      if (parsed.offers.length > 0) {
        const rows = parsed.offers.map((offer, index) => ({
          id: `${flyerId}:p${pageNumber}:${index}`,
          flyer_id: flyerId,
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
        if (insertError) {
          return await failAll(`Saving offers failed: ${insertError.message}`);
        }
      }

      await supabase
        .from("cartmatch_flyer_pages")
        .update({
          status: "DONE",
          claimed_at: null,
          read_at: new Date().toISOString(),
          model: used,
          offers_found: parsed.offers.length,
          last_error:
            parsed.rejected.length > 0 ? `${parsed.rejected.length} tiles discarded` : null,
          errored_at: null,
        })
        .eq("id", page.id);

      try {
        await supabase.storage.from(FLYER_BUCKET).remove([String(page.storage_path)]);
      } catch {
        // A leftover extraction image costs storage and nothing else.
      }

      written.push({ page: pageNumber, offers: parsed.offers.length });
    }

    try {
      await supabase.rpc("cartmatch_recount_flyer", { flyer: flyerId });
    } catch {
      // The tally is a convenience for the home screen; the offers are saved.
    }

    return { batch: written, ok: true, model: used };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await failAll(
      message.toLowerCase().includes("abort") ? `Timed out after ${TIMEOUT_MS}ms.` : message,
    );
  } finally {
    clearTimeout(timer);
  }
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
      await noteRequest(supabase, candidate);
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
        await noteRequest(supabase, suggested);
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
 * One request, several pages, each labelled so the reply can be checked.
 *
 * The label is sent as text immediately before its image. The model is asked
 * to echo it back, and parseFlyerBatch refuses any reply whose labels are not
 * exactly the ones sent — so a label is a checksum here, not a fact taken on
 * trust.
 */
function callGeminiBatch(
  apiKey: string,
  model: string,
  images: string[],
  pages: number[],
  signal: AbortSignal,
): Promise<Response> {
  const parts: unknown[] = [{ text: batchPrompt(pages) }];
  images.forEach((data, index) => {
    parts.push({ text: `PAGE ${pages[index]}:` });
    parts.push({ inline_data: { mime_type: "image/jpeg", data } });
  });

  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: batchSchema(),
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

// The prompt and schema live in _shared/flyerPrompt.ts — one set of
// instructions, because the worker and the vision function read the same pages.


const batchPrompt = (pages: number[]): string =>
  `You are reading ${pages.length} pages of one Canadian grocery flyer: ` +
  `pages ${pages.join(", ")}. Each image below is preceded by a line naming ` +
  `its page number.\n\n` +
  `Return one entry per page, with pageNumber set to that page's number ` +
  `exactly as labelled, and offers listing EVERY advertised product offer on ` +
  `that page. Do not merge pages. Do not omit a page: a page with no offers ` +
  `on it takes an entry with an empty offers list.\n\n` +
  FLYER_PROMPT.replace("You are reading one page of a Canadian grocery flyer. ", "");

/**
 * Built when it is needed, not when the module loads.
 *
 * It used to be a module-level const reaching into an imported object —
 * `FLYER_SCHEMA.properties.offers`. Anything that throws at module scope
 * happens before Deno.serve is reached, so the handler's try/catch does not
 * exist yet and the platform answers a bare "Internal Server Error" with no
 * body: the one failure shape this function cannot explain about itself.
 *
 * Nothing here needs to happen at load. Building it inside the call means the
 * worst case is a caught exception with a message, which is the difference
 * between a debuggable failure and an evening.
 */
function batchSchema() {
  return {
    type: "object",
    properties: {
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            pageNumber: { type: "integer" },
            offers: FLYER_SCHEMA.properties.offers,
          },
          required: ["pageNumber", "offers"],
        },
      },
    },
    required: ["pages"],
  };
}

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------
//
// These were deleted by accident when the prompt moved to _shared, and the
// consequence was invisible in exactly the worst way: `json` is what the
// top-level catch uses to report a failure, so the error handler threw while
// handling the error and the platform answered a bare "Internal Server Error"
// with no body. Every scheduled tick failed for hours saying nothing.
//
// The file still parsed, still deployed, still had balanced braces and no
// duplicate names. Nothing but running it could have found this.

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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

// ---------------------------------------------------------------------------
// END OF FILE — the lines below are deliberately comments.
// Ending on commentary means a truncated paste drops prose rather than code.
// ---------------------------------------------------------------------------
