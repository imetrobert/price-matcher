/**
 * What the home screen says about this week's flyers.
 *
 * ---------------------------------------------------------------------------
 * THE ONE QUESTION SOMEBODY ASKS BEFORE LEAVING THE HOUSE
 * ---------------------------------------------------------------------------
 * "Do I have this week's prices?" Everything else in this app is downstream of
 * that, and until now it could only be answered by opening the import screen
 * and inferring it from a list of filenames.
 *
 * Three states, and the boundaries between them matter more than the wording:
 *
 *   NOTHING FOR TODAY   nothing stored covers today's date. Flyers turn over
 *                       on Thursday, so this is what Thursday morning looks
 *                       like, and it is also what a week nobody imported looks
 *                       like. Both mean the same thing to a shopper: go and
 *                       load them.
 *
 *   PARTLY LOADED       some flyers cover today, and pages are missing from
 *                       them. Deliberately its own state rather than being
 *                       rounded up to "loaded": a flyer read to page two of
 *                       seventeen has offers, looks complete in a list, and is
 *                       not this week's prices.
 *
 *   LOADED              every stored flyer covering today was read end to end.
 *
 * ---------------------------------------------------------------------------
 * PARTLY LOADED SAYS ONE OF TWO THINGS
 * ---------------------------------------------------------------------------
 * "Pages are missing" and "pages are still arriving" are not the same news,
 * and for a long evening this screen could not tell them apart. It counted
 * pages that finished, so a queue that had stopped dead — every remaining page
 * out of attempts — held a spinner at 31% and said "the rest are queued" when
 * nothing was queued at all.
 *
 * When the queue counts are passed in, PARTIAL therefore splits: `stalled` is
 * true when no page covering today is pending or being read, and the wording
 * and the spinner follow it. Without the counts the old wording stands, since
 * a screen that cannot see the queue must not claim the work has stopped
 * either.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 * That the set is complete. The app cannot know a shopper meant to load five
 * flyers and loaded three, because nobody told it which stores they care
 * about. So it names the stores it holds rather than counting down to a total
 * it invented — "loaded for Maxi and IGA" is true; "3 of 5" would not be.
 */

import { RETAILERS } from "@/config/retailers";
import type { RetailerId } from "@/types";
import type { QueueByFlyer, StoredFlyer } from "./storage";

export type FlyerReadiness = "NONE" | "PARTIAL" | "LOADED";

export interface FlyerStatus {
  readiness: FlyerReadiness;
  /** Stores whose flyers cover today, in display order. */
  retailers: RetailerId[];
  /** The window those flyers run for, when there is one. */
  validFrom: string | null;
  validTo: string | null;
  pagesRead: number;
  pagesTotal: number;
  percent: number;
  /**
   * PARTIAL, and nothing is moving: no page is pending or being read. False
   * whenever the queue counts were not supplied — not knowing is not evidence
   * that the work has stopped.
   */
  stalled: boolean;
  /** Pages that gave up, when the queue counts were supplied. */
  pagesFailed: number;
  /** One line, written to be shown as-is. */
  headline: string;
  detail: string;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A date as a shopper reads it. Noon UTC so it never slips back a day. */
function day(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function names(retailers: RetailerId[]): string {
  const list = retailers.map((r) => RETAILERS[r]?.displayName ?? r);
  if (list.length === 0) return "no stores";
  if (list.length === 1) return list[0]!;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export function flyerStatus(
  flyers: StoredFlyer[],
  on: Date = new Date(),
  queue?: QueueByFlyer,
): FlyerStatus {
  const today = isoDay(on);
  const current = flyers.filter(
    (f) => f.validFrom <= today && today <= f.validTo,
  );

  if (current.length === 0) {
    // Distinguishes "never loaded" from "loaded, but that week has passed",
    // because the second is the Thursday-morning case and a shopper who
    // loaded flyers last week deserves to be told they have expired rather
    // than that nothing exists.
    const previous = flyers
      .filter((f) => f.validTo < today)
      .sort((a, b) => b.validTo.localeCompare(a.validTo))[0];

    return {
      readiness: "NONE",
      retailers: [],
      validFrom: null,
      validTo: null,
      pagesRead: 0,
      pagesTotal: 0,
      percent: 0,
      stalled: false,
      pagesFailed: 0,
      headline: "Upload the latest flyers",
      detail: previous
        ? `The newest flyers held ran to ${day(previous.validTo)} and have expired. Nothing covers today.`
        : "No flyers have been loaded yet.",
    };
  }

  const retailers = [...new Set(current.map((f) => f.retailerId))].sort();
  const pagesRead = current.reduce((sum, f) => sum + f.pagesRead, 0);
  const pagesTotal = current.reduce((sum, f) => sum + f.pageCount, 0);
  const percent =
    pagesTotal === 0 ? 0 : Math.min(100, Math.round((pagesRead / pagesTotal) * 100));

  // The window shown is the widest one covering today. Retailers do not always
  // run the same days, and showing one flyer's dates as if they were all of
  // them would misstate when the others expire.
  const validFrom = current.map((f) => f.validFrom).sort()[0]!;
  const validTo = current.map((f) => f.validTo).sort().reverse()[0]!;
  const window = `${day(validFrom)} to ${day(validTo)}`;

  // Only the pages of flyers covering today. A failed page from last week's
  // flyer is somebody else's problem and must not stall this week's card.
  const counts = queue
    ? current.reduce(
        (sum, f) => {
          const c = queue[f.id];
          if (!c) return sum;
          return {
            waiting: sum.waiting + c.pending + c.reading,
            failed: sum.failed + c.failed,
          };
        },
        { waiting: 0, failed: 0 },
      )
    : null;

  if (pagesRead < pagesTotal) {
    // Stalled means nothing is coming, not merely that something failed: a
    // page can fail while others are still queued, and that run is still
    // running.
    const stalled = counts !== null && counts.waiting === 0;

    return {
      readiness: "PARTIAL",
      retailers,
      validFrom,
      validTo,
      pagesRead,
      pagesTotal,
      percent,
      stalled,
      pagesFailed: counts?.failed ?? 0,
      headline: stalled
        ? `Reading stopped — ${percent}% of ${window}`
        : `Reading ${window} — ${percent}%`,
      detail: stalled
        ? `${names(retailers)}: ${pagesRead} of ${pagesTotal} pages read, and nothing is queued. ` +
          (counts!.failed > 0
            ? `${counts!.failed} ${counts!.failed === 1 ? "page" : "pages"} gave up — the offers on them are missing, not absent.`
            : "The remaining pages were never queued for reading.")
        : `${names(retailers)}: ${pagesRead} of ${pagesTotal} pages read so far. The rest are queued — a page still unread is missing its offers, not free of them.`,
    };
  }

  return {
    readiness: "LOADED",
    retailers,
    validFrom,
    validTo,
    pagesRead,
    pagesTotal,
    percent: 100,
    stalled: false,
    pagesFailed: counts?.failed ?? 0,
    headline: `Flyers loaded — ${window}`,
    detail: `${names(retailers)}, all ${pagesTotal} pages read.`,
  };
}
