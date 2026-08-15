"use client";

/**
 * Fetch a flyer PDF from a link instead of downloading it by hand.
 *
 * ---------------------------------------------------------------------------
 * WHY IT GOES THROUGH AN EDGE FUNCTION
 * ---------------------------------------------------------------------------
 * Not for secrecy — there is no key involved. Because this site is a static
 * export and the browser cannot have the bytes: a cross-origin fetch of a
 * flyer host is refused before it starts, since none of them send CORS headers
 * for a page on someone else's domain. The fetch has to happen somewhere with
 * no browser sitting on it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT PRODUCES A `File`
 * ---------------------------------------------------------------------------
 * So that a pasted link and a chosen file are the same thing one line later.
 * Everything downstream — reading the store and the week out of the name,
 * counting pages, the duplicate check, the queue, the overlay — already works,
 * and none of it should learn that links exist. The filename comes from the
 * URL's last path segment, which is why "…/maxi-wk33-2026.pdf" arrives already
 * identified exactly as the downloaded file would have.
 */

import { edgeFunctionUrl, env, supabaseConfigured } from "@/config/env";
import { getAccessToken } from "@/lib/auth/session";

export type FetchedFlyer =
  | { ok: true; file: File; bytes: number }
  | { ok: false; error: string };

export async function fetchFlyerByUrl(url: string): Promise<FetchedFlyer> {
  if (!supabaseConfigured()) {
    return {
      ok: false,
      error: "Supabase is not configured, so links cannot be fetched. Download the PDF and choose the file instead.",
    };
  }

  const token = await getAccessToken();
  if (!token) {
    return { ok: false, error: "Sign in before fetching a link." };
  }

  try {
    const res = await fetch(edgeFunctionUrl("cartmatch-flyer-fetch"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        apikey: env.supabaseAnonKey,
      },
      body: JSON.stringify({ url }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        error:
          data?.error ??
          `Fetch failed (HTTP ${res.status}). The cartmatch-flyer-fetch function may not be deployed yet.`,
      };
    }

    const bytes = base64ToBytes(String(data.base64 ?? ""));
    if (bytes.length === 0) {
      return { ok: false, error: "The link returned an empty file." };
    }

    const filename = String(data.filename ?? "flyer.pdf");
    return {
      ok: true,
      bytes: bytes.length,
      // `bytes.buffer` rather than the view: TypeScript's BlobPart will not
      // accept a Uint8Array that might be backed by a SharedArrayBuffer, and
      // the buffer is what File copies anyway.
      file: new File([bytes.buffer as ArrayBuffer], filename, {
        type: "application/pdf",
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "The fetch request failed.",
    };
  }
}

function base64ToBytes(base64: string): Uint8Array {
  if (base64 === "") return new Uint8Array();
  try {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}

/**
 * Split what somebody pasted into links.
 *
 * One per line is the documented shape, but people paste with spaces between
 * them, or with a stray blank line, or with the same link twice because they
 * lost their place. All three are obvious in intent and none of them is worth
 * an error message.
 */
export function splitUrls(input: string, limit = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of input.split(/[\s,]+/)) {
    const url = piece.trim();
    if (url === "" || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}
