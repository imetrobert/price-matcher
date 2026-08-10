/**
 * IGA (Sobeys) product page.
 *
 * Verified against a real capture: iga.ca, Oikos 0% Greek yogurt, 2026-08-10.
 * See `src/fixtures/captures/`.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS DIFFERS FROM LOBLAW, AND WHY IT MATTERS
 * ---------------------------------------------------------------------------
 * The price comes from the same schema.org block, so that half is shared. Three
 * things are genuinely different:
 *
 *   SIZE IS IN THE NAME. "Oikos Fat-Free 0% Greek Yogurt High Protein Plain
 *   650 g" — no markup scraping needed, which makes IGA's size *more* reliable
 *   than Maxi's, where it comes from a CSS class that could be renamed.
 *
 *   NO ARTICLE NUMBER IN THE URL. Loblaw's paths end in `/p/21305945_EA`;
 *   IGA's are `/products/<slug>` and the slug is the site's own invention
 *   (note the double hyphen in "fat-free-0--greek"). A URL therefore cannot be
 *   constructed from product attributes — it has to come from a search result.
 *
 *   AVAILABILITY IS `InStoreOnly`. Handled in the shared parser: it means
 *   "shelf only, not orderable online", which for this app is exactly
 *   available.
 *
 * `sku` here is "598017", a Sobeys article number. Still not a barcode.
 *
 * ---------------------------------------------------------------------------
 * SEARCH CANNOT BE PARSED FROM THE PAGE — PROBED 2026-08-10
 * ---------------------------------------------------------------------------
 * The iga.ca search results page was probed and contains none of the three
 * places a result list could hide: one JSON-LD block with no Product node, no
 * `__NEXT_DATA__`, and no product markup. The results arrive by a separate
 * request after load, so there is nothing in the HTML to read.
 *
 * That is worse here than the same finding would be at Maxi, because IGA
 * product URLs are slugs the site invents and cannot be constructed from
 * attributes. Without search there is no way to *find* an IGA product — only
 * to read one whose URL is already known.
 *
 * Two ways forward, neither of them guesswork:
 *
 *   Capture the search API from a browser's network inspector, which needs a
 *   desktop. Then IGA works exactly like Maxi.
 *
 *   Or map products once and remember them. The matcher already has a Level 2
 *   for precisely this — "retailer product id already mapped to this canonical
 *   product" — so a URL confirmed once is authoritative afterwards, and for a
 *   household buying the same few dozen items that converges quickly. It is
 *   also more accurate than search, since a human confirmed the identity.
 *
 * Until one of those exists, this module can price an IGA product but cannot
 * discover one. Do not paper over that by constructing slugs from names.
 */

import { parseSize } from "@/services/products/normalize";
import {
  findProductNode,
  parseSchemaOrgProduct,
  type ParseOutcome,
  type SchemaOrgProduct,
} from "@/services/retailers/schemaOrg/product";

/**
 * Pulls every `application/ld+json` block out of a page.
 *
 * A malformed block is skipped rather than thrown: pages carry several, and one
 * broken block written by an analytics tag must not cost us the Product block
 * beside it.
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
      // Others may still be fine.
    }
  }
  return blocks;
}

/**
 * Reads a trailing package size off a product name.
 *
 * Anchored to the END of the string, and that anchor is the whole safety
 * argument. The captured name contains "0%" and the page contains protein and
 * sugar figures in grams; an unanchored search would have several candidates
 * and no way to choose. A size printed at the end is the retailer's own
 * convention, and when a name does not follow it this returns null rather than
 * reaching further into the string for something that looks close enough.
 *
 * Multi-packs are matched too ("4 x 100 g"), because the matcher counts those
 * separately and treating one as a single unit would compare a 4-pack against
 * a single tub.
 */
export function extractSizeFromName(name: string): string | null {
  const cleaned = name.replace(/\s+/g, " ").trim();

  const multi = cleaned.match(/(\d+\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l))$/i);
  const single = cleaned.match(/(\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l))$/i);
  const candidate = (multi?.[1] ?? single?.[1])?.trim();
  if (!candidate) return null;

  // Confirm it parses as a size, so a name ending in something like "5 L" of
  // marketing text still has to survive the same check as everything else.
  return parseSize(candidate).size ? candidate : null;
}

export function parseIgaProductPage(html: string): ParseOutcome {
  const node = findProductNode(extractJsonLdBlocks(html));
  if (!node) {
    return {
      ok: false,
      reason:
        "No schema.org Product block on the page. Either this is not a product page, or the page did not load — a bot challenge returns HTML with no product data rather than an error status.",
    };
  }

  const outcome = parseSchemaOrgProduct(node);
  if (!outcome.ok) return outcome;

  const product: SchemaOrgProduct = {
    ...outcome.product,
    size: extractSizeFromName(outcome.product.name),
  };
  return { ok: true, product };
}
