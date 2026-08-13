/**
 * When to go looking for a new flyer, and how to tell whether we got one.
 *
 * ---------------------------------------------------------------------------
 * THURSDAY IS A HINT, NOT A FACT
 * ---------------------------------------------------------------------------
 * Montreal grocery flyers turn over on Thursday, so Thursday is when it is
 * worth looking. But a schedule cannot establish which week a flyer is for.
 * Retailers switch at different hours, a fetch can land before the changeover,
 * and a viewer can serve a cached page for hours afterwards.
 *
 * If the calendar were treated as the answer, a Thursday-morning fetch that
 * returned last week's flyer would be imported as this week's — and every
 * price in it would be presented as current when it had already expired. That
 * is the worst failure this app has: not a missing saving, a false one.
 *
 * So the schedule decides only when to ASK. What decides whether a flyer is
 * accepted is the validity window printed on the flyer itself. If the dates
 * have not moved, the retailer has not switched, and the right response is to
 * keep the flyer we have and ask again later.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WEEK IS COMPUTED IN MONTREAL, NOT IN UTC
 * ---------------------------------------------------------------------------
 * A Supabase cron fires in UTC, where Thursday begins at 19:00 or 20:00
 * Wednesday local depending on daylight saving. Anchoring the week to Montreal
 * dates keeps "this week's flyer" meaning the same thing in March as in
 * December, and keeps a scheduled job from importing on the wrong side of a
 * changeover twice a year.
 */

import type { ValidityPeriod } from "@/types";

const TIME_ZONE = "America/Montreal";

/** Thursday. Flyer weeks in Montreal run Thursday to Wednesday. */
const FLYER_WEEK_STARTS_ON = 4;

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface LocalDate {
  /** YYYY-MM-DD as it reads on a Montreal calendar. */
  date: string;
  /** 0 = Sunday. */
  weekday: number;
}

/**
 * The Montreal calendar date for an instant.
 *
 * Via `Intl` rather than an offset constant, because the offset changes twice a
 * year and a hard-coded one is wrong for half of it.
 */
export function montrealDate(at: Date): LocalDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAYS.indexOf(get("weekday"));

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: weekday === -1 ? 0 : weekday,
  };
}

/**
 * The Thursday on or before a given instant, as a Montreal date.
 *
 * Date-only arithmetic in UTC on purpose: subtracting days from a bare
 * YYYY-MM-DD cannot cross a daylight-saving boundary wrongly, whereas
 * subtracting 24 hours from a timestamp can.
 */
export function flyerWeekStart(at: Date): string {
  const { date, weekday } = montrealDate(at);
  const back = (weekday - FLYER_WEEK_STARTS_ON + 7) % 7;
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d!) - back * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

/** True on Thursday in Montreal, whatever the clock says in UTC. */
export function isFlyerDay(at: Date): boolean {
  return montrealDate(at).weekday === FLYER_WEEK_STARTS_ON;
}

export type ImportDecision =
  | { attempt: true; reason: string }
  | { attempt: false; reason: string };

export interface HeldFlyer {
  /** Validity printed on the flyer we already hold, if any. */
  validity: ValidityPeriod | null;
}

/**
 * Should we go and look for a new flyer right now?
 *
 * Deliberately willing to ask on days that are not Thursday, because the cost
 * of an unnecessary request is one request, and the cost of a gap is that the
 * app has nothing to compare against. Coverage first, politeness second:
 *
 *   Nothing held        ask, any day. There is no flyer to protect.
 *   Held one expired    ask, any day. We are already uncovered.
 *   Held one still runs into this flyer week, and it is not Thursday
 *                       don't ask. The flyer we have is the current one.
 *   Thursday, and what we hold started before this week's Thursday
 *                       ask. This is the changeover.
 *   Thursday, already holding this week's
 *                       don't ask. Done for the week.
 */
export function shouldAttemptImport(
  held: HeldFlyer,
  now: Date,
): ImportDecision {
  const weekStart = flyerWeekStart(now);
  const validity = held.validity;

  if (!validity?.startsAt) {
    return { attempt: true, reason: "No flyer held for this retailer." };
  }

  if (validity.endsAt && validity.endsAt < isoDate(now)) {
    return {
      attempt: true,
      reason: `Held flyer ended ${validity.endsAt}; nothing covers today.`,
    };
  }

  if (isoDate(validity.startsAt) >= weekStart) {
    return {
      attempt: false,
      reason: `Already holding the flyer for the week of ${weekStart}.`,
    };
  }

  if (isFlyerDay(now)) {
    return {
      attempt: true,
      reason: `Thursday changeover: held flyer starts ${isoDate(validity.startsAt)}, this week starts ${weekStart}.`,
    };
  }

  return {
    attempt: false,
    reason: `Held flyer still runs; next changeover is the Thursday of the week starting ${weekStart}.`,
  };
}

export type FlyerAcceptance =
  | { accept: true; reason: string }
  | { accept: false; reason: string };

/**
 * Is the flyer we just downloaded actually new?
 *
 * The gate that stops a Thursday-morning fetch from re-importing last week's
 * flyer under this week's name. Three refusals, and every one of them has
 * happened to somebody:
 *
 *   No printed dates      unusable outright. An offer without an end date
 *                         cannot back a claim at a till, so a flyer without
 *                         one cannot produce offers.
 *   Same dates as held    the retailer has not switched yet. Keep what we
 *                         have and ask again later; do not renumber it.
 *   Already expired       a stale cached page. Importing it would fill the
 *                         database with prices that were never current.
 */
export function acceptDownloadedFlyer(
  held: HeldFlyer,
  candidate: ValidityPeriod,
  now: Date,
): FlyerAcceptance {
  if (!candidate.startsAt || !candidate.endsAt) {
    return {
      accept: false,
      reason:
        "The flyer does not print both a start and an end date, so its offers could never be shown.",
    };
  }

  if (isoDate(candidate.endsAt) < isoDate(now)) {
    return {
      accept: false,
      reason: `This flyer ended ${isoDate(candidate.endsAt)} — a cached page, not the current flyer.`,
    };
  }

  const heldStart = held.validity?.startsAt;
  if (heldStart && isoDate(candidate.startsAt) <= isoDate(heldStart)) {
    return {
      accept: false,
      reason: `Same dates as the flyer already held (${isoDate(heldStart)}). The retailer has not switched yet.`,
    };
  }

  return {
    accept: true,
    reason: `New flyer running ${isoDate(candidate.startsAt)} to ${isoDate(candidate.endsAt)}.`,
  };
}

/** Tolerates a full timestamp or a bare date; compares as a Montreal date. */
function isoDate(value: string | Date): string {
  if (value instanceof Date) return montrealDate(value).date;
  return value.length > 10 ? montrealDate(new Date(value)).date : value;
}
