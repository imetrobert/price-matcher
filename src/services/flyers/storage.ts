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
 * until the 19th, here is the page", which is the only form that works at a
 * till.
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
import { supabaseConfigured } from "@/config/env";
import type { RetailerId } from "@/types";
import type { ExtractedOffer } from "./pdf/types";

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

  const { data, error } = await supabase
    .from("cartmatch_flyers")
    .select("*")
    .lte("valid_from", today)
    .gte("valid_to", today)
    .order("retailer_id");

  if (error || !data) return [];
  return data.map(rowToFlyer);
}

/** Every flyer held, current or not — for the management screen. */
export async function loadAllFlyers(): Promise<StoredFlyer[]> {
  const supabase = client();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("cartmatch_flyers")
    .select("*")
    .order("valid_from", { ascending: false });
  if (error || !data) return [];
  return data.map(rowToFlyer);
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
    const paths = Array.from({ length: flyer.pageCount }, (_, i) =>
      pagePath(userId, flyer.id, i + 1),
    );
    const { error } = await supabase.storage.from(FLYER_BUCKET).remove(paths);
    if (!error) removed += paths.length;
  }
  return removed;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
