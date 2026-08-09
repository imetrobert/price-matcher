/**
 * HTTP helper for retailer adapters.
 *
 * Two rules encoded here:
 *  1. Every failure is classified, never swallowed. A blocked network and a
 *     changed page layout are different problems and the UI says which.
 *  2. We do not attempt to defeat access controls. A 401/403/429 or a bot-check
 *     page is reported as such and the retailer is marked unavailable.
 */

import "server-only";

import { env } from "@/config/env";
import type { AdapterError, RetailerId } from "@/types";

export interface FetchOutcome {
  ok: boolean;
  status: number;
  body: string;
  finalUrl: string;
  error?: AdapterError;
}

const USER_AGENT =
  "CartMatchBot/0.1 (+https://example.invalid/cartmatch; price comparison for personal shopping)";

/**
 * Signals that a response is an anti-bot interstitial rather than the real
 * page. If we see one we stop — we do not try to work around it.
 */
const BOT_WALL_MARKERS = [
  "captcha",
  "are you a human",
  "access denied",
  "request blocked",
  "cf-browser-verification",
  "px-captcha",
  "incapsula",
];

export async function fetchPage(
  url: string,
  retailerId: RetailerId,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    env.retailerFetchTimeoutMs,
  );

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8",
      },
      cache: "no-store",
    });

    const body = await res.text();

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        body: "",
        finalUrl: res.url || url,
        error: {
          code: "NETWORK_BLOCKED",
          retailerId,
          message: `Retailer returned HTTP ${res.status}. Access is restricted; CartMatch does not attempt to bypass access controls.`,
        },
      };
    }

    if (res.status === 429) {
      return {
        ok: false,
        status: res.status,
        body: "",
        finalUrl: res.url || url,
        error: {
          code: "RATE_LIMITED",
          retailerId,
          message: "Retailer rate-limited the request (HTTP 429).",
        },
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body: "",
        finalUrl: res.url || url,
        error: {
          code: res.status === 404 ? "NOT_FOUND" : "UNKNOWN",
          retailerId,
          message: `Retailer returned HTTP ${res.status}.`,
        },
      };
    }

    const lowered = body.slice(0, 4000).toLowerCase();
    if (BOT_WALL_MARKERS.some((m) => lowered.includes(m))) {
      return {
        ok: false,
        status: res.status,
        body: "",
        finalUrl: res.url || url,
        error: {
          code: "NETWORK_BLOCKED",
          retailerId,
          message:
            "Retailer served an anti-bot interstitial instead of the product page. CartMatch does not attempt to bypass it.",
        },
      };
    }

    return { ok: true, status: res.status, body, finalUrl: res.url || url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = message.toLowerCase().includes("abort");
    return {
      ok: false,
      status: 0,
      body: "",
      finalUrl: url,
      error: {
        code: isAbort ? "TIMEOUT" : "NETWORK_BLOCKED",
        retailerId,
        message: isAbort
          ? `Request timed out after ${env.retailerFetchTimeoutMs}ms.`
          : `Network request failed: ${message}. In restricted environments this is usually an egress policy denial.`,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Cheap reachability probe used by health(). */
export async function probeReachable(
  url: string,
  retailerId: RetailerId,
): Promise<{ reachable: boolean; detail: string }> {
  const outcome = await fetchPage(url, retailerId);
  if (outcome.ok) {
    return { reachable: true, detail: `HTTP ${outcome.status}` };
  }
  return {
    reachable: false,
    detail: outcome.error?.message ?? "unreachable",
  };
}
