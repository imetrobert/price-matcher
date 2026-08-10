"use client";

/**
 * Asks the Edge Function what a retailer actually returns to a datacenter.
 *
 * This is a diagnostic, not part of the shopping flow. It exists because every
 * parser in this project was written against pages a person captured in a
 * browser, and a server fetching the same URL is a different situation — one
 * nobody has tested. It answers that with evidence rather than assumption, and
 * it reports a challenge page as a challenge page rather than as a failure to
 * parse.
 */

import { edgeFunctionUrl, env, supabaseConfigured } from "@/config/env";
import { getAccessToken } from "@/lib/auth/session";

/**
 * ---------------------------------------------------------------------------
 * THE ANSWER, MEASURED 2026-08-10
 * ---------------------------------------------------------------------------
 * Both maxi.ca and iga.ca returned **HTTP 403** to a request from a Supabase
 * Edge Function, using the exact product URLs whose pages parse correctly when
 * captured in a browser.
 *
 * Not a challenge page, not a timeout, not a parse failure: a flat refusal.
 * Server-side price fetching from this deployment does not work, and no amount
 * of parser improvement changes that.
 *
 * This function is kept so the finding can be re-measured rather than
 * remembered. Retailers change their posture, and "we tried once in August"
 * ages badly.
 * ---------------------------------------------------------------------------
 */
export interface ProbeResult {
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  hasJsonLdProduct: boolean;
  priceFromJsonLd: string | null;
  looksLikeChallenge: boolean;
  challengeMarkers: string[];
  hops: string[];
  note: string | null;
  bodyPreview: string;
  signals?: Record<string, string>;
}

export type ProbeOutcome =
  | { ok: true; result: ProbeResult }
  | { ok: false; error: string };

export async function probeRetailerUrl(url: string): Promise<ProbeOutcome> {
  if (!supabaseConfigured()) {
    return { ok: false, error: "Supabase is not configured." };
  }
  const token = await getAccessToken();
  if (!token) return { ok: false, error: "Sign in first." };

  try {
    const res = await fetch(edgeFunctionUrl("cartmatch-retailer"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        apikey: env.supabaseAnonKey,
      },
      body: JSON.stringify({ action: "probe", url }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error ?? `Probe failed (HTTP ${res.status}).` };
    }
    return { ok: true, result: data.result as ProbeResult };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const networkish =
      err instanceof TypeError || /load failed|failed to fetch/i.test(raw);
    return {
      ok: false,
      error: networkish
        ? "Could not reach the retailer probe. The cartmatch-retailer Edge Function is probably not deployed yet."
        : raw,
    };
  }
}

/**
 * One line saying what the probe actually proved.
 *
 * The important case is the middle one: HTTP 200 with no product block. That
 * looks like success in a status code and is not — it is what a bot challenge
 * returns, and reading it as a working fetch is how a scraper ends up
 * confidently returning nothing.
 */
export function summariseProbe(r: ProbeResult): string {
  if (r.hasJsonLdProduct) {
    return `Fetch works. Product data survived, price ${r.priceFromJsonLd}.`;
  }
  if (r.looksLikeChallenge) {
    const why = r.challengeMarkers.length
      ? `matched: ${r.challengeMarkers.join(", ")}`
      : `HTTP ${r.status}, ${r.bytes} bytes — too small to be a product page`;
    return `Blocked. The retailer served a challenge rather than the page (${why}).`;
  }
  if (r.status >= 400) {
    return `Refused with HTTP ${r.status}.`;
  }
  return `HTTP ${r.status}, ${r.bytes} bytes, but no schema.org Product block. The page loaded and is not what we parse.`;
}
