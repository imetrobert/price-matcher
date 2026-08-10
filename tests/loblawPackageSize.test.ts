/**
 * Package-size extraction from Loblaw product markup.
 *
 * The element and its class were observed on maxi.ca product 21305945_EA:
 *
 *   SPAN class="product-name__item product-name__item--package-size" -> "650 g"
 *
 * The nutrition values below were observed on the same page, and they are the
 * reason this is class-targeted rather than a search for a number followed by a
 * unit. A protein figure read as a package size is a hard blocker in the
 * matcher — it would silently hide every real saving on the product.
 */

import { describe, expect, it } from "vitest";

import capture from "@/fixtures/captures/maxi-product-21305945.jsonld.json";
import { extractPackageSize } from "@/services/retailers/loblaw/packageSize";
import { parseLoblawProductPage } from "@/services/retailers/loblaw/parseProductPage";

/** Shaped like the real page: the size element, then the nutrition table. */
const PAGE = `
<div class="product-name">
  <h1 class="product-name__item product-name__item--name">Greek Yogurt, Plain, High Protein, 0% M.F.</h1>
  <span class="product-name__item product-name__item--package-size">650 g</span>
</div>
<table class="nutrient-per-serving">
  <tr><td>Fat</td><td><span class="nutrient-per-serving__label__value__gram">0.0 g</span></td></tr>
  <tr><td>Carbs</td><td><span class="nutrient-per-serving__label__value__gram">6 g</span></td></tr>
  <tr><td>Sugars</td><td><span class="nutrient-per-serving__label__value__gram">5 g</span></td></tr>
  <tr><td>Protein</td><td><span class="nutrient-per-serving__label__value__gram">19 g</span></td></tr>
</table>
`;

describe("the observed page", () => {
  it("returns the package size", () => {
    expect(extractPackageSize(PAGE)).toBe("650 g");
  });

  it("does not return a nutrition figure", () => {
    // The failure this whole approach exists to prevent. 19 g of protein
    // presented as a 19 g tub would block every match on the product.
    const size = extractPackageSize(PAGE);
    expect(size).not.toBe("19 g");
    expect(size).not.toBe("0.0 g");
  });
});

describe("when the markup changes", () => {
  it("returns null rather than guessing when the class is gone", () => {
    // The accepted failure mode: unknown size, which the matcher already
    // handles by refusing to promote the match. It degrades to where the app
    // was before this file existed — never to a wrong size.
    const renamed = PAGE.replace(/product-name__item--package-size/g, "pkg-size-v2");
    expect(extractPackageSize(renamed)).toBeNull();
  });

  it("declines when the element contains nested markup", () => {
    const nested = `<span class="product-name__item--package-size"><b>650</b> g</span>`;
    expect(extractPackageSize(nested)).toBeNull();
  });

  it("declines when the class holds something that is not a size", () => {
    const wrong = `<span class="product-name__item--package-size">Best seller</span>`;
    expect(extractPackageSize(wrong)).toBeNull();
  });

  it("is not fooled by a class that merely starts the same", () => {
    const similar = `<span class="product-name__item--package-size-label">Size</span>`;
    expect(extractPackageSize(similar)).toBeNull();
  });
});

describe("size formats that appear on real packaging", () => {
  function page(text: string) {
    return `<span class="product-name__item--package-size">${text}</span>`;
  }

  it("reads volumes", () => {
    expect(extractPackageSize(page("1.89 L"))).toBe("1.89 L");
    expect(extractPackageSize(page("750 mL"))).toBe("750 mL");
  });

  it("reads multi-packs, which the matcher counts separately", () => {
    expect(extractPackageSize(page("4 x 100 g"))).toBe("4 x 100 g");
  });

  it("handles a non-breaking space between number and unit", () => {
    expect(extractPackageSize(page("650&nbsp;g"))).toBe("650 g");
  });

  it("handles the element being on one line with other attributes", () => {
    const html = `<span data-testid="size" class="a product-name__item--package-size b" id="s">650 g</span>`;
    expect(extractPackageSize(html)).toBe("650 g");
  });
});

// ---------------------------------------------------------------------------
// The two sources combined
// ---------------------------------------------------------------------------


/** The real JSON-LD, in a page shaped like the one it came from. */
const FULL_PAGE = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"maxi"}</script>
<script type="application/ld+json">${JSON.stringify(capture)}</script>
<script type="application/ld+json">{ this is not valid json }</script>
</head><body>${PAGE}</body></html>`;

describe("a whole product page", () => {
  it("combines the JSON-LD price with the size from the markup", () => {
    const outcome = parseLoblawProductPage(FULL_PAGE);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.product.priceCents).toBe(749);
    expect(outcome.product.size).toBe("650 g");
    expect(outcome.product.brand).toBe("Oikos");
  });

  it("survives a malformed JSON-LD block sitting beside the good one", () => {
    // Analytics tags inject their own blocks. One bad block must not cost us
    // the Product block next to it.
    expect(parseLoblawProductPage(FULL_PAGE).ok).toBe(true);
  });

  it("still returns the price when the size class has been renamed", () => {
    // The whole point of keeping the two sources apart: a markup change costs
    // the size, never the price.
    const renamed = FULL_PAGE.replace(
      /product-name__item--package-size/g,
      "pkg-size-v2",
    );
    const outcome = parseLoblawProductPage(renamed);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.product.priceCents).toBe(749);
    expect(outcome.product.size).toBeNull();
  });

  it("explains itself when the page carries no product data", () => {
    // What a bot challenge looks like: HTTP 200, real HTML, no product.
    const outcome = parseLoblawProductPage(
      "<html><body><h1>Verifying you are human</h1></body></html>",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/bot challenge/i);
  });
});
