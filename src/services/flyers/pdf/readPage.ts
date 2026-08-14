"use client";

/**
 * Asking Gemini to read one rendered flyer page.
 *
 * ---------------------------------------------------------------------------
 * ONE PAGE PER REQUEST
 * ---------------------------------------------------------------------------
 * Not because a model cannot look at several — because a page number has to be
 * a fact rather than an answer. Every offer's page is what makes the checkout
 * proof work: "IGA, page 3, valid until the 19th" is the claim, and it fails
 * the moment the page number is something the model decided.
 *
 * Sending one page means the caller already knows the answer, so the model is
 * never asked. It also keeps a bad page from poisoning a batch, and it makes
 * progress reportable on a phone that is going to sit there for a minute.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE PRODUCES AN OFFER
 * ---------------------------------------------------------------------------
 * This returns CANDIDATES. They become offers only through
 * `verifyExtractedOffer` — against the page's own text where a flyer has any —
 * or a person's confirmation. See toOffers.ts, which is the only door.
 */

import { edgeFunctionUrl, env, supabaseConfigured } from "@/config/env";
import { getAccessToken } from "@/lib/auth/session";

import { parseFlyerExtraction } from "./parseExtraction";
import type { ExtractedOffer } from "./types";
import type { RenderedFlyerPage } from "./renderPages";

export type ReadPageOutcome =
  | {
      ok: true;
      offers: ExtractedOffer[];
      rejected: string[];
      model: string;
      /** Store branding read off this page, verbatim. Usually only page 1. */
      retailerName: string | null;
      /** Run dates printed on this page, YYYY-MM-DD. Usually only page 1. */
      validFrom: string | null;
      validTo: string | null;
    }
  | { ok: false; error: string; code?: string };

/** Data URL in, base64 payload and mime type out. */
function splitDataUrl(dataUrl: string): { base64: string; mimeType: string } {
  const match = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return { base64: "", mimeType: "image/jpeg" };
  return { mimeType: match[1] ?? "image/jpeg", base64: match[2] ?? "" };
}

/**
 * How long to wait before asking again, per attempt.
 *
 * Widening, because a demand spike lasts longer than a moment and hammering it
 * every two seconds is both rude and unhelpful. Four attempts spanning about
 * half a minute covers the spikes seen so far without leaving someone staring
 * at a phone indefinitely — and a page that is still refused after that is
 * reported as refused rather than retried forever.
 */
const OVERLOAD_BACKOFF_MS = [2_000, 6_000, 15_000];

/**
 * How long to wait when the KEY is the limit rather than the model.
 *
 * A free-tier quota is measured per minute, so backing off for fifteen seconds
 * spends another request inside the same window and fails again. These waits
 * are long enough to reach the next window.
 *
 * Found on a Super C flyer: page 1 read fine, page 2 came back 429, three
 * quick retries all landed in the same minute, and the run stopped with one
 * page of seventeen read.
 */
const RATE_LIMIT_BACKOFF_MS = [25_000, 45_000, 65_000];

/**
 * Minimum gap between page requests.
 *
 * Pacing beats recovering. A free key allows something in the region of a
 * dozen requests a minute, and a seventeen-page flyer sent as fast as the
 * network allows will trip that on page two every time — then spend a minute
 * recovering from a limit it created. Five seconds turns a burst into a
 * steady twelve a minute, which a whole flyer can sustain.
 *
 * The cost is about ninety seconds for a seventeen-page flyer. That is a
 * price worth paying once a week for a complete flyer instead of one page.
 */
const MIN_REQUEST_INTERVAL_MS = 5_000;

/**
 * How much to slow down after the key says no, and how far that can go.
 *
 * Five seconds is a guess at somebody else's quota, and a guess is wrong for
 * exactly the reason this keeps happening: the key is shared. Another app on
 * the same Supabase project can spend the minute's allowance while this one is
 * behaving, so the right interval is not knowable in advance — but it is
 * observable. Every rate-limit widens the gap for the rest of the run.
 *
 * Capped, because past twenty seconds a page the wait stops being pacing and
 * becomes a hang; at that point the honest move is to stop and say which pages
 * were not read.
 */
const PACING_BACKOFF_FACTOR = 2;
const MAX_REQUEST_INTERVAL_MS = 20_000;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Read one page, waiting out a busy model rather than giving up on it.
 *
 * The first real run lost pages 3 to 7 of eight to "this model is currently
 * experiencing high demand" — a transient condition that says nothing about
 * the flyer, recorded as five unreadable pages. Choosing a quieter model helps
 * and does not fix it; waiting does.
 *
 * Only overload is retried. A malformed page, a bad key or a wrong model would
 * fail identically however many times it is asked, and retrying those would
 * turn one clear error into four slow ones.
 */
export async function readFlyerPage(
  page: RenderedFlyerPage,
  signal?: AbortSignal,
  onRateLimited?: () => void,
): Promise<ReadPageOutcome> {
  for (let attempt = 0; ; attempt++) {
    const outcome = await readFlyerPageOnce(page);
    if (outcome.ok) return outcome;

    if (outcome.code === "RATE_LIMITED") onRateLimited?.();

    const waits =
      outcome.code === "RATE_LIMITED"
        ? RATE_LIMIT_BACKOFF_MS
        : outcome.code === "OVERLOADED"
          ? OVERLOAD_BACKOFF_MS
          : null;

    if (waits === null) return outcome;
    if (attempt >= waits.length) return outcome;
    if (signal?.aborted) return outcome;
    await wait(waits[attempt]!, signal);
  }
}

async function readFlyerPageOnce(
  page: RenderedFlyerPage,
): Promise<ReadPageOutcome> {
  if (!supabaseConfigured()) {
    return { ok: false, error: "Supabase is not configured." };
  }
  const token = await getAccessToken();
  if (!token) return { ok: false, error: "Sign in first.", code: "NOT_SIGNED_IN" };

  const { base64, mimeType } = splitDataUrl(page.imageDataUrl);
  if (base64 === "") {
    return { ok: false, error: `Page ${page.pageNumber} did not render to an image.` };
  }

  try {
    const res = await fetch(edgeFunctionUrl("cartmatch-vision"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        apikey: env.supabaseAnonKey,
      },
      body: JSON.stringify({ mode: "flyer", images: [{ base64, mimeType }] }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data?.ok) {
      // 401 and 403 are different problems and must not share a message: the
      // second person is already signed in, and telling them to sign in sends
      // them round a loop they cannot leave.
      return {
        ok: false,
        code:
          data?.code === "OVERLOADED"
            ? "OVERLOADED"
            : res.status === 401
              ? "NOT_SIGNED_IN"
              : res.status === 403
                ? "NOT_AUTHORIZED"
                : "API_ERROR",
        error: data?.error ?? `Reading page ${page.pageNumber} failed (HTTP ${res.status}).`,
      };
    }

    // Guard against an older deployment answering with the cart reader. Its
    // reply parses to zero offers, which would read as "this page advertises
    // nothing" — a finding, when the truth is that the wrong prompt ran.
    if (data.mode !== undefined && data.mode !== "flyer") {
      return {
        ok: false,
        code: "STALE_FUNCTION",
        error:
          "The cartmatch-vision Edge Function answering does not know how to read a flyer yet. Redeploy it.",
      };
    }

    const { offers, rejected, retailerName, validFrom, validTo } =
      parseFlyerExtraction(data.raw, page.pageNumber);
    return {
      ok: true,
      offers,
      rejected,
      retailerName,
      validFrom,
      validTo,
      model: String(data.model ?? "unknown"),
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const networkish =
      err instanceof TypeError || /load failed|failed to fetch/i.test(raw);
    return {
      ok: false,
      error: networkish
        ? "Could not reach the flyer reader. Check the Edge Function is deployed and CARTMATCH_ALLOWED_ORIGINS includes this site."
        : raw,
    };
  }
}

export interface ReadFlyerProgress {
  page: number;
  pageCount: number;
  offersSoFar: number;
}

export interface ReadFlyerResult {
  offers: ExtractedOffer[];
  rejected: string[];
  /** Pages that were tried and refused, with the reason for each. */
  failedPages: { pageNumber: number; error: string }[];
  /**
   * Pages the run never got to.
   *
   * Kept apart from `failedPages` because conflating them lies. A Super C run
   * reported "pages that failed: 2" after reading page 1 and stopping — which
   * reads as sixteen good pages and one bad one, when it was one good page and
   * sixteen never attempted. A person deciding whether they have this week's
   * prices needs that difference.
   */
  notAttempted: number[];
  model: string | null;
  /** Store branding read off the pages, for confirming which flyer this is. */
  retailerName: string | null;
  /** The run dates printed in the flyer, YYYY-MM-DD. */
  validFrom: string | null;
  validTo: string | null;
}

/**
 * Read a whole flyer, one page at a time.
 *
 * Sequential on purpose. Sixteen concurrent requests from a phone is a good way
 * to hit a rate limit and get back a partial flyer with no obvious sign that it
 * is partial — and the pages are not in a hurry.
 *
 * A page that fails does not stop the rest. It is recorded in `failedPages`,
 * because "we read fifteen of sixteen" is a true statement the person can act
 * on, and silently returning fifteen is not.
 */
export async function readFlyerPages(
  pages: RenderedFlyerPage[],
  options: {
    onProgress?: (progress: ReadFlyerProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ReadFlyerResult> {
  const offers: ExtractedOffer[] = [];
  const rejected: string[] = [];
  const failedPages: { pageNumber: number; error: string }[] = [];
  let model: string | null = null;
  let retailerName: string | null = null;
  let validFrom: string | null = null;
  let validTo: string | null = null;
  let stoppedAt = -1;
  let lastRequestAt = 0;
  let interval = MIN_REQUEST_INTERVAL_MS;

  for (const [index, page] of pages.entries()) {
    if (options.signal?.aborted) {
      stoppedAt = index;
      break;
    }

    // Pace, rather than sprint and recover. See MIN_REQUEST_INTERVAL_MS.
    const sinceLast = Date.now() - lastRequestAt;
    if (lastRequestAt > 0 && sinceLast < interval) {
      await wait(interval - sinceLast, options.signal);
    }
    lastRequestAt = Date.now();
    options.onProgress?.({
      page: page.pageNumber,
      pageCount: pages.length,
      offersSoFar: offers.length,
    });

    const outcome = await readFlyerPage(page, options.signal, () => {
      // Widen for the REST of the run, not just this page. A quota that was
      // too tight for page two is too tight for page three as well, and
      // learning that once beats rediscovering it fifteen times.
      interval = Math.min(interval * PACING_BACKOFF_FACTOR, MAX_REQUEST_INTERVAL_MS);
    });
    if (!outcome.ok) {
      failedPages.push({ pageNumber: page.pageNumber, error: outcome.error });
      // A stale function or a lost session will fail identically on every
      // remaining page. Sixteen copies of one message helps nobody.
      if (outcome.code === "STALE_FUNCTION" || outcome.code === "NOT_SIGNED_IN") {
        stoppedAt = index + 1;
        break;
      }
      // Still refused after every retry. Grinding through fifteen more pages
      // to collect fifteen more copies of the same message wastes the person's
      // time; stop, and say exactly which pages were never tried.
      if (outcome.code === "OVERLOADED" || outcome.code === "RATE_LIMITED") {
        stoppedAt = index + 1;
        break;
      }
      continue;
    }
    offers.push(...outcome.offers);
    rejected.push(...outcome.rejected);
    model = outcome.model;
    // First page that names a store wins. Later pages carry section headers
    // and supplier logos, and overwriting with those would end up deciding a
    // Maxi flyer belongs to whoever advertised on page nine.
    retailerName ??= outcome.retailerName;
    // Same first-wins rule as the store name, for the same reason: later pages
    // carry section dates and coupon expiries, and the flyer's own window is
    // printed on the cover.
    if (validFrom === null && outcome.validFrom && outcome.validTo) {
      validFrom = outcome.validFrom;
      validTo = outcome.validTo;
    }
  }

  return {
    offers,
    rejected,
    failedPages,
    notAttempted:
      stoppedAt === -1
        ? []
        : pages.slice(stoppedAt).map((p) => p.pageNumber),
    model,
    retailerName,
    validFrom,
    validTo,
  };
}
