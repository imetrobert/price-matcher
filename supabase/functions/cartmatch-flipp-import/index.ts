/**
 * Scheduled, unattended import: pulls this week's Flipp offers for the
 * configured postal code and writes them to cartmatch_flipp_offers.
 *
 * Unlike cartmatch-flipp, nobody is signed in when this runs — pg_cron calls
 * it once a week with nobody watching. So it checks a shared secret instead
 * of a user JWT, and writes with the service role key, which bypasses RLS
 * entirely (this table has no client-write policy on purpose).
 *
 * Fetches every banner CONCURRENTLY, not one at a time like the browser path.
 * The upstream is ~60-90s per call; done serially across seven banners this
 * would blow past any Edge Function's execution ceiling. Nothing here is a
 * screen a person is staring at, so there is no reason not to parallelize.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { normaliseFlyerItems, retailerFromMerchant } from "../_shared/flipp.ts";

export const FUNCTION_BUILD = "2026-08-19-flipp-import-1";
const BASE = "https://backflipp.wishabi.com/flipp";
const TIMEOUT_MS = 90_000;
const USER_AGENT =
  "CartMatch/1.0 (personal grocery price comparison; one household; weekly)";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function getJson(
  url: string,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    try {
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, error: "Not JSON." };
    }
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Request failed.",
    };
  }
}

function extractFlyers(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null);
  }
  if (typeof body === "object" && body !== null) {
    for (const key of ["flyers", "items", "results", "data"]) {
      const value = (body as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        return value.filter(
          (f): f is Record<string, unknown> => typeof f === "object" && f !== null,
        );
      }
    }
  }
  return [];
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "GET") return json({ ok: true, build: FUNCTION_BUILD }, 200);
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  // -- the whole security boundary: a secret only pg_cron knows -------------
  const secret = Deno.env.get("CARTMATCH_CRON_SECRET");
  const given = req.headers.get("X-Cartmatch-Cron-Secret");
  if (!secret || given !== secret) {
    return json({ ok: false, error: "Missing or wrong cron secret." }, 401);
  }

  const postalCode = Deno.env.get("CARTMATCH_POSTAL_CODE");
  if (!postalCode) {
    return json({ ok: false, error: "CARTMATCH_POSTAL_CODE is not set." }, 500);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    return json({ ok: false, error: "Missing SUPABASE_URL / SERVICE_ROLE_KEY." }, 500);
  }
  const supabase = createClient(url, serviceKey);

  // -- list: which flyers are running --------------------------------------
  const listUrl = `${BASE}/flyers?locale=en-CA&postal_code=${encodeURIComponent(postalCode)}`;
  const listed = await getJson(listUrl);
  if (!listed.ok) return json({ ok: false, error: `list: ${listed.error}` }, 502);

  const banners = extractFlyers(listed.body)
    .map((f) => {
      const merchant = f.merchant ?? f.merchant_name ?? f.name;
      return {
        flyerId: String(f.id ?? f.flyer_id ?? ""),
        merchantName: typeof merchant === "string" ? merchant : "",
        retailerId: retailerFromMerchant(merchant),
      };
    })
    .filter((f) => f.retailerId !== null && f.flyerId !== "");

  // -- fetch every banner concurrently --------------------------------------
  const results = await Promise.all(
    banners.map(async (b) => {
      const fetched = await getJson(`${BASE}/flyers/${b.flyerId}`);
      if (!fetched.ok) return { retailerId: b.retailerId!, error: fetched.error, offers: [] };
      const body = fetched.body as Record<string, unknown>;
      const items = Array.isArray(body.items) ? body.items : [];
      const { offers } = normaliseFlyerItems(items, b.merchantName, b.flyerId);
      return { retailerId: b.retailerId!, error: null as string | null, offers };
    }),
  );

  let written = 0;
  const errors: Record<string, string> = {};
  for (const r of results) {
    if (r.error) {
      errors[r.retailerId] = r.error;
      continue;
    }
    // Replace this retailer's rows, not merge — same reasoning as saveFlyer():
    // a re-run this week corrects rather than duplicates.
    await supabase.from("cartmatch_flipp_offers").delete().eq("retailer_id", r.retailerId);
    if (r.offers.length === 0) continue;
    const rows = r.offers.map((o) => ({
      id: o.id,
      flyer_id: o.flyerId,
      retailer_id: o.retailerId,
      advertised_text: o.advertisedText,
      brand: o.brand,
      brands: o.brands,
      size: o.size,
      size_ambiguous: o.sizeAmbiguous,
      price_cents: o.priceCents,
      discount_percent: o.discountPercent,
      basis: o.basis,
      image_url: o.imageUrl,
      multi_product: o.multiProduct,
      valid_from: o.validFrom,
      valid_to: o.validTo,
    }));
    const { error } = await supabase.from("cartmatch_flipp_offers").insert(rows);
    if (error) errors[r.retailerId] = error.message;
    else written += rows.length;
  }

  return json({ ok: true, build: FUNCTION_BUILD, banners: banners.length, written, errors }, 200);
}

Deno.serve(handler);
