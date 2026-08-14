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
 * WHAT IT DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 * That the set is complete. The app cannot know a shopper meant to load five
 * flyers and loaded three, because nobody told it which stores they care
 * about. So it names the stores it holds rather than counting down to a total
 * it invented — "loaded for Maxi and IGA" is true; "3 of 5" would not be.
 */

import { RETAILERS } from "@/config/retailers";
import type { RetailerId } from "@/types";
import type { StoredFlyer } from "./storage";

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

  if (pagesRead < pagesTotal) {
    return {
      readiness: "PARTIAL",
      retailers,
      validFrom,
      validTo,
      pagesRead,
      pagesTotal,
      percent,
      headline: `Reading ${window} — ${percent}%`,
      detail: `${names(retailers)}: ${pagesRead} of ${pagesTotal} pages read so far. The rest are queued — a page still unread is missing its offers, not free of them.`,
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
    headline: `Flyers loaded — ${window}`,
    detail: `${names(retailers)}, all ${pagesTotal} pages read.`,
  };
}
