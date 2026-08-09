/**
 * Live retailer adapter scaffold.
 *
 * ---------------------------------------------------------------------------
 * STATUS: INTERFACE ONLY — NO RETAILER PARSER IS IMPLEMENTED
 * ---------------------------------------------------------------------------
 * This is deliberate, and it is the honest state of the integration.
 *
 * The development environment cannot reach any of the six retailer domains:
 * the egress proxy answers `403 Forbidden` to the CONNECT request for
 * www.maxi.ca, www.superc.ca, www.walmart.ca, www.metro.ca, www.iga.net and
 * www.provigo.ca. That means no search URL, no product-page URL pattern, and
 * no HTML structure has ever been observed. Writing selectors against pages
 * nobody has loaded would produce a parser that *looks* finished and returns
 * wrong data — precisely the failure mode the spec prohibits.
 *
 * So: `health()` performs a real reachability probe and reports what actually
 * happened, and every data method returns a typed error explaining what is
 * missing. Nothing is faked.
 *
 * ---------------------------------------------------------------------------
 * TO IMPLEMENT A RETAILER (once egress to that domain is permitted)
 * ---------------------------------------------------------------------------
 *  1. Load the retailer's search page in a real browser; capture the search
 *     URL shape and whether results are server-rendered or fetched via an
 *     internal JSON endpoint.
 *  2. Implement `buildSearchUrl` and `parseSearchResults` in a subclass.
 *  3. Load a product page; capture the price selector and any JSON-LD
 *     (`<script type="application/ld+json">`) offer block, which is usually
 *     more stable than CSS selectors.
 *  4. Implement `parseProductPage` returning price, availability, and — if the
 *     page exposes it — the GTIN. A GTIN on the page upgrades the match from
 *     attribute-level to Level 1.
 *  5. Verify the store-context behaviour: most Quebec banners scope price to a
 *     selected store via a cookie or a path segment. Until that is confirmed,
 *     a parsed price must be recorded as CONDITIONALLY_VERIFIED with the
 *     "Montreal-area online price" restriction, not as the in-store price.
 *  6. Only after steps 1-5 are exercised against live pages, update
 *     `priceReliability` in src/config/retailers.ts.
 *
 * Review the retailer's Terms of Service and robots.txt before enabling any
 * automated fetching. If automated access is not permitted, the correct
 * outcome is to leave the adapter unavailable.
 */

import "server-only";

import { getRetailer } from "@/config/retailers";
import { getPolicy } from "@/config/policies";
import { probeReachable } from "@/services/retailers/http";
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

export class LiveRetailerAdapter implements RetailerAdapter {
  readonly retailerId: RetailerId;

  constructor(retailerId: RetailerId) {
    this.retailerId = retailerId;
  }

  async health(): Promise<AdapterHealth> {
    const config = getRetailer(this.retailerId);
    const probe = await probeReachable(config.homepage, this.retailerId);

    if (!probe.reachable) {
      return {
        retailerId: this.retailerId,
        status: "UNAVAILABLE",
        reason: `${config.displayName} price service unavailable — ${probe.detail}`,
        lastCheckedAt: new Date().toISOString(),
      };
    }

    // Reachable, but there is still no parser. Say exactly that.
    return {
      retailerId: this.retailerId,
      status: "UNAVAILABLE",
      reason: `${config.displayName} is reachable, but no product-page parser has been implemented or validated for it yet. See src/services/retailers/liveAdapter.ts for the steps required.`,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async searchProduct(
    _query: CanonicalProduct,
    _ctx: StoreContext,
  ): Promise<AdapterResult<ProductSearchCandidate[]>> {
    return this.notImplemented(
      "product search (no verified search URL or result structure for this retailer)",
    );
  }

  async getProduct(
    _retailerProductId: string,
    _ctx: StoreContext,
  ): Promise<AdapterResult<ProductSearchCandidate>> {
    return this.notImplemented(
      "product lookup (no verified product URL pattern for this retailer)",
    );
  }

  async getPrice(
    _candidate: ProductSearchCandidate,
    _canonical: CanonicalProduct,
    _ctx: StoreContext,
  ): Promise<AdapterResult<PriceObservation>> {
    return this.notImplemented(
      "price extraction (no verified price selector for this retailer)",
    );
  }

  getPriceMatchPolicy(): RetailerPolicy {
    return getPolicy(this.retailerId);
  }

  private notImplemented<T>(what: string): AdapterResult<T> {
    const config = getRetailer(this.retailerId);
    return {
      ok: false,
      error: {
        code: "NOT_IMPLEMENTED",
        retailerId: this.retailerId,
        message: `${config.displayName}: ${what} is not implemented. CartMatch returns no price rather than an invented one.`,
      },
    };
  }
}
