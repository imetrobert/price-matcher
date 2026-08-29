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
  /**
   * Why the queue is not moving, when a queued page has said. A run waiting
   * out a daily quota is queued and going nowhere, and "31%" alone reads as
   * "nearly there" rather than "tomorrow".
   */
  waitingReason: string | null;
  /** Today, as the shopper reads it — the fixed point everything else is relative to. */
  today: string;
  /**
   * Days this window still has, counting today. 1 means today is the last day;
   * 0 or less means nothing covers today at all.
   *
   * A flyer's window is the one thing on this card that goes stale on its own
   * while nobody touches the app, so the number that matters is not the end
   * date but the distance to it.
   */
  daysLeft: number;
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

/** Whole days from `from` to `to` inclusive, both read at noon UTC. */
function daysBetween(from: string, to: string): number {
  const at = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!, 12);
  };
  return Math.round((at(to) - at(from)) / 86_400_000) + 1;
}

/**
 * The Thursday-to-Wednesday week containing the given day — computed purely
 * from the date, never from stored data.
 *
 * Why this exists: Flipp's own valid_from/valid_to on an offer is not always
 * a normal one-week window — some banners run longer promotions or seasonal
 * catalogs alongside their weekly circular, with a much wider date range on
 * the same feed. Taking the min/max across every currently-valid offer (the
 * first version of this) meant a single such offer could stretch "this
 * week" to "this week through mid-September" on screen, which is not what
 * anybody asking "what week is it" wants to hear. This is the fix: the
 * calendar defines the week, not whatever the widest offer happens to say.
 */
export function currentWeekWindow(on: Date = new Date()): {
  validFrom: string;
  validTo: string;
} {
  const day = on.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const sinceThursday = (day - 4 + 7) % 7; // Thursday = 4
  const thursday = new Date(on);
  thursday.setUTCDate(on.getUTCDate() - sinceThursday);
  const wednesday = new Date(thursday);
  wednesday.setUTCDate(thursday.getUTCDate() + 6);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { validFrom: iso(thursday), validTo: iso(wednesday) };
}

/**
 * Whether an offer's OWN valid_from/valid_to looks like a normal weekly
 * flyer rather than a longer-running promotion or catalog bundled into the
 * same feed.
 *
 * Confirmed against real data (Aug 2026): a single Flipp flyer can contain
 * offers with genuinely different individual windows — most matching the
 * normal 6-7 day week, some running 20-48 days for a seasonal promotion
 * bundled into the same document. Both are real; only the first is "this
 * week" in the sense a grocery shopper means it.
 *
 * Overlapping the current week is not sufficient alone — the current week
 * sits entirely inside a nine-week window by definition — so this also
 * requires the offer's own window to be short.
 *
 * TEN DAYS IS A GUESS, not a measured cutoff — chosen generous enough to
 * tolerate a flyer running Wed-to-Wed instead of Thu-to-Wed without
 * accepting a month-long promotion. The real data confirms a clean gap (6
 * days vs 20+), so 10 sits safely in the middle of it as of this check —
 * revisit if a future flyer's window lands closer to that line.
 */
export function looksLikeCurrentWeek(
  offer: { validFrom: string; validTo: string },
  week: { validFrom: string; validTo: string } = currentWeekWindow(),
): boolean {
  const overlaps = offer.validFrom <= week.validTo && offer.validTo >= week.validFrom;
  const days =
    (Date.parse(offer.validTo) - Date.parse(offer.validFrom)) / 86_400_000;
  return overlaps && days <= 10;
}

function names(retailers: RetailerId[]): string {
  const list = retailers.map((r) => RETAILERS[r]?.displayName ?? r);
  if (list.length === 0) return "no stores";
  if (list.length === 1) return list[0]!;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export type FlyerSource = "SCAN" | "FLIPP" | "BOTH" | "NONE";

/**
 * The label shown next to a retailer for its FlyerSource — one place, so the
 * home screen's sources card and the admin panel's retry list can never say
 * different things for the same state. Previously duplicated as an inline
 * ternary in both files.
 */
export function sourceLabel(source: FlyerSource): string {
  switch (source) {
    case "BOTH":
      return "Flipp and scanned";
    case "SCAN":
      return "Scanned";
    case "FLIPP":
      return "Flipp";
    case "NONE":
      return "Nothing available";
  }
}

export interface RetailerSourceStatus {
  retailerId: RetailerId;
  displayName: string;
  source: FlyerSource;
}

/**
 * Per-retailer picture of where this week's prices are coming from, across
 * every retailer this app tracks.
 *
 * Deliberately separate from flyerStatus() above rather than folded into it.
 * flyerStatus answers "did the flyers I scanned finish being read" — a
 * question about progress on work somebody started. This answers "which
 * stores have ANY current price data at all, and from where" — a question
 * about coverage, which Flipp can satisfy without anybody scanning
 * anything. Conflating them would make a store Flipp already covers look
 * like a gap just because nothing was photographed.
 */
export function flyerSourceSummary(
  scannedRetailers: RetailerId[],
  flippRetailers: RetailerId[],
): RetailerSourceStatus[] {
  const scanned = new Set(scannedRetailers);
  const flipp = new Set(flippRetailers);
  const all = (Object.keys(RETAILERS) as RetailerId[]).sort((a, b) =>
    (RETAILERS[a]?.displayName ?? a).localeCompare(RETAILERS[b]?.displayName ?? b),
  );

  return all.map((retailerId) => {
    const hasScan = scanned.has(retailerId);
    const hasFlipp = flipp.has(retailerId);
    const source: FlyerSource =
      hasScan && hasFlipp
        ? "BOTH"
        : hasScan
          ? "SCAN"
          : hasFlipp
            ? "FLIPP"
            : "NONE";
    return {
      retailerId,
      displayName: RETAILERS[retailerId]?.displayName ?? retailerId,
      source,
    };
  });
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
      waitingReason: null,
      today: day(today),
      daysLeft: 0,
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
            reason: sum.reason ?? c.waitingReason,
          };
        },
        { waiting: 0, failed: 0, reason: null as string | null },
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
      today: day(today),
      daysLeft: daysBetween(today, validTo),
      waitingReason: stalled ? null : (counts?.reason ?? null),
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
    waitingReason: null,
    today: day(today),
    daysLeft: daysBetween(today, validTo),
    headline: `Flyers loaded — ${window}`,
    detail: `${names(retailers)}, all ${pagesTotal} pages read.`,
  };
}
