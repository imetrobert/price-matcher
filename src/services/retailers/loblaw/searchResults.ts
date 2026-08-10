/**
 * Parses a Loblaw search result item into a match candidate.
 *
 * Verified against a real capture: `maxi.ca?search-bar=oikos`, store 7495,
 * 2026-08-10. See `src/fixtures/captures/`.
 *
 * This is a far better source than the product page — brand, size and price all
 * arrive as structured fields rather than being scraped — but it carries three
 * traps that a naive read walks straight into.
 *
 * ---------------------------------------------------------------------------
 * 1. SPONSORED RESULTS ARE ADVERTISEMENTS
 * ---------------------------------------------------------------------------
 * Both results in the capture are `isSponsored: true`, and both are Yoplait YOP
 * drinks — returned for a search for *Oikos*. They are not near-misses; they
 * are paid placements with no relationship to the query.
 *
 * They are kept rather than dropped, because a sponsored listing is still a
 * real product at a real price and occasionally is the thing you searched for.
 * But `isSponsored` is carried through so ranking never treats position as
 * relevance — position here was bought. The matcher rejects them on brand and
 * name anyway; this is the second line of defence, not the first.
 *
 * ---------------------------------------------------------------------------
 * 2. memberOnlyPrice IS NOT A PRICE YOU CAN PAY
 * ---------------------------------------------------------------------------
 * It requires a loyalty account and, on some offers, having loaded the offer
 * beforehand. Presenting it as the shelf price would produce a saving that
 * evaporates at the till — the precise humiliation this app exists to prevent.
 * Only `pricing.price` is ever used. The member price is recorded so the UI can
 * mention it, never so it can be compared against.
 *
 * ---------------------------------------------------------------------------
 * 3. packageSizing CARRIES TWO FACTS
 * ---------------------------------------------------------------------------
 * "200 ml, $0.50/100ml" is the size AND the unit price. Only the part before
 * the comma is a size; feeding the whole string to the size parser would give
 * it a dollar figure to interpret.
 */

import { parseSize } from "@/services/products/normalize";
import type { Availability } from "@/types";

export interface LoblawSearchResult {
  /** e.g. "21757962_EA". */
  productId: string;
  articleNumber: string;
  title: string;
  brand: string | null;
  /** Size as printed, e.g. "200 ml". Null when it does not parse as one. */
  size: string | null;
  /** The price anyone can pay, in cents. */
  priceCents: number;
  /** Struck-through price when on sale, in cents. */
  regularPriceCents: number | null;
  /**
   * Loyalty-gated price, in cents. Recorded, never compared against — see the
   * header. Null when there is none.
   */
  memberOnlyPriceCents: number | null;
  availability: Availability;
  /** Absolute product URL. */
  url: string;
  /** True when this placement was paid for. Never let it imply relevance. */
  isSponsored: boolean;
}

/**
 * @param item one element of the search results array.
 * @param origin banner origin, e.g. "https://www.maxi.ca" — the `link` field is
 *   relative, and the same JSON shape serves every Loblaw banner.
 */
export function parseLoblawSearchResult(
  item: unknown,
  origin: string,
): LoblawSearchResult | null {
  if (typeof item !== "object" || item === null) return null;
  const node = item as Record<string, unknown>;

  const productId = str(node.productId);
  const title = str(node.title);
  const link = str(node.link);
  if (!productId || !title || !link) return null;

  const pricing =
    typeof node.pricing === "object" && node.pricing !== null
      ? (node.pricing as Record<string, unknown>)
      : null;
  if (!pricing) return null;

  const priceCents = decimalToCents(pricing.price);
  // A result with no readable price is not a candidate. Dropping it is correct:
  // the alternative is a comparison row with a blank where the number goes.
  if (priceCents === null) return null;

  return {
    productId,
    articleNumber: str(node.articleNumber) || productId.split("_")[0]!,
    title,
    brand: str(node.brand) || null,
    size: readSize(str(node.packageSizing)),
    priceCents,
    regularPriceCents: decimalToCents(pricing.wasPrice),
    memberOnlyPriceCents: decimalToCents(pricing.memberOnlyPrice),
    availability: readAvailability(node.inventoryIndicator),
    url: absoluteUrl(origin, link),
    isSponsored: node.isSponsored === true,
  };
}

export function parseLoblawSearchResults(
  items: unknown,
  origin: string,
): LoblawSearchResult[] {
  if (!Array.isArray(items)) return [];
  const out: LoblawSearchResult[] = [];
  for (const item of items) {
    const parsed = parseLoblawSearchResult(item, origin);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * "200 ml, $0.50/100ml" -> "200 ml".
 *
 * The comma split is the whole job: everything after it is a unit price, and
 * the size parser would happily try to read "$0.50/100ml" as a quantity.
 */
function readSize(packageSizing: string): string | null {
  if (!packageSizing) return null;
  const candidate = packageSizing.split(",")[0]!.trim();
  if (!candidate) return null;
  // Confirm it is actually a size. Some products carry text here instead.
  return parseSize(candidate).size ? candidate : null;
}

/**
 * Loblaw sends prices as decimal strings ("1.00", "7.49").
 *
 * Strict on purpose. This is machine-generated JSON, so anything that is not a
 * plain decimal means the field holds something other than a simple price — a
 * range, a "2 for" offer, a currency symbol — and guessing at those produces a
 * number that is wrong rather than absent.
 */
function decimalToCents(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(value * 100);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

/**
 * `inventoryIndicator` is null for a normally-stocked item, and an object with
 * an `indicatorId` when there is something to say. Only values that have been
 * observed are mapped; anything else is UNKNOWN rather than assumed available.
 */
function readAvailability(value: unknown): Availability {
  if (value === null || value === undefined) return "IN_STOCK";
  if (typeof value !== "object") return "UNKNOWN";
  const id = str((value as Record<string, unknown>).indicatorId).toUpperCase();
  if (id === "LOW") return "IN_STOCK"; // Low stock is still stock.
  if (id === "OUT_OF_STOCK" || id === "OUT") return "OUT_OF_STOCK";
  return "UNKNOWN";
}

function absoluteUrl(origin: string, link: string): string {
  const base = origin.replace(/\/+$/, "");
  return link.startsWith("http") ? link : `${base}${link.startsWith("/") ? "" : "/"}${link}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
