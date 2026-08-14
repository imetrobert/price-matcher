"use client";

/**
 * Importing a week's flyers in one go.
 *
 * ---------------------------------------------------------------------------
 * WHY A QUEUE RATHER THAN FIVE VISITS TO THE SAME SCREEN
 * ---------------------------------------------------------------------------
 * The weekly job is: download five PDFs on Thursday, load them, walk away. The
 * work takes half an hour, almost all of it spent waiting out an API quota —
 * which is exactly the sort of thing a machine should do unattended, and
 * exactly the sort of thing a person should not be asked to babysit five
 * times.
 *
 * So the one action is the upload. Everything after it is queued, paced and
 * reported.
 *
 * ---------------------------------------------------------------------------
 * WHICH FLYER IS WHICH
 * ---------------------------------------------------------------------------
 * Two sources, because neither is reliable alone:
 *
 *   THE FILENAME. Metro Inc names theirs properly — "SuperC Weekly Flyer 2
 *   Valid 13-08-26 - 19-08-26.pdf" — but the vendor hosting Maxi's and IGA's
 *   names both of them "PDF_wk33-2026-SA V6.pdf". The region code is shared, so
 *   the filename cannot tell those two apart at all.
 *
 *   THE LOGO ON PAGE ONE. Read while the page is being read for prices, so it
 *   costs nothing extra. This is a reading of what is printed, not a guess
 *   from the products.
 *
 * When they agree, nothing is asked. When they disagree or neither is
 * conclusive, the file is flagged and a person picks — because a Maxi flyer
 * filed under IGA produces price matches attributed to the wrong shop, which
 * is a wrong claim made to a cashier rather than a tidiness problem.
 */

import { RETAILERS } from "@/config/retailers";
import type { RetailerId } from "@/types";

import {
  countPdfPages,
  renderFlyerPdf,
  type RenderedFlyerPage,
} from "./pdf/renderPages";
import { readFlyerPages, type ReadFlyerResult } from "./pdf/readPage";

export type BatchStage =
  | "WAITING"
  | "RENDERING"
  | "READING"
  | "DONE"
  | "FAILED";

export interface BatchItem {
  id: string;
  file: File;
  /** Pages in the PDF, counted before any work starts. Drives the progress bar. */
  pageCount: number | null;
  /** Pages of this flyer already read. */
  pagesRead: number;
  /** The flyer's run dates, from its filename or its cover. */
  validFrom: string | null;
  validTo: string | null;
  /** Where those dates came from, since one source is a model and one is not. */
  validityFrom: "FILENAME" | "COVER" | "UNKNOWN";
  /** Best current guess, and what the run will use unless overridden. */
  retailerId: RetailerId | null;
  /** How that guess was arrived at, shown so it can be judged. */
  retailerFrom: "FILENAME" | "LOGO" | "CHOSEN" | "UNKNOWN";
  stage: BatchStage;
  /** Free text for the row: "Reading page 4 of 17". */
  detail: string;
  pages: RenderedFlyerPage[] | null;
  result: ReadFlyerResult | null;
  error: string | null;
}

/**
 * Guess the retailer from a filename.
 *
 * Only returns something when the filename actually says so. The Loblaw and
 * Sobeys files share the token "SA", so neither is inferred from it — a guess
 * that is right half the time is worse than no guess, because it looks like
 * knowledge.
 */
export function retailerFromFilename(name: string): RetailerId | null {
  // Separators first. A word boundary does not fire between "iga" and "_",
  // because an underscore is a word character — so "IGA_flyer.pdf" would go
  // unrecognised while "IGA flyer.pdf" matched. Downloaded filenames are full
  // of underscores, so this is the common case rather than the odd one.
  const n = ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;

  // Super C before Metro: it belongs to Metro Inc and its files sometimes
  // carry both names, and the more specific banner is the right answer.
  if (/ super\s?c /.test(n)) return "superc";
  if (/ metro /.test(n)) return "metro";
  if (/ walmart | wm /.test(n)) return "walmart";
  if (/ maxi /.test(n)) return "maxi";
  if (/ iga /.test(n)) return "iga";
  if (/ provigo /.test(n)) return "provigo";
  return null;
}

/**
 * Map the store name a model read off page one to a retailer this app knows.
 *
 * Matched against the configured display names rather than a second hardcoded
 * list, so adding a retailer to the registry teaches this too.
 */
export function retailerFromLogo(read: string | null): RetailerId | null {
  if (!read) return null;
  const needle = read.toLowerCase().replace(/[^a-z]/g, "");
  if (needle === "") return null;
  for (const retailer of Object.values(RETAILERS)) {
    const name = retailer.displayName.toLowerCase().replace(/[^a-z]/g, "");
    if (name === needle) return retailer.id;
  }
  // "Super C" reads as "superc"; "Maxi & Cie" as "maxicie". Fall back to a
  // containment test, which is safe here because the names share no prefixes.
  for (const retailer of Object.values(RETAILERS)) {
    const name = retailer.displayName.toLowerCase().replace(/[^a-z]/g, "");
    if (needle.includes(name) || name.includes(needle)) return retailer.id;
  }
  return null;
}

/**
 * The run dates some retailers put in the filename.
 *
 * Metro Inc writes "SuperC Weekly Flyer 2 Valid 13-08-26 - 19-08-26.pdf" —
 * day-month-year, two-digit year. Preferred over the cover reading when it is
 * there, because it came from the retailer's own file naming rather than from
 * a model looking at artwork.
 *
 * Two-digit years are read as 2000+. These are weekly flyers; a 1926 grocery
 * circular is not a case worth handling.
 */
export function validityFromFilename(
  name: string,
): { from: string; to: string } | null {
  const m = /(\d{2})-(\d{2})-(\d{2})\s*-\s*(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return null;
  const iso = (d: string, mo: string, y: string) => `20${y}-${mo}-${d}`;
  const from = iso(m[1]!, m[2]!, m[3]!);
  const to = iso(m[4]!, m[5]!, m[6]!);
  if (Number(m[2]) > 12 || Number(m[5]) > 12) return null;
  return from <= to ? { from, to } : null;
}

export function newBatchItem(file: File, index: number): BatchItem {
  const guess = retailerFromFilename(file.name);
  const dates = validityFromFilename(file.name);
  return {
    id: `${index}-${file.name}-${file.size}`,
    file,
    pageCount: null,
    pagesRead: 0,
    validFrom: dates?.from ?? null,
    validTo: dates?.to ?? null,
    validityFrom: dates ? "FILENAME" : "UNKNOWN",
    retailerId: guess,
    retailerFrom: guess ? "FILENAME" : "UNKNOWN",
    stage: "WAITING",
    detail: guess
      ? `Looks like ${RETAILERS[guess].displayName}`
      : "Store will be read from page 1",
    pages: null,
    result: null,
    error: null,
  };
}

export interface BatchOptions {
  onUpdate: (item: BatchItem) => void;
  signal?: AbortSignal;
}

/**
 * Render and read one flyer, reporting as it goes.
 *
 * Rendering happens per item rather than up front: sixteen page images per
 * flyer times five flyers is a lot of memory to hold at once on a phone, and
 * the pages of a finished flyer are not needed once its offers are out.
 */
async function runOne(item: BatchItem, options: BatchOptions): Promise<BatchItem> {
  let current = { ...item, stage: "RENDERING" as BatchStage, detail: "Opening the PDF…" };
  options.onUpdate(current);

  try {
    const data = await current.file.arrayBuffer();
    const pages = await renderFlyerPdf(data, {
      signal: options.signal,
      onProgress: ({ page, pageCount }) => {
        current = { ...current, detail: `Rendering page ${page} of ${pageCount}` };
        options.onUpdate(current);
      },
    });

    current = { ...current, pages, stage: "READING", detail: "Reading prices…" };
    options.onUpdate(current);

    const result = await readFlyerPages(pages, {
      signal: options.signal,
      onProgress: ({ page, pageCount, offersSoFar }) => {
        current = {
          ...current,
          // page-1 means pages FINISHED, which is what a progress bar counts.
          pagesRead: Math.max(0, page - 1),
          detail: `Reading page ${page} of ${pageCount} — ${offersSoFar} offers`,
        };
        options.onUpdate(current);
      },
    });

    // The logo only overrides when the filename said nothing. A filename that
    // names a store is the person's own labelling of the file; a logo reading
    // is a model's. Where both speak, the disagreement is surfaced rather than
    // resolved silently.
    let retailerId = current.retailerId;
    let retailerFrom = current.retailerFrom;
    const fromLogo = retailerFromLogo(result.retailerName);
    if (!retailerId && fromLogo) {
      retailerId = fromLogo;
      retailerFrom = "LOGO";
    }

    const disagrees =
      retailerFrom === "FILENAME" && fromLogo !== null && fromLogo !== retailerId;

    // The filename wins where it speaks: it is the retailer's own labelling of
    // the file, and the cover reading is a model looking at artwork. The cover
    // fills the gap for the retailers whose files carry no dates at all.
    const validFrom = current.validFrom ?? result.validFrom;
    const validTo = current.validTo ?? result.validTo;

    current = {
      ...current,
      retailerId,
      retailerFrom,
      result,
      validFrom,
      validTo,
      validityFrom:
        current.validityFrom === "FILENAME"
          ? "FILENAME"
          : validFrom
            ? "COVER"
            : "UNKNOWN",
      pagesRead: pages.length - result.notAttempted.length,
      stage: "DONE",
      detail: disagrees
        ? `Filename says ${RETAILERS[retailerId!].displayName}, page 1 shows ${RETAILERS[fromLogo!].displayName} — check this one`
        : summarise(result, pages.length),
      // Page images are released here. The offers carry the page numbers, and
      // holding five flyers' worth of full-size images is how the tab dies.
      pages: null,
    };
    options.onUpdate(current);
    return current;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    current = {
      ...current,
      stage: "FAILED",
      pages: null,
      error: message,
      detail: message,
    };
    options.onUpdate(current);
    return current;
  }
}

function summarise(result: ReadFlyerResult, pageCount: number): string {
  const read = pageCount - result.failedPages.length - result.notAttempted.length;
  if (result.notAttempted.length > 0) {
    return `${result.offers.length} offers from ${read} of ${pageCount} pages — incomplete`;
  }
  return `${result.offers.length} offers from ${read} of ${pageCount} pages`;
}

/**
 * Work through the whole batch, one flyer at a time.
 *
 * Sequential, and not for simplicity: the limit being paced against is a
 * per-minute quota on one API key, so running two flyers at once would halve
 * the pages each of them gets through before being cut off. One at a time is
 * both slower and faster.
 *
 * One flyer failing does not stop the others. A corrupt PDF or an exhausted
 * quota partway down the list should still leave the flyers that did work.
 */
/**
 * Count every PDF's pages before doing any work.
 *
 * Cheap — pdf.js reads the page tree without rasterising anything — and it is
 * what makes the progress bar mean something. A bar that counts files moves
 * once every eight minutes; one that counts pages moves every few seconds, and
 * a person can tell from it whether to wait or go and do something else.
 */
export async function countBatchPages(
  items: BatchItem[],
  onUpdate: (item: BatchItem) => void,
): Promise<BatchItem[]> {
  const counted: BatchItem[] = [];
  for (const item of items) {
    try {
      const pageCount = await countPdfPages(await item.file.arrayBuffer());
      const next = { ...item, pageCount, detail: `${pageCount} pages — waiting` };
      onUpdate(next);
      counted.push(next);
    } catch {
      // A file that will not open is left uncounted rather than failed here;
      // the run itself reports it properly, with the reason.
      counted.push(item);
    }
  }
  return counted;
}

export async function runBatch(
  items: BatchItem[],
  options: BatchOptions,
): Promise<BatchItem[]> {
  const done: BatchItem[] = [];
  for (const item of items) {
    if (options.signal?.aborted) {
      done.push({ ...item, stage: "FAILED", detail: "Cancelled", error: "Cancelled" });
      continue;
    }
    done.push(await runOne(item, options));
  }
  return done;
}

/** Everything the batch produced, for the summary line. */
export function batchTotals(items: BatchItem[]): {
  offers: number;
  flyersDone: number;
  flyersIncomplete: number;
  flyersFailed: number;
  needsRetailer: number;
  needsDates: number;
  pagesTotal: number;
  pagesRead: number;
  percent: number;
} {
  let offers = 0;
  let flyersDone = 0;
  let flyersIncomplete = 0;
  let flyersFailed = 0;
  let needsRetailer = 0;
  let needsDates = 0;
  let pagesTotal = 0;
  let pagesRead = 0;

  for (const item of items) {
    pagesTotal += item.pageCount ?? 0;
    pagesRead += item.pagesRead;
    if (item.stage === "DONE" && !item.validTo) needsDates += 1;
    if (item.stage === "FAILED") flyersFailed += 1;
    if (item.stage === "DONE") {
      offers += item.result?.offers.length ?? 0;
      if ((item.result?.notAttempted.length ?? 0) > 0) flyersIncomplete += 1;
      else flyersDone += 1;
    }
    if (item.retailerId === null) needsRetailer += 1;
  }

  return {
    offers,
    flyersDone,
    flyersIncomplete,
    flyersFailed,
    needsRetailer,
    needsDates,
    pagesTotal,
    pagesRead,
    // Zero rather than NaN before counting finishes. A progress bar that
    // reports nonsense for the first second teaches people to ignore it.
    percent:
      pagesTotal === 0 ? 0 : Math.min(100, Math.round((pagesRead / pagesTotal) * 100)),
  };
}
