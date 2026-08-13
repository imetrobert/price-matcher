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
  /**
   * Which build of the Edge Function answered.
   *
   * Optional because a deployment older than the marker cannot report one —
   * which is itself the answer. A paste that does not take is otherwise
   * invisible: the old code keeps answering, honestly and staler.
   */
  functionBuild?: string;
  /**
   * Candidate flyer page-image URLs found in the body.
   *
   * Optional because an older deployment of the Edge Function does not send it.
   * Absent and empty mean different things — "this deployment cannot answer"
   * versus "answered, found none" — and `summariseProbe` keeps them apart.
   */
  flyerImages?: string[];
  /**
   * Host -> count for every image URL in the body.
   *
   * What tells an empty `flyerImages` apart from a filter that is too strict.
   * superc.ca returned 227 KB of server-rendered HTML and no flyer images,
   * which could mean either — and the two lead in opposite directions.
   */
  imageHosts?: Record<string, number>;
  /** A few image URLs verbatim and unfiltered, to judge rather than infer. */
  sampleImages?: string[];
  /** Context around a substring the caller asked about. */
  matches?: string[];
}

/** Does this look like a flyer viewer rather than a product page? */
function isFlyerTarget(r: ProbeResult): boolean {
  return /\/(print-)?flyer|circulaire/i.test(r.finalUrl);
}

/**
 * Did the probe get what it went for?
 *
 * Two targets, two definitions of success, and conflating them would paint
 * every working flyer fetch red: a product page succeeds when product data
 * survives, a flyer viewer when its page images are in the HTML.
 */
export function probeSucceeded(r: ProbeResult): boolean {
  if (isFlyerTarget(r)) return (r.flyerImages?.length ?? 0) > 0;
  return r.hasJsonLdProduct;
}

export type ProbeOutcome =
  | { ok: true; result: ProbeResult }
  | { ok: false; error: string };

export async function probeRetailerUrl(
  url: string,
  find = "",
): Promise<ProbeOutcome> {
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
      body: JSON.stringify({ action: "probe", url, find }),
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
  // A flyer viewer is judged on different evidence. It has no Product block and
  // never will, so the product-page verdict would call every success a failure.
  if (isFlyerTarget(r) && r.status < 400) {
    if (r.flyerImages === undefined) {
      return `HTTP ${r.status}, ${r.bytes} bytes — but the Edge Function answering is build "${r.functionBuild ?? "older than build markers"}", which cannot look for page images. The retailer is fine; the deploy did not take.`;
    }
    if (r.flyerImages.length > 0) {
      return `Flyer page came through with ${r.flyerImages.length} page image${r.flyerImages.length === 1 ? "" : "s"} in the HTML. A weekly import has a supply line.`;
    }
    if (r.looksLikeChallenge) {
      return `Blocked. The retailer served a challenge rather than the flyer.`;
    }
    const hosts = Object.entries(r.imageHosts ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([host, n]) => `${host} (${n})`);
    if (hosts.length === 0) {
      return `HTTP ${r.status}, ${r.bytes} bytes, and not one image URL anywhere in the HTML. The viewer builds itself entirely in the browser.`;
    }
    return `HTTP ${r.status}, ${r.bytes} bytes. No image URL looks like a flyer page, but the page does carry images: ${hosts.join(", ")}. Check whether the pages live on one of those before concluding they are not here.`;
  }

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

// ---------------------------------------------------------------------------
// Open Food Facts barcode lookup
// ---------------------------------------------------------------------------

/**
 * Canonical product identity from a barcode.
 *
 * The reason this matters: neither Maxi nor IGA publishes a GTIN, so matching
 * between them currently rests on brand, name and size — Level 3 at best. A
 * real barcode makes Level 1 reachable, which is the only match this app treats
 * as certain rather than inferred.
 *
 * Open Food Facts is ODbL and crowd-sourced. `notFound` is an ordinary answer,
 * not an error, and `quantity` is free text exactly as someone typed it — the
 * app's own size parser decides whether it is usable.
 */
export interface BarcodeLookup {
  found: boolean;
  gtin: string;
  name?: string | null;
  brand?: string | null;
  quantity?: string | null;
  attribution?: string;
}

export type BarcodeOutcome =
  | { ok: true; result: BarcodeLookup }
  | { ok: false; error: string };

export async function lookupBarcode(gtin: string): Promise<BarcodeOutcome> {
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
      body: JSON.stringify({ action: "barcode", gtin }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error ?? `Lookup failed (HTTP ${res.status}).` };
    }
    return { ok: true, result: data as BarcodeLookup };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const networkish =
      err instanceof TypeError || /load failed|failed to fetch/i.test(raw);
    return {
      ok: false,
      error: networkish
        ? "Could not reach the lookup service. cartmatch-retailer may need redeploying — the barcode action is newer than the probe."
        : raw,
    };
  }
}
