"use client";

/**
 * Keeping a week's flyers: the offers, and the pages that prove them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PAGES ARE STORED AT ALL
 * ---------------------------------------------------------------------------
 * A price with no document is exactly what a price-match desk declines. The
 * import used to read the prices and throw the pages away — it had to, since
 * five flyers of full-size images kills a phone tab and nothing survived a
 * reload. So "IGA has it for $4.99" could never become "IGA, page 7, valid
 * until the 19th, here is the page", which is the only form that works at
 * checkout.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SAVED, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * The PDF itself is never uploaded. Only the rendered pages go, at proof size
 * rather than extraction size — around 250 KB instead of a megabyte, because
 * the job of a stored page is to be readable when pinched at a checkout, not
 * to be read by a model a second time.
 *
 * Offers are saved as CANDIDATES: `confirmedAt` is null until a person has
 * looked at the page and agreed. Every official flyer PDF measured is artwork,
 * so nothing in one can be corroborated against the file's own text, and an
 * unconfirmed offer must never reach a cashier.
 */

import { createClient } from "@/lib/auth/client";
import { supabaseConfigured, edgeFunctionUrl, env } from "@/config/env";
import { getAccessToken } from "@/lib/auth/session";
import type { RetailerId } from "@/types";
import type { ExtractedOffer } from "./pdf/types";
import type { OfferCondition, PriceBasis } from "@/types/flyer";
import { looksLikeCurrentWeek } from "./status";

/**
 * The browser client, or null when Supabase is not configured.
 *
 * `createClient` throws in that case, which is right for a login form and
 * wrong here: an import that cannot reach storage should report a reason, not
 * take the page down.
 */
function client(): ReturnType<typeof createClient> | null {
  if (!supabaseConfigured()) return null;
  try {
    return createClient();
  } catch {
    return null;
  }
}

/**
 * Every row a query matches, fetched in slices.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — READ THIS BEFORE WRITING ANOTHER SELECT
 * ---------------------------------------------------------------------------
 * PostgREST caps a single response at the project's `max-rows` setting, 1000
 * by default. It does not fail, warn, or set a flag when it truncates: a query
 * matching 1,200 rows returns 1,000 of them and looks exactly like a query
 * matching 1,000. Everything downstream then computes a confident, wrong,
 * smaller answer.
 *
 * That is not hypothetical here. Six flyers of a normal week crossed the cap
 * and one whole store silently vanished from the comparison screen — not shown
 * as missing, simply absent, with the totals adding up to precisely 1000.
 *
 * So: any query whose result grows with the data goes through this. It slices
 * with `.range()` and advances by however many rows actually came back, so it
 * is correct whatever `max-rows` is set to — including if somebody lowers it.
 * It stops on a short read of zero, which costs one extra round trip and buys
 * not having to assume the server's limit matches ours.
 *
 * The ordering must be UNIQUE and STABLE. Paging over an unordered query can
 * return the same row twice and skip another, because two requests are two
 * different snapshots with no defined order between them.
 */
const SLICE = 500;

/** A runaway guard. Hitting it is a bug, and it says so rather than truncating. */
const MAX_ROWS = 50_000;

type Slice = { data: unknown[] | null; error: { message: string } | null };

/** Exported so the slicing can be tested without a database behind it. */
export async function fetchAllRows(
  slice: (from: number, to: number) => PromiseLike<Slice>,
): Promise<
  { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }
> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await slice(from, from + SLICE - 1);
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "The query returned nothing at all." };
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length === 0) return { ok: true, rows };
    from += data.length;
    if (rows.length >= MAX_ROWS) {
      // Never return a silently short answer. Somebody has far more data than
      // this app was built for, and a named failure is the only honest reply.
      return {
        ok: false,
        error: `More than ${MAX_ROWS} rows matched. Delete flyers you no longer need.`,
      };
    }
  }
}

export const FLYER_BUCKET = "cartmatch-flyers";

/** Kept for a few days past the last advertised day, then deleted. */
export const PAGE_GRACE_DAYS = 3;

export interface StoredFlyer {
  id: string;
  retailerId: RetailerId;
  validFrom: string;
  validTo: string;
  pageCount: number;
  pagesRead: number;
  sourceFilename: string | null;
  validitySource: "FILENAME" | "COVER" | "MANUAL" | "UNKNOWN";
}

export interface SaveFlyerInput extends StoredFlyer {
  offers: ExtractedOffer[];
  /**
   * Proof-sized JPEG data URLs, keyed by page number. Empty when the shopper
   * has chosen not to keep pictures — the offers and their page numbers are
   * saved either way, so a citation still works without them.
   */
  pageImages: Map<number, string>;
}

/**
 * Upload a flyer's pages and queue them to be read later.
 *
 * The half of the job only a browser can do: the PDF is rendered here and
 * never leaves the device, the page images go up, and a row per page goes into
 * the queue. Two minutes, and then the tab can close — a scheduled worker
 * reads the pages afterwards, whether or not anybody is watching.
 *
 * Both sizes are uploaded, for different lifetimes. The extraction-sized image
 * is what the model reads and the worker deletes it once the page is done; the
 * proof-sized one is what a cashier is shown and stays for the flyer's run.
 * Keeping only the small one would save storage and cost the model the fine
 * print, which on a flyer is the size and the unit.
 */
export async function queueFlyerForReading(input: {
  flyer: StoredFlyer;
  pages: { pageNumber: number; extractionDataUrl: string; proofDataUrl: string }[];
  keepProofPages: boolean;
  onProgress?: (uploaded: number, total: number) => void;
}): Promise<
  | { ok: true; queued: number; proofsFailed: number }
  | { ok: false; error: string }
> {
  const supabase = client();
  if (!supabase) return { ok: false, error: "Supabase is not configured." };

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return { ok: false, error: "Sign in first." };

  const { error: flyerError } = await supabase.from("cartmatch_flyers").upsert(
    {
      id: input.flyer.id,
      user_id: userId,
      retailer_id: input.flyer.retailerId,
      valid_from: input.flyer.validFrom,
      valid_to: input.flyer.validTo,
      page_count: input.flyer.pageCount,
      // Zero until the worker reports otherwise. Claiming pages are read
      // because they are uploaded is the same lie as calling a run complete
      // when nothing was read.
      pages_read: 0,
      source_filename: input.flyer.sourceFilename,
      validity_source: input.flyer.validitySource,
    },
    { onConflict: "id" },
  );
  if (flyerError) return { ok: false, error: flyerError.message };

  // A re-import replaces the previous reading of this flyer entirely — the
  // rows AND the pictures.
  //
  // The pictures matter because the paths are page-numbered. Replacing a
  // seventeen-page flyer with a seven-page one overwrites p01 to p07 and
  // leaves p08 to p17 behind, and the weekly purge then walks pageCount —
  // now seven — and never reaches them. Files nothing can name, taking space
  // forever. Clearing first is the only way that stays true whatever the two
  // page counts are.
  const { data: existing } = await supabase.storage
    .from(FLYER_BUCKET)
    .list(`${userId}/${input.flyer.id}`, { limit: 500 });
  if (existing && existing.length > 0) {
    await supabase.storage
      .from(FLYER_BUCKET)
      .remove(existing.map((f) => `${userId}/${input.flyer.id}/${f.name}`));
  }

  await supabase.from("cartmatch_flyer_offers").delete().eq("flyer_id", input.flyer.id);
  await supabase.from("cartmatch_flyer_pages").delete().eq("flyer_id", input.flyer.id);

  let queued = 0;
  let proofsFailed = 0;
  for (const page of input.pages) {
    const readPath = extractionPath(userId, input.flyer.id, page.pageNumber);

    const extraction = dataUrlToBlob(page.extractionDataUrl);
    if (!extraction) continue;

    const { error: upErr } = await supabase.storage
      .from(FLYER_BUCKET)
      .upload(readPath, extraction, {
        contentType: "image/jpeg",
        upsert: true,
      });
    if (upErr) return { ok: false, error: `Uploading page ${page.pageNumber}: ${upErr.message}` };

    // The proof page, and its failures are not silent.
    //
    // This upload used to discard its result while the extraction upload above
    // checked its own. So a proof image that failed to store left no trace —
    // and the page number was recorded anyway, which means the citation went
    // on promising a picture that was not there. Somebody checking a price
    // against "IGA page 7" got a blank space and had to open their own PDF.
    //
    // A failure here does not abandon the import: the offers are the point and
    // a citation still names the flyer, the page and the dates without a
    // picture. But it is counted and returned, so the screen can say how many
    // pages will have no image rather than letting each one be a surprise.
    if (input.keepProofPages) {
      const proof = dataUrlToBlob(page.proofDataUrl);
      if (proof) {
        const { error: proofErr } = await supabase.storage
          .from(FLYER_BUCKET)
          .upload(pagePath(userId, input.flyer.id, page.pageNumber), proof, {
            contentType: "image/jpeg",
            upsert: true,
          });
        if (proofErr) proofsFailed += 1;
      } else {
        proofsFailed += 1;
      }
    }

    const { error: queueErr } = await supabase.from("cartmatch_flyer_pages").insert({
      id: `${input.flyer.id}:p${page.pageNumber}`,
      flyer_id: input.flyer.id,
      user_id: userId,
      page_number: page.pageNumber,
      storage_path: readPath,
    });
    if (queueErr) return { ok: false, error: queueErr.message };

    queued += 1;
    input.onProgress?.(queued, input.pages.length);
  }

  return { ok: true, queued, proofsFailed };
}

/** How a queued flyer is progressing, for the screen that queued it. */
export interface QueueProgress {
  pending: number;
  reading: number;
  done: number;
  failed: number;
  offers: number;
}

export async function queueProgress(flyerId: string): Promise<QueueProgress> {
  const empty: QueueProgress = { pending: 0, reading: 0, done: 0, failed: 0, offers: 0 };
  const supabase = client();
  if (!supabase) return empty;

  // bounded: one flyer's pages. The largest circular yet imported was 26, the
  // PDF renderer refuses anything over 120, and the cap is 1000.
  const { data } = await supabase
    .from("cartmatch_flyer_pages")
    .select("status, offers_found")
    .eq("flyer_id", flyerId);
  if (!data) return empty;

  const out = { ...empty };
  for (const row of data) {
    const status = String(row.status);
    if (status === "PENDING") out.pending += 1;
    else if (status === "READING") out.reading += 1;
    else if (status === "DONE") out.done += 1;
    else if (status === "FAILED") out.failed += 1;
    out.offers += Number(row.offers_found ?? 0);
  }
  return out;
}

/**
 * The whole queue at a glance, by flyer.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HOME SCREEN NEEDS THIS AND `pages_read` IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * `pages_read` counts pages that finished. It cannot distinguish a page still
 * waiting its turn from a page that ran out of attempts and will never be
 * tried again — both are simply "not read". So a run that stopped dead looked
 * exactly like a run in progress: same percentage, same spinner, same "the
 * rest are queued", forever.
 *
 * That is the one thing this card must never get wrong. Somebody deciding
 * whether to leave for the shops is entitled to know the difference between
 * "wait ten minutes" and "this is as loaded as it is going to get".
 */
export interface FlyerQueueCounts {
  pending: number;
  reading: number;
  done: number;
  failed: number;
  /**
   * What a still-queued page came back with RECENTLY.
   *
   * A page can be queued and going nowhere: an exhausted daily quota returns
   * it to the queue untouched, correctly, because the page is fine and the key
   * is not. Without this the card would spin all night over a run that cannot
   * move until the quota resets, which is the difference between "nearly done"
   * and "come back tomorrow".
   *
   * Recent is the load-bearing word. A queued page keeps the message from its
   * last attempt until something overwrites it, so the first version of this
   * showed a 404 about a model name that had been fixed hours before, under a
   * heading that said "Waiting:" — a true sentence about the past presented as
   * the reason for the present. Anything older than the window below is
   * history and is not shown.
   */
  waitingReason: string | null;
}

export type QueueByFlyer = Record<string, FlyerQueueCounts>;

/**
 * How recent a failure has to be to describe the present.
 *
 * The worker ticks every minute, so anything still blocking the queue will
 * have said so within the last few. Fifteen minutes is generous enough to
 * survive a slow tick and short enough that this evening's fixed problem stops
 * being reported as tonight's.
 */
const REASON_FRESH_MS = 15 * 60_000;

/**
 * The queue, with the reason when it cannot be read.
 *
 * An empty object means "no pages are waiting", which the home card renders as
 * a finished week in green. A failed query returned the same empty object, so
 * a broken connection looked exactly like a completed read — wrong in the one
 * direction that matters, since it says "you have this week's prices" to
 * somebody about to leave the house.
 */
export async function queueSummaryResult(
  now: Date = new Date(),
): Promise<{ ok: true; queue: QueueByFlyer } | { ok: false; error: string }> {
  const supabase = client();
  if (!supabase) return { ok: false, error: "Storage is not configured." };

  // One query for every page this user owns; RLS scopes it. A week of five
  // flyers is under a hundred rows, so counting them in the browser is
  // cheaper than five round trips asking the server to count.
  //
  // Sliced all the same. Pages are never deleted until their flyer is, so this
  // table grows every week — and a truncated count here would under-report how
  // much is still unread, which is the one number this function exists to give.
  const fetched = await fetchAllRows((from, to) =>
    supabase
      .from("cartmatch_flyer_pages")
      .select("flyer_id, status, last_error, errored_at, id")
      .order("id")
      .range(from, to),
  );
  if (!fetched.ok) return fetched;
  const data = fetched.rows;

  const byFlyer: Record<string, QueueRow[]> = {};
  const out: QueueByFlyer = {};
  for (const row of data) {
    const flyer = String(row.flyer_id);
    const counts =
      out[flyer] ??
      (out[flyer] = {
        pending: 0,
        reading: 0,
        done: 0,
        failed: 0,
        waitingReason: null,
      });
    const status = String(row.status);
    if (status === "PENDING") counts.pending += 1;
    else if (status === "READING") counts.reading += 1;
    else if (status === "DONE") counts.done += 1;
    else if (status === "FAILED") counts.failed += 1;

    (byFlyer[flyer] ??= []).push(row as unknown as QueueRow);
  }

  for (const [flyer, rows] of Object.entries(byFlyer)) {
    out[flyer]!.waitingReason = pickWaitingReason(rows, now);
  }

  return { ok: true, queue: out };
}

/** The queue, or an empty one, for callers with nothing to say about failure. */
export async function queueSummary(now: Date = new Date()): Promise<QueueByFlyer> {
  const result = await queueSummaryResult(now);
  return result.ok ? result.queue : {};
}

/** One page row, as far as the waiting reason is concerned. */
export interface QueueRow {
  status: unknown;
  last_error?: unknown;
  errored_at?: unknown;
}

/**
 * The reason this flyer's queue is not moving, or null.
 *
 * Pure, and separated out because the rule is the whole point: only a page
 * that is still waiting, and only a message recent enough to be about now.
 *
 * An undated message counts as history rather than as current. Rows written
 * before `errored_at` existed carry real messages about problems long since
 * dealt with, and the failure mode being fixed here is precisely a true
 * sentence about the past displayed as a fact about the present.
 */
export function pickWaitingReason(
  rows: QueueRow[],
  now: Date = new Date(),
): string | null {
  for (const row of rows) {
    if (String(row.status) !== "PENDING") continue;
    if (!row.last_error) continue;
    const at = row.errored_at ? Date.parse(String(row.errored_at)) : NaN;
    if (!Number.isFinite(at)) continue;
    if (now.getTime() - at >= REASON_FRESH_MS) continue;
    return String(row.last_error);
  }
  return null;
}

/**
 * Put failed pages back in the queue.
 *
 * A page fails for two quite different reasons, and they look identical in the
 * table: the image is unreadable — which will fail the same way however often
 * it is asked — or the model of the hour was refusing everybody, which will
 * not. Only a person knows which happened, because only a person knows that
 * the model name was just changed. So this is a button, not a sweep: the
 * worker keeps its rule that attempts run out, and a human can say "try again,
 * something outside this table changed".
 *
 * The database enforces the narrow version of that permission — see the retry
 * policy in supabase/worker.sql. A browser may move a FAILED page to PENDING
 * and nothing else; it still cannot mark a page read.
 */
export async function retryFailedPages(): Promise<
  { ok: true; requeued: number } | { ok: false; error: string }
> {
  const supabase = client();
  if (!supabase) return { ok: false, error: "Storage is not configured." };

  // bounded: the UPDATE itself is never capped — every failed page is requeued
  // whatever the count. Only the list of ids it hands back can be truncated,
  // and that is used for one number in a message. If more than 1000 pages ever
  // fail at once, the retry is complete and the sentence undercounts it.
  const { data, error } = await supabase
    .from("cartmatch_flyer_pages")
    .update({
      status: "PENDING",
      attempts: 0,
      claimed_at: null,
      offers_found: null,
      model: null,
      read_at: null,
    })
    .eq("status", "FAILED")
    .select("id");

  if (error) return { ok: false, error: error.message };
  return { ok: true, requeued: data?.length ?? 0 };
}

/**
 * The three verdicts a person can pass on a stored reading.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Every offer is a CANDIDATE: a model read a number off artwork and nothing
 * corroborated it. Every screen says so. For a long time there was no way to
 * do the checking those warnings asked for — the warning was built and the
 * action was not, and a warning nobody can act on is one people learn to read
 * past.
 *
 * CONFIRM records that somebody compared the stored price against the page.
 * REJECT records that they compared it and it was wrong.
 * CORRECT records what the page actually said, and counts as confirming: a
 * person who typed the right price has plainly looked at it.
 *
 * A correction sets the price and nothing else. Editing the wording would
 * change what the offer matches against, which is a different act from fixing
 * a misread number and would quietly move an offer onto another product.
 */
export async function confirmOffer(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return await setVerdict(id, { confirmed_at: new Date().toISOString(), rejected_at: null });
}

export async function rejectOffer(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return await setVerdict(id, { rejected_at: new Date().toISOString(), confirmed_at: null });
}

export async function correctOfferPrice(
  id: string,
  priceCents: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // The same floor and ceiling the parser applies. A correction typed by hand
  // goes through the rules a model's answer goes through, or the hand-typed
  // path becomes the way an impossible price gets in.
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    return { ok: false, error: "A price must be a whole number of cents." };
  }
  if (priceCents > 100_000) {
    return { ok: false, error: "That is not a grocery price." };
  }
  return await setVerdict(id, {
    price_cents: priceCents,
    confirmed_at: new Date().toISOString(),
    rejected_at: null,
  });
}

async function setVerdict(
  id: string,
  patch: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = client();
  if (!supabase) return { ok: false, error: "Storage is not configured." };
  const { error } = await supabase
    .from("cartmatch_flyer_offers")
    .update(patch)
    .eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export type SaveOutcome =
  | { ok: true; offersSaved: number; pagesSaved: number }
  | { ok: false; error: string };

/**
 * A flyer's id, derived rather than generated.
 *
 * Retailer plus the week it runs. Re-importing the same flyer therefore writes
 * the same rows instead of doubling every offer — and a duplicate offer is a
 * second chance to show a stale price after the first has been corrected.
 */
export function flyerId(retailerId: RetailerId, validFrom: string): string {
  return `${retailerId}-${validFrom}`;
}

/** Where one page lives. The leading user id is what the storage policy checks. */
export function pagePath(
  userId: string,
  flyer: string,
  pageNumber: number,
): string {
  return `${userId}/${flyer}/p${String(pageNumber).padStart(2, "0")}.jpg`;
}

/** Data URL to the bytes Supabase Storage wants. */
function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const binary = atob(match[2] ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] ?? "image/jpeg" });
}

/**
 * Save a flyer, its offers and its pages.
 *
 * Order matters. The flyer row goes first because the offers reference it, and
 * the pages go last because they are the largest and the most likely to be
 * interrupted — a flyer with prices and no pictures is recoverable by
 * re-uploading, while pictures belonging to no flyer are litter nothing will
 * ever clean up.
 */
export async function saveFlyer(input: SaveFlyerInput): Promise<SaveOutcome> {
  const supabase = client();
  if (!supabase) return { ok: false, error: "Supabase is not configured." };

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return { ok: false, error: "Sign in first." };

  const { error: flyerError } = await supabase
    .from("cartmatch_flyers")
    .upsert(
      {
        id: input.id,
        user_id: userId,
        retailer_id: input.retailerId,
        valid_from: input.validFrom,
        valid_to: input.validTo,
        page_count: input.pageCount,
        pages_read: input.pagesRead,
        source_filename: input.sourceFilename,
        validity_source: input.validitySource,
      },
      { onConflict: "id" },
    );
  if (flyerError) return { ok: false, error: flyerError.message };

  // Replace rather than merge. A re-read of the same flyer is a correction of
  // the whole document, and leaving the previous run's offers behind would mix
  // two readings of the same page with no way to tell which is current.
  const { error: clearError } = await supabase
    .from("cartmatch_flyer_offers")
    .delete()
    .eq("flyer_id", input.id);
  if (clearError) return { ok: false, error: clearError.message };

  const rows = input.offers.map((offer, index) => ({
    id: `${input.id}:p${offer.pageNumber}:${index}`,
    flyer_id: input.id,
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
    flyer_page: offer.pageNumber,
    // Null, always. Nothing is confirmed by being imported.
    confirmed_at: null,
  }));

  // In batches: a seventeen-page flyer yields a few hundred offers, and one
  // request carrying all of them is a request that fails entirely on a phone
  // that moves between towers.
  const BATCH = 100;
  let offersSaved = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase
      .from("cartmatch_flyer_offers")
      .insert(rows.slice(i, i + BATCH));
    if (error) return { ok: false, error: error.message };
    offersSaved += Math.min(BATCH, rows.length - i);
  }

  let pagesSaved = 0;
  for (const [pageNumber, dataUrl] of input.pageImages) {
    const blob = dataUrlToBlob(dataUrl);
    if (!blob) continue;
    const { error } = await supabase.storage
      .from(FLYER_BUCKET)
      .upload(pagePath(userId, input.id, pageNumber), blob, {
        contentType: "image/jpeg",
        upsert: true,
      });
    // A page that will not upload is not worth failing the whole import for:
    // the prices are already saved and useful, and the proof for that one page
    // is recoverable by importing again.
    if (!error) pagesSaved += 1;
  }

  return { ok: true, offersSaved, pagesSaved };
}

/**
 * How much storage the kept pages are using, and how close that is to the free
 * allowance.
 *
 * Shown rather than assumed, because "will this cost me money" is a fair
 * question with a checkable answer. Supabase's free plan includes one
 * gigabyte; a week of five sixteen-page flyers at proof size is about twenty
 * megabytes, and the pages are deleted a few days after each flyer expires —
 * so the steady state is two weeks' worth, not a year's.
 *
 * The number that matters is not this week's, it is whether the purge is
 * running. Without it, twenty megabytes a week reaches a gigabyte in a year.
 */
export const FREE_TIER_BYTES = 1_073_741_824;

export interface StorageUsage {
  bytes: number;
  files: number;
  percentOfFreeTier: number;
}

export async function measureStoredPages(): Promise<StorageUsage> {
  const empty: StorageUsage = { bytes: 0, files: 0, percentOfFreeTier: 0 };
  const supabase = client();
  if (!supabase) return empty;
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return empty;

  const flyers = await loadAllFlyers();
  let bytes = 0;
  let files = 0;

  for (const flyer of flyers) {
    const { data } = await supabase.storage
      .from(FLYER_BUCKET)
      .list(`${userId}/${flyer.id}`, { limit: 200 });
    for (const entry of data ?? []) {
      const size = (entry.metadata as { size?: number } | null)?.size;
      if (typeof size === "number") bytes += size;
      files += 1;
    }
  }

  return {
    bytes,
    files,
    percentOfFreeTier: Math.round((bytes / FREE_TIER_BYTES) * 1000) / 10,
  };
}

/**
 * The flyers currently worth comparing against.
 *
 * Filtered by date in the query, not after it. An expired flyer is not a stale
 * price — it is not a price at all — and the surest way to keep one out of a
 * comparison is for it never to arrive in the browser.
 */
export async function loadCurrentFlyers(
  on: Date = new Date(),
): Promise<StoredFlyer[]> {
  const supabase = client();
  if (!supabase) return [];
  const today = isoDay(on);

  // bounded: one row per store per week, and only weeks covering today. Six in
  // practice; a thousand would mean a thousand banners.
  const { data, error } = await supabase
    .from("cartmatch_flyers")
    .select("*")
    .lte("valid_from", today)
    .gte("valid_to", today)
    .order("retailer_id");

  if (error || !data) return [];
  return data.map(rowToFlyer);
}

/** One stored offer, with the flyer it came from. */
export interface StoredOffer {
  id: string;
  flyerId: string;
  retailerId: RetailerId;
  advertisedText: string;
  brand: string | null;
  size: string | null;
  retailerSku: string | null;
  price: number;
  basis: PriceBasis;
  regularPrice: number | null;
  regularBasis: PriceBasis | null;
  condition: OfferCondition;
  conditionText: string | null;
  flyerPage: number;
  confirmedAt: string | null;
  /**
   * Where this offer sits on its page: [ymin, xmin, ymax, xmax] on a 0-1000
   * scale, origin top-left. Null when the model did not say, which is most
   * offers read before this existed.
   */
  box: [number, number, number, number] | null;
  /**
   * A picture of just this item's ad tile, from a partner feed (Flipp).
   * Never set for a scanned flyer — those use flyerId + flyerPage + box to
   * look up a stored page picture instead. Flipp has no page concept at
   * all, but does crop and host a picture per item, which is what this is.
   */
  partnerImageUrl?: string | null;
  /**
   * When a person looked at the page and said this reading is wrong.
   *
   * Recorded rather than deleted. A wrong reading deleted is one the next
   * import recreates; recorded, it stays out of every comparison and remains
   * visible as evidence of what the extraction got wrong.
   */
  rejectedAt: string | null;
  validFrom: string;
  validTo: string;
}

/**
 * Every offer from every flyer running today.
 *
 * The date filter is a join condition rather than an afterthought: an offer
 * whose flyer has closed is not a stale price, it is not a price, and the
 * surest way to keep one out of a comparison is for it never to be fetched.
 */
export async function loadCurrentOffers(
  on: Date = new Date(),
): Promise<StoredOffer[]> {
  const result = await loadCurrentOffersResult(on);
  return result.ok ? result.offers : [];
}

/**
 * The same fetch, with the reason when it fails.
 *
 * A screen that says "0 offers" because the query broke is telling the shopper
 * something false about their flyers. Anything that draws a conclusion from
 * emptiness — the comparison screen above all — uses this form and says
 * "could not read" instead.
 */
export async function loadCurrentOffersResult(
  on: Date = new Date(),
): Promise<{ ok: true; offers: StoredOffer[] } | { ok: false; error: string }> {
  const supabase = client();
  if (!supabase) return { ok: false, error: "Storage is not configured." };
  const today = isoDay(on);

  const fetched = await fetchAllRows((from, to) =>
    supabase
      .from("cartmatch_flyer_offers")
      .select("*, cartmatch_flyers!inner(retailer_id, valid_from, valid_to)")
      .lte("cartmatch_flyers.valid_from", today)
      .gte("cartmatch_flyers.valid_to", today)
      // A reading somebody has looked at and called wrong is not a price. Kept
      // in the table as a record of what the extraction got wrong; never
      // fetched into a comparison.
      .is("rejected_at", null)
      // Unique and stable, so slicing cannot repeat or skip a row.
      .order("id")
      .range(from, to),
  );

  if (!fetched.ok) return fetched;

  const offers = fetched.rows.map((row: Record<string, unknown>) => {
    const flyer = row.cartmatch_flyers as Record<string, unknown>;
    return {
      id: String(row.id),
      flyerId: String(row.flyer_id),
      retailerId: String(flyer.retailer_id) as RetailerId,
      advertisedText: String(row.advertised_text),
      brand: row.brand ? String(row.brand) : null,
      size: row.size ? String(row.size) : null,
      retailerSku: row.retailer_sku ? String(row.retailer_sku) : null,
      price: Number(row.price_cents),
      basis: String(row.basis) as PriceBasis,
      regularPrice:
        row.regular_price_cents === null ? null : Number(row.regular_price_cents),
      regularBasis: row.regular_basis
        ? (String(row.regular_basis) as PriceBasis)
        : null,
      condition: String(row.condition) as OfferCondition,
      conditionText: row.condition_text ? String(row.condition_text) : null,
      flyerPage: Number(row.flyer_page),
      confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null,
      box: readStoredBox(row.box_2d),
      rejectedAt: row.rejected_at ? String(row.rejected_at) : null,
      validFrom: String(flyer.valid_from),
      validTo: String(flyer.valid_to),
    };
  });

  return { ok: true, offers };
}

/**
 * The Flipp date window covering the given day, if any — the widest span
 * seen across every retailer's offers, not any one retailer's. Used only to
 * show a date range on screen; loadFlippRetailersThisWeek() and
 * loadCurrentFlippOffers() remain the sources of truth for actual matching.
 */
export async function loadFlippWindowThisWeek(
  on: Date = new Date(),
): Promise<{ validFrom: string; validTo: string } | null> {
  const supabase = client();
  if (!supabase) return null;
  const today = isoDay(on);

  const fetched = await fetchAllRows((from, to) =>
    supabase
      .from("cartmatch_flipp_offers")
      .select("valid_from, valid_to")
      .lte("valid_from", today)
      .gte("valid_to", today)
      .range(from, to),
  );
  if (!fetched.ok || fetched.rows.length === 0) return null;

  let validFrom = String(fetched.rows[0]!.valid_from);
  let validTo = String(fetched.rows[0]!.valid_to);
  for (const row of fetched.rows) {
    const from = String(row.valid_from);
    const to = String(row.valid_to);
    if (from < validFrom) validFrom = from;
    if (to > validTo) validTo = to;
  }
  return { validFrom, validTo };
}

/**
 * Manually re-fetch and write ONE retailer's current Flipp data right now,
 * outside the weekly schedule — for the admin panel's "Retry" button next to
 * a retailer showing no data.
 *
 * Deliberately calls the cartmatch-flipp Edge Function's new "retry" action
 * rather than writing to cartmatch_flipp_offers from here directly — that
 * table has no client-write RLS policy, on purpose, and this keeps it that
 * way. The Edge Function checks has_app_access itself before writing with
 * its own service-role key; nothing about calling it from an admin-only
 * screen changes what it will accept from a signed-in non-admin user, so
 * the real security boundary is server-side, not just "buried in a menu".
 */
export async function retryFlippRetailer(
  retailerId: RetailerId,
): Promise<{ ok: true; written: number; banners: number; note?: string } | { ok: false; error: string }> {
  if (!supabaseConfigured()) return { ok: false, error: "Supabase is not configured." };
  const token = await getAccessToken();
  if (!token) return { ok: false, error: "Sign in first." };

  try {
    const res = await fetch(edgeFunctionUrl("cartmatch-flipp"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        apikey: env.supabaseAnonKey,
      },
      body: JSON.stringify({ action: "retry", retailerId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error ?? `Retry failed (HTTP ${res.status}).` };
    }
    return { ok: true, written: data.written ?? 0, banners: data.banners ?? 0, note: data.note };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Retry request failed.",
    };
  }
}

/**
 * Which retailers Flipp covered for the given day — presence only, no offer
 * detail. Answers "do I still need to scan a flyer, or does Flipp already
 * have this store this week" without loading every offer row.
 */
export async function loadFlippRetailersThisWeek(
  on: Date = new Date(),
): Promise<RetailerId[]> {
  const supabase = client();
  if (!supabase) return [];
  const today = isoDay(on);

  const fetched = await fetchAllRows((from, to) =>
    supabase
      .from("cartmatch_flipp_offers")
      .select("retailer_id")
      .lte("valid_from", today)
      .gte("valid_to", today)
      .range(from, to),
  );
  if (!fetched.ok) return [];

  return [
    ...new Set(fetched.rows.map((row) => String(row.retailer_id) as RetailerId)),
  ];
}

/**
 * This week's Flipp offers — a partner feed, not a photographed flyer.
 *
 * Deliberately a separate function rather than a flag on loadCurrentOffers():
 * every offer here always carries condition SOURCE_UNCERTAIN and can never be
 * confused with something read off a page. See that condition's definition
 * in types/flyer.ts for why it never takes part in arithmetic.
 *
 * thisWeekOnly (default true) additionally requires each offer's OWN window
 * to look like a normal week — see looksLikeCurrentWeek() in status.ts for
 * why this matters: a single Flipp flyer can bundle offers with a normal
 * 6-7 day window alongside others running 20-48 days for a seasonal
 * promotion, all under "today falls within valid_from/valid_to" being true
 * for both. Defaulting to true here is what keeps the cart scanner's real
 * matching results scoped to "this week" without every call site needing to
 * remember to ask for it. Pass false explicitly for a use that wants
 * everything currently valid regardless of window length — the search
 * page's "include everything" option is the one caller that does.
 */
export async function loadCurrentFlippOffers(
  on: Date = new Date(),
  { thisWeekOnly = true }: { thisWeekOnly?: boolean } = {},
): Promise<StoredOffer[]> {
  const supabase = client();
  if (!supabase) return [];
  const today = isoDay(on);

  const fetched = await fetchAllRows((from, to) =>
    supabase
      .from("cartmatch_flipp_offers")
      .select("*")
      .lte("valid_from", today)
      .gte("valid_to", today)
      .order("id")
      .range(from, to),
  );
  if (!fetched.ok) return [];

  const rows = thisWeekOnly
    ? fetched.rows.filter((row: Record<string, unknown>) =>
        looksLikeCurrentWeek({
          validFrom: String(row.valid_from),
          validTo: String(row.valid_to),
        }),
      )
    : fetched.rows;

  return rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    flyerId: String(row.flyer_id),
    retailerId: String(row.retailer_id) as RetailerId,
    advertisedText: String(row.advertised_text),
    brand: row.brand ? String(row.brand) : null,
    size: row.size ? String(row.size) : null,
    retailerSku: null,
    price: Number(row.price_cents),
    basis: String(row.basis) as PriceBasis,
    regularPrice: null,
    regularBasis: null,
    condition: "SOURCE_UNCERTAIN" as OfferCondition,
    conditionText: "From this week's Flipp flyer, not a photographed one",
    flyerPage: 0,
    confirmedAt: null,
    box: null,
    partnerImageUrl: row.image_url ? String(row.image_url) : null,
    rejectedAt: null,
    validFrom: String(row.valid_from),
    validTo: String(row.valid_to),
  }));
}

/**
 * A stored box, or null.
 *
 * The same checking the parser applies, repeated here rather than assumed,
 * because a row can be older than the column or written by something else.
 * Anything short of four whole numbers in range with the corners the right way
 * round is discarded whole: a rectangle in the wrong place is worse than none.
 */
function readStoredBox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map((v) => Number(v));
  if (!nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 1000)) return null;
  const [ymin, xmin, ymax, xmax] = nums as [number, number, number, number];
  if (ymax <= ymin || xmax <= xmin) return null;
  return [ymin, xmin, ymax, xmax];
}

/**
 * How much a flyer would take with it.
 *
 * Asked before deleting rather than after, because "delete Metro" and "delete
 * 7 pages and 84 offers" are different decisions and only the second one can
 * be made knowingly.
 */
export async function flyerContents(
  flyerId: string,
): Promise<{ pages: number; offers: number }> {
  const supabase = client();
  if (!supabase) return { pages: 0, offers: 0 };

  const [pages, offers] = await Promise.all([
    supabase
      .from("cartmatch_flyer_pages")
      .select("id", { count: "exact", head: true })
      .eq("flyer_id", flyerId),
    supabase
      .from("cartmatch_flyer_offers")
      .select("id", { count: "exact", head: true })
      .eq("flyer_id", flyerId),
  ]);

  return { pages: pages.count ?? 0, offers: offers.count ?? 0 };
}

/**
 * Remove a flyer entirely: its offers, its queued pages and its pictures.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Not every PDF a store publishes is a price list. A recipe booklet, a pharmacy
 * insert, last week's file picked by mistake — each imports happily and then
 * contributes to comparisons, because nothing downstream can tell that the
 * prices came from the wrong document. Re-importing does not help: a different
 * file gets a different flyer id and the wrong one stays.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY DELETED
 * ---------------------------------------------------------------------------
 * Everything, and the pictures first. Offers and queued pages cascade from the
 * flyer row, but object storage does not: deleting the row alone would leave
 * the pictures behind with nothing left that knows their names — the same
 * orphan the purge was written to collect, created deliberately.
 *
 * So the images go first and the row goes last. A failure part-way leaves a
 * flyer whose pictures are gone, which the screens already handle by naming
 * the source PDF instead. The reverse order would leave files nothing can
 * reach.
 */
export async function deleteFlyer(
  flyerId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = client();
  if (!supabase) return { ok: false, error: "Storage is not configured." };
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return { ok: false, error: "Sign in first." };

  // Whatever is actually in there, rather than a page count that may be wrong.
  const { data: files } = await supabase.storage
    .from(FLYER_BUCKET)
    .list(`${userId}/${flyerId}`, { limit: 500 });

  if (files && files.length > 0) {
    await supabase.storage
      .from(FLYER_BUCKET)
      .remove(files.map((f) => `${userId}/${flyerId}/${f.name}`));
  }

  // Explicit rather than relying on the cascade alone: RLS applies to these
  // deletes, and a row this user cannot delete should fail here where it can
  // be reported, not silently survive a cascade.
  await supabase.from("cartmatch_flyer_offers").delete().eq("flyer_id", flyerId);
  await supabase.from("cartmatch_flyer_pages").delete().eq("flyer_id", flyerId);

  const { error } = await supabase
    .from("cartmatch_flyers")
    .delete()
    .eq("id", flyerId);

  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Every flyer held, with the reason when it cannot be read.
 *
 * Same distinction the offers loader makes, for the same reason: "you hold no
 * flyers" and "I could not find out what you hold" lead to opposite actions.
 * The first says import; the second says do not, because importing six PDFs
 * that are already stored spends a day's model allowance to arrive back where
 * you started.
 */
export async function loadAllFlyersResult(): Promise<
  { ok: true; flyers: StoredFlyer[] } | { ok: false; error: string }
> {
  const supabase = client();
  if (!supabase) return { ok: false, error: "Storage is not configured." };
  const fetched = await fetchAllRows((from, to) =>
    supabase.from("cartmatch_flyers").select("*").order("id").range(from, to),
  );
  if (!fetched.ok) return fetched;
  return {
    ok: true,
    flyers: fetched.rows
      .map(rowToFlyer)
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom)),
  };
}

/** Every flyer held, current or not — for the management screen. */
export async function loadAllFlyers(): Promise<StoredFlyer[]> {
  const supabase = client();
  if (!supabase) return [];
  // Sliced, and ordered by id rather than by date, because `valid_from` is not
  // unique — six flyers share a week — and paging over a non-unique order can
  // repeat one row and drop another. Sorted for display after it is all here.
  const fetched = await fetchAllRows((from, to) =>
    supabase.from("cartmatch_flyers").select("*").order("id").range(from, to),
  );
  if (!fetched.ok) return [];
  return fetched.rows
    .map(rowToFlyer)
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom));
}

function rowToFlyer(row: Record<string, unknown>): StoredFlyer {
  return {
    id: String(row.id),
    retailerId: String(row.retailer_id) as RetailerId,
    validFrom: String(row.valid_from),
    validTo: String(row.valid_to),
    pageCount: Number(row.page_count),
    pagesRead: Number(row.pages_read),
    sourceFilename: row.source_filename ? String(row.source_filename) : null,
    validitySource: String(row.validity_source) as StoredFlyer["validitySource"],
  };
}

/**
 * A temporary link to one flyer page.
 *
 * Signed and short-lived because the bucket is private: these are pages of a
 * copyrighted flyer held for one shopper's own use, and a public URL would
 * publish them to anyone who guessed the path. An hour is longer than any
 * checkout and shorter than a shared link stays useful.
 */
export async function flyerPageUrl(
  flyer: string,
  pageNumber: number,
): Promise<string | null> {
  const supabase = client();
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase.storage
    .from(FLYER_BUCKET)
    .createSignedUrl(pagePath(userId, flyer, pageNumber), 3600);
  return error ? null : (data?.signedUrl ?? null);
}

/**
 * Should this flyer's page images still be held?
 *
 * The prices stay for six months as history; the pictures do not. A page image
 * is evidence for a claim that has expired, and last April's artwork serves
 * nobody while costing real storage.
 */
export function pagesStillNeeded(flyer: StoredFlyer, on: Date = new Date()): boolean {
  const cutoff = new Date(`${flyer.validTo}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + PAGE_GRACE_DAYS);
  return on <= cutoff;
}

/**
 * Delete the page images of flyers whose window closed days ago.
 *
 * Postgres cannot reach object storage, so this is the app's half of the
 * retention rule in supabase/flyers.sql. The offers are left alone: they are
 * history, and history is the point of keeping them.
 */
/** Where the model-sized copy of a page lives. Mirrors queueFlyerForReading. */
function extractionPath(userId: string, flyerId: string, pageNumber: number): string {
  return `${userId}/${flyerId}/read-p${String(pageNumber).padStart(2, "0")}.jpg`;
}

export async function purgeExpiredPages(on: Date = new Date()): Promise<number> {
  const supabase = client();
  if (!supabase) return 0;
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return 0;

  const flyers = await loadAllFlyers();
  let removed = 0;

  for (const flyer of flyers) {
    if (pagesStillNeeded(flyer, on)) continue;
    // Both sizes, not just the proof page.
    //
    // The worker deletes an extraction image the moment its page is read, so
    // in the ordinary case there is nothing here to collect. A page that ended
    // FAILED is the exception: its extraction image was never deleted, nothing
    // else ever looks at it, and it is four times the size of a proof page. One
    // orphan a week is invisible; a year of them is not, and the leak has no
    // upper bound because nothing else in the system knows the file exists.
    //
    // remove() ignores paths that are not there, so listing both is cheaper
    // than asking which of them survived.
    const paths = Array.from({ length: flyer.pageCount }, (_, i) => [
      pagePath(userId, flyer.id, i + 1),
      extractionPath(userId, flyer.id, i + 1),
    ]).flat();
    const { error } = await supabase.storage.from(FLYER_BUCKET).remove(paths);
    if (!error) removed += paths.length;
  }
  return removed;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
