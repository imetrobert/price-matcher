/**
 * Parses a `schema.org/Product` block. Retailer-agnostic on purpose.
 *
 * Verified against real captures from two unrelated platforms — maxi.ca
 * (Loblaw) and iga.ca (Sobeys), both 2026-08-10, see
 * `src/fixtures/captures/`. That is why this is shared rather than copied per
 * retailer: schema.org is a published standard, the two pages agree on it, and
 * two near-identical parsers is how one of them quietly stops matching the
 * other.
 *
 * The parts that genuinely differ between retailers — where the package size
 * lives, how search works — stay in the per-retailer modules.
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
 *   NO GTIN. `sku` is the retailer's own article number — "21305945_EA" at
 *   Maxi, "598017" at IGA — not a barcode. Level-1 matching is unavailable
 *   from this source at either. Never map `sku` onto a GTIN field: a
 *   fabricated identifier reaching an "exact barcode match" is the single
 *   worst failure this app can produce.
 *
 *   NO SIZE. schema.org/Product has no size or format property, and neither
 *   retailer invents one. This parser does not mine it from the description
 *   either: the same prose carries "115 gram serving" and "13g grams of
 *   protein", so a regex would as happily return 115 g. A confidently wrong
 *   size is worse than no size — the matcher treats size as a hard blocker, so
 *   a wrong one either hides a real saving or matches two different products.
 *
 * Without a size a match cannot reach Level 3, so it lands on fuzzy and is
 * never checkout-eligible. Each retailer module therefore supplies the size
 * from wherever that retailer actually keeps it.
 */

import type { Availability } from "@/types";

export interface SchemaOrgProduct {
  /**
   * The retailer's own article number — "21305945_EA" at Maxi, "598017" at
   * IGA. NOT a GTIN, and never to be treated as one.
   */
  retailerProductId: string;
  name: string;
  brand: string | null;
  /** Canonical product URL with tracking parameters removed. */
  url: string;
  priceCents: number;
  currency: "CAD";
  availability: Availability;
  /**
   * schema.org has no size field, so this is always null here. The
   * per-retailer parser fills it from wherever that retailer actually puts it:
   * Loblaw hides it in markup, IGA appends it to the product name.
   */
  size: string | null;
  /**
   * Always null. Neither captured retailer publishes a barcode — Maxi's `sku`
   * is a Loblaw article number and IGA's is a Sobeys one. Mapping either onto
   * a GTIN would let a fabricated identifier reach a Level-1 "exact barcode
   * match", which is the worst failure this app can produce.
   */
  gtin: null;
}

export type ParseOutcome =
  | { ok: true; product: SchemaOrgProduct }
  | { ok: false; reason: string };

/**
 * @param raw Parsed JSON from a `<script type="application/ld+json">` block.
 */
export function parseSchemaOrgProduct(raw: unknown): ParseOutcome {
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
 *
 * `InStoreOnly` is IN_STOCK, which looks wrong and is not. It means the item
 * cannot be bought online — only on the shelf. For an app whose entire premise
 * is that you are standing in the shop, that is precisely available. IGA
 * returns it for ordinary grocery items.
 */
function readAvailability(value: string): Availability {
  const v = value.toLowerCase();
  if (v.endsWith("/instock") || v === "instock") return "IN_STOCK";
  if (v.endsWith("/instoreonly") || v === "instoreonly") return "IN_STOCK";
  if (v.endsWith("/outofstock") || v === "outofstock") return "OUT_OF_STOCK";
  if (v.endsWith("/soldout") || v === "soldout") return "OUT_OF_STOCK";
  if (v.endsWith("/onlineonly") || v === "onlineonly") return "ONLINE_ONLY";
  return "UNKNOWN";
}

/**
 * Strips tracking parameters so the stored URL is the canonical product page.
 *
 * This URL is shown to a cashier as proof. Maxi's `?source=nspt` says the
 * shopper arrived from an internal promo slot and has nothing to do with the
 * product, so it is noise on a page someone is being asked to trust.
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
