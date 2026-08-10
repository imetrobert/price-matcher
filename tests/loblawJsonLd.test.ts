/**
 * Loblaw product JSON-LD parsing, tested against a REAL capture.
 *
 * `src/fixtures/captures/maxi-product-21305945.jsonld.json` is a verbatim copy
 * of what maxi.ca served for one product at store 7495. Every other fixture in
 * this repository is invented; this one is the reason the parser can be trusted
 * at all, because it pins the code to a page that actually existed rather than
 * to an idea of what such a page looks like.
 */

import { describe, expect, it } from "vitest";

import capture from "@/fixtures/captures/maxi-product-21305945.jsonld.json";
import {
  findProductNode,
  parseSchemaOrgProduct,
} from "@/services/retailers/schemaOrg/product";

function parsed() {
  const outcome = parseSchemaOrgProduct(capture);
  if (!outcome.ok) throw new Error(`fixture failed to parse: ${outcome.reason}`);
  return outcome.product;
}

describe("the real maxi.ca capture", () => {
  it("reads the price as integer cents", () => {
    // 7.49 * 100 is 748.9999999999999 in IEEE-754. This is the boundary where
    // that has to stop mattering.
    expect(parsed().priceCents).toBe(749);
  });

  it("reads name, brand and article number", () => {
    const p = parsed();
    expect(p.name).toBe("Greek Yogurt, Plain, High Protein, 0% M.F.");
    expect(p.brand).toBe("Oikos");
    expect(p.retailerProductId).toBe("21305945_EA");
  });

  it("reads availability", () => {
    expect(parsed().availability).toBe("IN_STOCK");
  });

  it("strips tracking parameters from the URL shown as proof", () => {
    expect(parsed().url).toBe(
      "https://www.maxi.ca/en/greek-yogurt-plain-high-protein-0-m-f/p/21305945_EA",
    );
  });
});

describe("what this source cannot provide", () => {
  it("never reports a GTIN, because the page carries none", () => {
    // sku is Loblaw's article number. Mapping it to a GTIN would let a
    // fabricated identifier reach a Level-1 "exact barcode match", which is the
    // worst failure this app can produce.
    expect(parsed().gtin).toBeNull();
  });

  it("never reports a size, even though the description mentions one", () => {
    // The description contains "Value-sized 650g tub" — and also "115 gram
    // serving" and "13g grams of protein". A regex would as happily return 115
    // g. A confidently wrong size is worse than no size, because the matcher
    // treats size as a hard blocker.
    expect(parsed().size).toBeNull();
    expect(String(capture.description)).toContain("650g");
    expect(String(capture.description)).toContain("115 gram");
  });
});

describe("picking the Product block out of a page", () => {
  it("ignores the WebSite and BreadcrumbList blocks", () => {
    const blocks = [
      { "@type": "WebSite", name: "maxi" },
      { "@type": "BreadCrumbList", itemListElement: [] },
      capture,
    ];
    expect(findProductNode(blocks)).toBe(capture);
  });

  it("returns null when a page has no Product block", () => {
    expect(findProductNode([{ "@type": "WebSite" }])).toBeNull();
  });

  it("refuses a non-Product node rather than half-reading it", () => {
    const outcome = parseSchemaOrgProduct({ "@type": "WebSite", name: "maxi" });
    expect(outcome.ok).toBe(false);
  });
});

describe("refusing to guess", () => {
  const base = capture as Record<string, unknown>;

  function withOffer(offer: unknown) {
    return { ...base, offers: offer };
  }

  it("rejects a price in a currency that is not CAD", () => {
    // A USD number treated as dollars understates every comparison, and the
    // error looks like a bargain rather than a bug.
    const outcome = parseSchemaOrgProduct(
      withOffer({ priceCurrency: "USD", price: 7.49, url: "https://x.test/p" }),
    );
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("USD");
  });

  it("rejects a price it cannot read unambiguously", () => {
    for (const price of ["2 for $5", "$7.49", "7,49", "", null, undefined]) {
      const outcome = parseSchemaOrgProduct(
        withOffer({ priceCurrency: "CAD", price, url: "https://x.test/p" }),
      );
      expect(outcome.ok, `price ${JSON.stringify(price)} must be refused`).toBe(
        false,
      );
    }
  });

  it("accepts a price given as a decimal string", () => {
    const outcome = parseSchemaOrgProduct(
      withOffer({ priceCurrency: "CAD", price: "7.49", url: "https://x.test/p" }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (outcome.ok) expect(outcome.product.priceCents).toBe(749);
  });

  it("reports UNKNOWN availability rather than assuming in stock", () => {
    const outcome = parseSchemaOrgProduct(
      withOffer({
        priceCurrency: "CAD",
        price: 7.49,
        url: "https://x.test/p",
        availability: "https://schema.org/SomethingNew",
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (outcome.ok) expect(outcome.product.availability).toBe("UNKNOWN");
  });

  it("refuses a product with no offers block at all", () => {
    const { offers: _omitted, ...noOffers } = base;
    const outcome = parseSchemaOrgProduct(noOffers);
    expect(outcome).toMatchObject({ ok: false });
  });
});
