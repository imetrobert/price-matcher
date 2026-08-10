/**
 * A Loblaw product page read as one thing, from its two sources.
 *
 * Neither source is sufficient alone, and the split is not arbitrary — it is
 * the difference between a published contract and an implementation detail:
 *
 *   JSON-LD  price, currency, availability, brand, name, article number.
 *            Stable, because the retailer wants Google to keep reading it.
 *
 *   Markup   the package size, and nothing else. Fragile, because a class name
 *            is nobody's promise.
 *
 * Keeping them separate in code mirrors that: if a redesign breaks the class,
 * the price keeps working and only the size goes unknown. A single combined
 * scrape would have taken the price down with it.
 *
 * Verified against maxi.ca product 21305945_EA, store 7495, 2026-08-10.
 */

import { extractPackageSize } from "@/services/retailers/loblaw/packageSize";
import {
  findProductNode,
  parseLoblawProductJsonLd,
  type LoblawProduct,
  type ParseOutcome,
} from "@/services/retailers/loblaw/productJsonLd";

/**
 * Pulls every `application/ld+json` block out of a page.
 *
 * Blocks that are not valid JSON are skipped rather than throwing: a page
 * commonly carries several, and one malformed block written by an analytics
 * tag must not cost us the Product block sitting next to it.
 */
export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[1]!));
    } catch {
      // Malformed block; the others may still be fine.
    }
  }
  return blocks;
}

/**
 * @param html the full product page.
 * @returns the product, with `size` populated when the markup still carries it.
 */
export function parseLoblawProductPage(html: string): ParseOutcome {
  const node = findProductNode(extractJsonLdBlocks(html));
  if (!node) {
    return {
      ok: false,
      reason:
        "No schema.org Product block on the page. Either this is not a product page, or the page did not load — a bot challenge returns HTML with no product data rather than an error status.",
    };
  }

  const outcome = parseLoblawProductJsonLd(node);
  if (!outcome.ok) return outcome;

  // Size is additive. Failing to find it must never invalidate a price that
  // parsed correctly — it only means this observation cannot reach Level 3.
  const size = extractPackageSize(html);

  const product: LoblawProduct = { ...outcome.product, size };
  return { ok: true, product };
}
