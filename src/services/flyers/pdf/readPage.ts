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
  | { ok: true; offers: ExtractedOffer[]; rejected: string[]; model: string }
  | { ok: false; error: string; code?: string };

/** Data URL in, base64 payload and mime type out. */
function splitDataUrl(dataUrl: string): { base64: string; mimeType: string } {
  const match = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return { base64: "", mimeType: "image/jpeg" };
  return { mimeType: match[1] ?? "image/jpeg", base64: match[2] ?? "" };
}

export async function readFlyerPage(
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
          res.status === 401
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

    const { offers, rejected } = parseFlyerExtraction(data.raw, page.pageNumber);
    return { ok: true, offers, rejected, model: String(data.model ?? "unknown") };
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
  /** Pages that could not be read at all, with the reason for each. */
  failedPages: { pageNumber: number; error: string }[];
  model: string | null;
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

  for (const page of pages) {
    if (options.signal?.aborted) break;
    options.onProgress?.({
      page: page.pageNumber,
      pageCount: pages.length,
      offersSoFar: offers.length,
    });

    const outcome = await readFlyerPage(page);
    if (!outcome.ok) {
      failedPages.push({ pageNumber: page.pageNumber, error: outcome.error });
      // A stale function or a lost session will fail identically on every
      // remaining page. Sixteen copies of one message helps nobody.
      if (outcome.code === "STALE_FUNCTION" || outcome.code === "NOT_SIGNED_IN") {
        break;
      }
      continue;
    }
    offers.push(...outcome.offers);
    rejected.push(...outcome.rejected);
    model = outcome.model;
  }

  return { offers, rejected, failedPages, model };
}
