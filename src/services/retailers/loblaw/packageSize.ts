/**
 * Extracts the package size from a Loblaw product page's HTML.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCRAPE AND THE PRICE IS NOT
 * ---------------------------------------------------------------------------
 * The price comes from JSON-LD, which is a published contract the retailer has
 * a business reason to keep stable. The size is not in that block — it appears
 * only in the markup — so this reads a CSS class, with all the fragility that
 * implies. A redesign can rename the class and this stops working.
 *
 * That is accepted deliberately, because the alternative is worse. Without a
 * size the matcher cannot reach Level 3, so no Loblaw price can ever back a
 * checkout claim; a size read from a class that might change is a real answer
 * that fails visibly, and no size at all is a permanent ceiling.
 *
 * The failure mode is what makes it acceptable: when the class disappears this
 * returns null, and null means "unknown size", which the matcher already
 * handles by refusing to promote the match. It degrades to exactly where the
 * app was before this file existed. It never degrades to a wrong size.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT SIMPLY LOOK FOR "650 g" IN THE PAGE
 * ---------------------------------------------------------------------------
 * Because a product page is full of numbers followed by "g". The nutrition
 * table on this very product carries 0.0 g, 6 g, 5 g, 0 g and 19 g. A general
 * search would return whichever came first in the document — a fat or protein
 * figure presented as a package size, which is a hard blocker in the matcher
 * and would silently hide every genuine saving on the item.
 *
 * So: one specific class, then a format check. Both must pass.
 *
 * Verified against maxi.ca, product 21305945_EA, 2026-08-10:
 *   <span class="product-name__item product-name__item--package-size">650 g</span>
 */

import { parseSize } from "@/services/products/normalize";

/** The one class this is allowed to read. */
const SIZE_CLASS = "product-name__item--package-size";

/**
 * Matches an element carrying that class and captures its text.
 *
 * `[^<]` in the capture means the element must contain text and nothing else —
 * any nested markup and this declines rather than guessing at which part is the
 * size. The length cap keeps a malformed page from handing back a paragraph.
 */
const SIZE_ELEMENT = new RegExp(
  `<[a-z]+[^>]*class="[^"]*\\b${SIZE_CLASS}\\b[^"]*"[^>]*>([^<]{1,24})<`,
  "i",
);

/**
 * @returns the raw size string as printed ("650 g", "4 x 100 g"), or null when
 *   the page has no such element or its contents are not a size.
 */
export function extractPackageSize(html: string): string | null {
  const match = SIZE_ELEMENT.exec(html);
  if (!match) return null;

  const text = decodeEntities(match[1]!).trim();
  if (text === "") return null;

  // Second guard: the class said this is a size, so confirm it parses as one.
  // If the markup is reorganised such that this class lands on something else,
  // that change is caught here rather than propagating a nonsense size into a
  // product comparison.
  const parsed = parseSize(text);
  if (!parsed.size) return null;

  return text;
}

/** Only the entities that plausibly appear inside a size string. */
function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
}
