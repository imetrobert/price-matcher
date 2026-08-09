/**
 * Live retailer adapter scaffold.
 *
 * ---------------------------------------------------------------------------
 * STATUS: INTERFACE ONLY — NO RETAILER PARSER IS IMPLEMENTED
 * ---------------------------------------------------------------------------
 * Two separate reasons, and both must be cleared before this can return a price.
 *
 * 1. NOTHING HAS EVER BEEN OBSERVED. The environment this was written in
 *    cannot reach any of the six retailer domains — the egress proxy answers
 *    403 to the CONNECT request for maxi.ca, superc.ca, walmart.ca, metro.ca,
 *    iga.net and provigo.ca. No search URL, no product URL pattern and no page
 *    structure has ever been seen. Selectors written against pages nobody has
 *    loaded would produce a scraper that looks finished and returns wrong
 *    prices, which is precisely the failure this project exists to prevent.
 *
 * 2. A BROWSER CANNOT DO THIS ANYWAY. The app is now a static site, so this
 *    code runs in the browser, where retailer requests are blocked by CORS.
 *    Retailers do not send Access-Control-Allow-Origin to arbitrary sites, and
 *    they are under no obligation to.
 *
 * ---------------------------------------------------------------------------
 * WHERE A REAL IMPLEMENTATION HAS TO LIVE
 * ---------------------------------------------------------------------------
 * In a Supabase Edge Function — `supabase/functions/retailer/` — for the same
 * reason the Gemini call moved there. A server-side fetch has no CORS
 * restriction, can hold credentials if a retailer ever requires them, and
 * keeps the parsing logic off the public bundle.
 *
 * The steps, once a retailer is reachable:
 *  1. Load the retailer's search page in a real browser; capture the search URL
 *     shape and whether results are server-rendered or fetched as JSON.
 *  2. Load a product page; capture the price selector and any JSON-LD offer
 *     block, which is usually more stable than CSS selectors.
 *  3. Extract price, availability and — if the page exposes it — the GTIN. A
 *     GTIN on the page upgrades the match from attribute-level to Level 1.
 *  4. Confirm the store-context behaviour. Most Quebec banners scope price to a
 *     selected store via a cookie or a path segment. Until that is confirmed, a
 *     parsed price must be recorded as CONDITIONALLY_VERIFIED with the
 *     "Montreal-area online price" restriction, never as the in-store price.
 *  5. Only after steps 1-4 run against live pages, update `priceReliability`
 *     in src/config/retailers.ts and record what was measured.
 *
 * Review the retailer's Terms of Service and robots.txt before enabling
 * automated fetching. If automated access is not permitted, the correct
 * outcome is to leave the adapter unavailable.
 */

import { getRetailer } from "@/config/retailers";
import { getPolicy } from "@/config/policies";
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
    return {
      retailerId: this.retailerId,
      status: "UNAVAILABLE",
      reason: `${config.displayName} price lookup is not implemented. It requires a Supabase Edge Function to fetch retailer pages — a browser cannot, because of CORS — and no page parser has been written or validated. See src/services/retailers/liveAdapter.ts.`,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async searchProduct(
    _query: CanonicalProduct,
    _ctx: StoreContext,
  ): Promise<AdapterResult<ProductSearchCandidate[]>> {
    return this.notImplemented(
      "product search (no verified search URL or result structure, and browser requests to retailers are blocked by CORS)",
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
