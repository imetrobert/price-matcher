/**
 * Fixture-backed adapter used only when NEXT_PUBLIC_CARTMATCH_DATA_MODE=MOCK.
 *
 * It behaves exactly like a real adapter — same interface, same match gauntlet,
 * same freshness maths — so the pipeline and UI can be developed and tested
 * end to end. The one difference is that every observation it emits is stamped
 * `isMock: true` with `sourceType: "MOCK_FIXTURE"`, which the eligibility
 * engine refuses to promote to CHECKOUT_READY.
 */

import { getPolicy } from "@/config/policies";
import { getRetailer } from "@/config/retailers";
import { MOCK_PRICES, type MockPriceFixture } from "@/fixtures/mockPrices";
import { PRODUCT_FIXTURES, getFixture } from "@/fixtures/products";
import { scoreMatch } from "@/services/matching/scoring";
import { buildCanonicalProduct } from "@/services/products/normalize";
import type {
  AdapterHealth,
  AdapterResult,
  CanonicalProduct,
  PriceObservation,
  ProductSearchCandidate,
  RetailerAdapter,
  RetailerId,
  RetailerPolicy,
  StoreContext,
} from "@/types";

export class MockRetailerAdapter implements RetailerAdapter {
  readonly retailerId: RetailerId;

  constructor(retailerId: RetailerId) {
    this.retailerId = retailerId;
  }

  async health(): Promise<AdapterHealth> {
    const config = getRetailer(this.retailerId);
    return {
      retailerId: this.retailerId,
      status: "MOCK_ONLY",
      reason: `${config.displayName}: serving FIXTURE data (NEXT_PUBLIC_CARTMATCH_DATA_MODE=MOCK). These prices are invented and can never be used as checkout proof.`,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async searchProduct(
    query: CanonicalProduct,
    _ctx: StoreContext,
  ): Promise<AdapterResult<ProductSearchCandidate[]>> {
    const rows = MOCK_PRICES.filter((p) => p.retailerId === this.retailerId);
    const candidates: ProductSearchCandidate[] = [];

    for (const row of rows) {
      const fixture = getFixture(row.productKey);
      if (!fixture) continue;
      // Only surface rows plausibly related to the query, mimicking a real
      // search engine returning near misses that the matcher must reject.
      if (!looselyRelated(query, fixture.brand, fixture.name)) continue;
      candidates.push({
        retailerId: this.retailerId,
        retailerProductId: row.retailerProductId,
        title: row.listingTitle,
        url: row.productUrl,
        rawSize: fixture.size ?? null,
        rawBrand: fixture.brand,
        isMock: true,
      });
    }

    return { ok: true, data: candidates, warnings: ["MOCK DATA"] };
  }

  async getProduct(
    retailerProductId: string,
    _ctx: StoreContext,
  ): Promise<AdapterResult<ProductSearchCandidate>> {
    const row = MOCK_PRICES.find(
      (p) =>
        p.retailerProductId === retailerProductId &&
        p.retailerId === this.retailerId,
    );
    if (!row) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          retailerId: this.retailerId,
          message: `No fixture with id ${retailerProductId}.`,
        },
      };
    }
    const fixture = getFixture(row.productKey);
    return {
      ok: true,
      warnings: ["MOCK DATA"],
      data: {
        retailerId: this.retailerId,
        retailerProductId: row.retailerProductId,
        title: row.listingTitle,
        url: row.productUrl,
        rawSize: fixture?.size ?? null,
        rawBrand: fixture?.brand ?? null,
        isMock: true,
      },
    };
  }

  async getPrice(
    candidate: ProductSearchCandidate,
    canonical: CanonicalProduct,
    ctx: StoreContext,
  ): Promise<AdapterResult<PriceObservation>> {
    const row = MOCK_PRICES.find(
      (p) =>
        p.retailerProductId === candidate.retailerProductId &&
        p.retailerId === this.retailerId,
    );
    if (!row) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          retailerId: this.retailerId,
          message: "No fixture price for that candidate.",
        },
      };
    }

    const observedAt = new Date(
      Date.now() - row.ageHours * 60 * 60 * 1000,
    ).toISOString();

    const observation: PriceObservation = {
      id: `mock-${row.retailerId}-${row.retailerProductId}-${row.productKey}`,
      retailerId: this.retailerId,
      storeId: ctx.storeId,
      postalCode: ctx.postalCode,
      canonicalProductId: canonical.id,
      retailerProductId: row.retailerProductId,
      productName: row.listingTitle,
      productUrl: row.productUrl,
      price: row.priceCents,
      regularPrice: row.regularPriceCents,
      salePrice: row.salePriceCents,
      currency: "CAD",
      availability: row.availability,
      observedAt,
      sourceUrl: row.productUrl,
      sourceType: "MOCK_FIXTURE",
      // Realistic confidence on purpose: mock mode exists so the whole
      // pipeline and UI can be exercised, and an artificially low confidence
      // would suppress every fixture row before it reached a screen. The guard
      // against a fixture being treated as real is `isMock` + MOCK_FIXTURE,
      // which force sourceReliability to UNVERIFIED and block CHECKOUT_READY
      // in services/policies/eligibility.ts — not a fudged number here.
      priceConfidence: 0.95,
      matchConfidence: 0,
      checkoutProofStatus: "NOT_ELIGIBLE",
      sourceReliability: "UNVERIFIED",
      validity: null,
      restrictions: ["MOCK DATA — not a real retailer price"],
      notes: [
        "Generated from src/fixtures/mockPrices.ts. This number was never observed at a retailer.",
      ],
      rawSourceReference: `fixture:${row.productKey}:${row.retailerId}`,
      isMock: true,
    };

    return { ok: true, data: observation, warnings: ["MOCK DATA"] };
  }

  getPriceMatchPolicy(): RetailerPolicy {
    return getPolicy(this.retailerId);
  }
}

/**
 * Cheap pre-filter that mimics a retailer search engine: brand OR a product
 * name token in common. Intentionally loose so that wrong sizes and wrong
 * variants DO come back and have to be rejected by the matcher.
 */
function looselyRelated(
  query: CanonicalProduct,
  brand: string,
  name: string,
): boolean {
  const qb = query.brand.toLowerCase();
  const qn = query.name.toLowerCase();
  if (brand.toLowerCase() === qb) return true;
  const nameTokens = name.toLowerCase().split(/\s+/);
  return nameTokens.some((t) => t.length > 3 && qn.includes(t));
}

/** Helper for the manual test harness: canonical form of every fixture. */
export function fixtureCanonicals(): CanonicalProduct[] {
  return PRODUCT_FIXTURES.map((f) => buildCanonicalProduct(f));
}

/** Exposed for tests: does the mock catalogue contain a genuine match? */
export function mockCatalogueHasMatch(
  query: CanonicalProduct,
  retailerId: RetailerId,
): MockPriceFixture | null {
  for (const row of MOCK_PRICES.filter((p) => p.retailerId === retailerId)) {
    const fixture = getFixture(row.productKey);
    if (!fixture) continue;
    const canonical = buildCanonicalProduct(fixture);
    if (scoreMatch(query, canonical).eligibleForCheckoutProof) return row;
  }
  return null;
}
