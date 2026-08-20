/**
 * Scheduled, unattended import: pulls this week's Flipp offers for the
 * configured postal code and writes them to cartmatch_flipp_offers.
 *
 * Self-contained on purpose: the Supabase Dashboard's single-file deploy
 * editor does not bundle sibling files like ../_shared/flipp.ts the way a
 * CLI/GitHub Actions deploy does, so the normaliser is inlined here rather
 * than imported. If you ever move to CLI deploys, this can go back to
 * importing from _shared/flipp.ts instead — the logic is identical.
 *
 * Unlike cartmatch-flipp, nobody is signed in when this runs — pg_cron calls
 * it once a week with nobody watching. So it checks a shared secret instead
 * of a user JWT, and writes with the service role key, which bypasses RLS
 * entirely (cartmatch_flipp_offers has no client-write policy on purpose).
 *
 * Fetches every banner CONCURRENTLY, not one at a time like the browser path.
 * The upstream is ~60-90s per call; done serially across seven banners this
 * would blow past any Edge Function's execution ceiling.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

export const FUNCTION_BUILD = "2026-08-19-flipp-import-2";
const BASE = "https://backflipp.wishabi.com/flipp";
const TIMEOUT_MS = 90_000;
const USER_AGENT =
  "CartMatch/1.0 (personal grocery price comparison; one household; weekly)";

// ===========================================================================
// Inlined from supabase/functions/_shared/flipp.ts — keep in sync if that
// file changes. See its header for why every offer here is condition-unknown.
// ===========================================================================

type FlippRetailer =
  | "maxi" | "walmart" | "superc" | "metro" | "iga" | "provigo" | "adonis";

const MERCHANTS: [RegExp, FlippRetailer][] = [
  [/\bmaxi\b/, "maxi"],
  [/\bwalmart\b/, "walmart"],
  [/\bsuper\s*c\b/, "superc"],
  [/\bmetro\b/, "metro"],
  [/\biga\b/, "iga"],
  [/\bprovigo\b/, "provigo"],
  [/\badonis\b/, "adonis"],
];

function retailerFromMerchant(name: unknown): FlippRetailer | null {
  if (typeof name !== "string") return null;
  const clean = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  for (const [pattern, id] of MERCHANTS) {
    if (pattern.test(clean)) return id;
  }
  return null;
}

type FlippBasis = "PER_ITEM" | "PER_KG" | "PER_LB" | "UNKNOWN";

function basisFromPrintId(printId: unknown): FlippBasis {
  if (typeof printId !== "string") return "UNKNOWN";
  const suffix = printId.split("_").pop()?.toUpperCase() ?? "";
  if (suffix === "EA") return "PER_ITEM";
  if (suffix === "KG") return "PER_KG";
  if (suffix === "LB") return "PER_LB";
  return "UNKNOWN";
}

function priceToCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  if (typeof value !== "string") return null;
  const match = /^\s*\$?\s*(\d+(?:[.,]\d+)?)\s*$/.exec(value);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]!.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

const RANGE = /\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l|un|oz)\b/i;
const MULTI_ALTERNATIVE = /\b(?:ou|or)\b[^|]{0,40}?\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\b/i;
const SINGLE =
  /(\d+(?:[.,]\d+)?\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\b|\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\b)/i;

function sizeFromName(name: unknown): { size: string | null; ambiguous: boolean } {
  if (typeof name !== "string" || name.trim() === "") {
    return { size: null, ambiguous: false };
  }
  if (RANGE.test(name)) return { size: null, ambiguous: true };
  if (MULTI_ALTERNATIVE.test(name)) return { size: null, ambiguous: true };
  const match = SINGLE.exec(name);
  return match ? { size: match[1]!.trim(), ambiguous: false } : { size: null, ambiguous: false };
}

function brandsFrom(brand: unknown): string[] {
  if (typeof brand !== "string") return [];
  return brand.split("|").map((b) => b.trim()).filter((b) => b !== "");
}

interface NormalisedFlippOffer {
  id: string;
  flyerId: string;
  retailerId: FlippRetailer;
  advertisedText: string;
  brand: string | null;
  brands: string[];
  size: string | null;
  sizeAmbiguous: boolean;
  priceCents: number;
  discountPercent: number | null;
  basis: FlippBasis;
  imageUrl: string | null;
  validFrom: string;
  validTo: string;
  multiProduct: boolean;
}

function isoDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1]! : null;
}

function secureUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("http")) return null;
  return value.replace(/^http:\/\//, "https://");
}

function normaliseFlyerItems(
  items: unknown,
  merchantName: unknown,
  flyerId: unknown,
): { offers: NormalisedFlippOffer[] } {
  const offers: NormalisedFlippOffer[] = [];
  const retailerId = retailerFromMerchant(merchantName);
  if (!Array.isArray(items) || retailerId === null) return { offers };

  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;

    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (name === "") continue;

    const priceCents = priceToCents(row.price);
    if (priceCents === null) continue;

    const validFrom = isoDay(row.valid_from);
    const validTo = isoDay(row.valid_to ?? row.available_to);
    if (!validFrom || !validTo) continue;

    const brands = brandsFrom(row.brand);
    const { size, ambiguous } = sizeFromName(name);
    const discount =
      typeof row.discount === "number" && Number.isFinite(row.discount) && row.discount > 0
        ? Math.round(row.discount)
        : null;

    offers.push({
      id: `flipp-${String(row.id ?? row.flyer_item_id ?? "")}`,
      flyerId: String(row.flyer_id ?? flyerId ?? ""),
      retailerId,
      advertisedText: name,
      brand: brands.length === 1 ? brands[0]! : null,
      brands,
      size,
      sizeAmbiguous: ambiguous,
      priceCents,
      discountPercent: discount,
      basis: basisFromPrintId(row.print_id),
      imageUrl: secureUrl(row.cutout_image_url),
      validFrom,
      validTo,
      multiProduct: brands.length > 1,
    });
  }

  return { offers };
}

// ===========================================================================
// The function itself
// ===========================================================================

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

  const results = await Promise.all(
    banners.map(async (b) => {
      const fetched = await getJson(`${BASE}/flyers/${b.flyerId}`);
      if (!fetched.ok) return { retailerId: b.retailerId!, error: fetched.error, offers: [] as NormalisedFlippOffer[] };
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
