/**
 * Parses the `schema.org/Product` block Loblaw banners embed in product pages.
 *
 * Verified against a real capture from maxi.ca (store 7495, 2026-08-10) — see
 * `src/fixtures/captures/`. Everything this file claims about the shape of that
 * JSON is a statement about a page that was actually loaded, not a guess.
 *
 * ---------------------------------------------------------------------------
 * WHY JSON-LD AND NOT CSS SELECTORS
 * ---------------------------------------------------------------------------
 * The price is published as structured data for search engines, so it is
 * stable in a way markup is not: a redesign rearranges the DOM but rarely
 * changes the schema.org contract, because breaking it would cost the retailer
 * its rich results in Google. Selectors keyed to class names break silently and
 * return the wrong number; a missing JSON-LD field is absent, and absence is
 * something this code can detect and refuse to guess about.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SOURCE DOES NOT CONTAIN — READ BEFORE RELYING ON IT
 * ---------------------------------------------------------------------------
 * Two omissions matter, and neither is worked around here:
 *
 *   NO GTIN. `sku` is Loblaw's own article number ("21305945_EA"), not a
 *   barcode. Level-1 matching is therefore unavailable from this source. Never
 *   map `sku` onto a GTIN field — a fabricated identifier reaching a "GTIN
 *   match" is the single worst failure this app can produce.
 *
 *   NO SIZE. There is no size or format field. "650g" appears only inside the
 *   marketing description ("Value-sized 650g tub"), and this parser deliberately
 *   does not mine it from there: the same prose also contains "115 gram
 *   serving" and "13g grams of protein", so a regex would as happily return 115
 *   g or 13 g. A confidently wrong size is worse than no size — the matcher
 *   treats a size mismatch as a hard blocker, and a wrong one either hides a
 *   real saving or, far worse, matches two different products.
 *
 * The consequence is deliberate and visible: without a size, a match cannot
 * reach Level 3, so it lands on Level 4 fuzzy, which is never eligible for
 * checkout proof. This source alone can say "cheaper elsewhere"; it cannot
 * support "show this to a cashier". Closing that gap needs the size from
 * somewhere else on the page.
 */

import type { Availability } from "@/types";

export interface LoblawProduct {
  /** Retailer article number, e.g. "21305945_EA". NOT a GTIN. */
  retailerProductId: string;
  name: string;
  brand: string | null;
  /** Canonical product URL with tracking parameters removed. */
  url: string;
  priceCents: number;
  currency: "CAD";
  availability: Availability;
  /**
   * Never from the JSON-LD, which has no size field. `parseLoblawProductPage`
   * fills this from the markup; `parseLoblawProductJsonLd` alone always leaves
   * it null.
   */
  size: string | null;
  /** Always null: this source carries no barcode. See the header. */
  gtin: null;
}

export type ParseOutcome =
  | { ok: true; product: LoblawProduct }
  | { ok: false; reason: string };

/**
 * @param raw Parsed JSON from a `<script type="application/ld+json">` block.
 */
export function parseLoblawProductJsonLd(raw: unknown): ParseOutcome {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "Not a JSON object." };
  }
  const node = raw as Record<string, unknown>;

  // A page carries several JSON-LD blocks — WebSite, BreadcrumbList, Product.
  // Only the Product one is a price.
  if (node["@type"] !== "Product") {
    return { ok: false, reason: `Not a Product node (@type=${String(node["@type"])}).` };
  }

  const name = str(node.name);
  if (!name) return { ok: false, reason: "Product has no name." };

  const sku = str(node.sku);
  if (!sku) return { ok: false, reason: "Product has no sku." };

  const offers = node.offers;
  if (typeof offers !== "object" || offers === null) {
    return { ok: false, reason: "Product has no offers block, so no price." };
  }
  const offer = offers as Record<string, unknown>;

  // Currency is checked rather than assumed. A CAD app quietly treating a USD
  // number as dollars would understate every comparison, and the error would
  // look like a good deal.
  const currency = str(offer.priceCurrency);
  if (currency !== "CAD") {
    return { ok: false, reason: `Price is in ${currency || "an unknown currency"}, not CAD.` };
  }

  const priceCents = toCents(offer.price);
  if (priceCents === null) {
    return { ok: false, reason: `Could not read a price from ${JSON.stringify(offer.price)}.` };
  }

  const url = cleanUrl(str(offer.url) || str(node.url));
  if (!url) return { ok: false, reason: "Product has no URL." };

  return {
    ok: true,
    product: {
      retailerProductId: sku,
      name,
      brand: readBrand(node.brand),
      url,
      priceCents,
      currency: "CAD",
      availability: readAvailability(str(offer.availability)),
      size: null,
      gtin: null,
    },
  };
}

/** Finds the Product node among the several JSON-LD blocks on a page. */
export function findProductNode(blocks: unknown[]): unknown | null {
  for (const block of blocks) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>)["@type"] === "Product"
    ) {
      return block;
    }
  }
  return null;
}

/**
 * schema.org allows `price` as a number or a string, so both are accepted —
 * but only in forms where the value is unambiguous.
 *
 * Deliberately strict about floats: 7.49 * 100 is 748.9999999999999 in
 * IEEE-754, and `Math.round` is applied rather than truncation for exactly that
 * reason. Currency is integer cents everywhere else in this codebase and this
 * is the boundary where that has to be enforced.
 */
function toCents(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(value * 100);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Only a plain decimal. A string carrying symbols, thousands separators or
    // a range ("2 for $5") is not something to interpret here.
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
    return Math.round(Number(trimmed) * 100);
  }
  return null;
}

function readBrand(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "object" && value !== null) {
    const name = str((value as Record<string, unknown>).name);
    return name || null;
  }
  return null;
}

/**
 * Anything not explicitly recognised is UNKNOWN rather than assumed in stock.
 * "Probably available" is how someone drives to a shop for nothing.
 */
function readAvailability(value: string): Availability {
  const v = value.toLowerCase();
  if (v.endsWith("/instock") || v === "instock") return "IN_STOCK";
  if (v.endsWith("/outofstock") || v === "outofstock") return "OUT_OF_STOCK";
  if (v.endsWith("/onlineonly") || v === "onlineonly") return "ONLINE_ONLY";
  return "UNKNOWN";
}

/**
 * Strips tracking parameters so the stored URL is the canonical product page.
 *
 * This URL is shown to a cashier as proof. `?source=nspt` says the shopper
 * arrived from an internal promo slot and has nothing to do with the product,
 * so it is noise on a page someone is being asked to trust.
 */
function cleanUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    for (const param of ["source", "utm_source", "utm_medium", "utm_campaign"]) {
      url.searchParams.delete(param);
    }
    return url.toString();
  } catch {
    return value;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
