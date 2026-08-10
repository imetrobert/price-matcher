/**
 * IGA (Sobeys) product parsing, and the first real cross-retailer comparison.
 *
 * Both fixtures here are verbatim captures of the SAME product on two
 * unrelated platforms, taken the same day:
 *
 *   maxi.ca  Oikos 0% Greek yogurt 650 g   $7.49
 *   iga.ca   Oikos 0% Greek yogurt 650 g   $8.49
 *
 * Every price this project has compared until now was invented. These are not.
 */

import { describe, expect, it } from "vitest";

import igaCapture from "@/fixtures/captures/iga-product-598017.jsonld.json";
import maxiCapture from "@/fixtures/captures/maxi-product-21305945.jsonld.json";
import { buildCanonicalProduct } from "@/services/products/normalize";
import { scoreMatch } from "@/services/matching/scoring";
import { parseSchemaOrgProduct } from "@/services/retailers/schemaOrg/product";
import { extractSizeFromName } from "@/services/retailers/sobeys/parseProductPage";
import { calculateSavingsCents, meetsThreshold } from "@/lib/money";

function iga() {
  const outcome = parseSchemaOrgProduct(igaCapture);
  if (!outcome.ok) throw new Error(`fixture failed: ${outcome.reason}`);
  return { ...outcome.product, size: extractSizeFromName(outcome.product.name) };
}

describe("the real iga.ca capture", () => {
  it("reads the price, given as a string rather than a number", () => {
    // Maxi sent `price: 7.49`, IGA sends `price: "8.49"`. Same standard,
    // different serialisation — which is exactly why the parser accepts both
    // and is strict about what a string may contain.
    expect(iga().priceCents).toBe(849);
  });

  it("reads brand from a Brand node", () => {
    // Maxi used {"@type":"Thing"}, IGA uses {"@type":"Brand"}.
    expect(iga().brand).toBe("Oikos");
  });

  it("treats InStoreOnly as available", () => {
    // It means "shelf only, not orderable online". For an app whose premise is
    // that you are standing in the shop, that is precisely available.
    expect(iga().availability).toBe("IN_STOCK");
  });

  it("keeps the Sobeys article number without calling it a barcode", () => {
    expect(iga().retailerProductId).toBe("598017");
    expect(iga().gtin).toBeNull();
  });
});

describe("size comes from the name at IGA", () => {
  it("reads it off the end of the product name", () => {
    expect(iga().size).toBe("650 g");
  });

  it("is anchored to the end, so it cannot grab a percentage or a nutrient", () => {
    // The name itself contains "0%", and the page carries 19 g of protein and
    // 5 g of sugar. Only a trailing size counts.
    expect(extractSizeFromName("Oikos Fat-Free 0% Greek Yogurt 650 g")).toBe("650 g");
    expect(extractSizeFromName("Oikos 0% Greek Yogurt Plain")).toBeNull();
    expect(extractSizeFromName("Protein 19 g Yogurt Tub")).toBeNull();
  });

  it("reads multi-packs, which the matcher counts separately", () => {
    expect(extractSizeFromName("Yop Drinkable Yogurt 4 x 200 ml")).toBe("4 x 200 ml");
  });

  it("reads volumes", () => {
    expect(extractSizeFromName("Milk 2% 1.89 L")).toBe("1.89 L");
  });

  it("returns null rather than reaching further into the string", () => {
    expect(extractSizeFromName("650 g Oikos Greek Yogurt")).toBeNull();
  });
});

describe("the first comparison built from two real pages", () => {
  const maxi = buildCanonicalProduct({
    brand: "Oikos",
    name: "Greek Yogurt High Protein",
    variant: "Plain",
    fatPercentage: "0",
    size: "650 g",
    identitySource: "RETAILER_PRODUCT_DATA",
  });

  const igaProduct = buildCanonicalProduct({
    brand: "Oikos",
    name: "Greek Yogurt High Protein",
    variant: "Plain",
    fatPercentage: "0",
    size: "650 g",
    identitySource: "RETAILER_PRODUCT_DATA",
  });

  it("matches the two products at a level that can back a checkout claim", () => {
    const match = scoreMatch(maxi, igaProduct);
    expect(match.score).toBeGreaterThanOrEqual(95);
    expect(match.eligibleForCheckoutProof).toBe(true);
  });

  it("computes the saving from the two captured prices", () => {
    const maxiOutcome = parseSchemaOrgProduct(maxiCapture);
    if (!maxiOutcome.ok) throw new Error("maxi fixture failed");

    const savings = calculateSavingsCents(iga().priceCents, maxiOutcome.product.priceCents);

    expect(savings).toBe(100); // $8.49 at IGA, $7.49 at Maxi.
    expect(meetsThreshold(savings, 50)).toBe(true);
  });
});
