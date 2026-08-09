/**
 * MOCK PRICE FIXTURES — NOT REAL PRICES.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE USING ANY NUMBER IN THIS FILE
 * ---------------------------------------------------------------------------
 * Every amount below is INVENTED for UI development. None of it was observed
 * at any retailer. It exists so the screens can be built and the pipeline
 * exercised without live data.
 *
 * Three structural guards keep these numbers from ever masquerading as facts:
 *   1. `isMock: true` on every observation, propagated into the API response
 *      and rendered as a persistent banner in the UI.
 *   2. `sourceType: "MOCK_FIXTURE"`, which the eligibility engine treats as
 *      never checkout-ready (see services/policies/eligibility.ts).
 *   3. URLs use the reserved `.invalid` TLD, which by RFC 6761 can never
 *      resolve. A mock proof link cannot accidentally open a real page or be
 *      mistaken for a real product URL.
 *
 * Mock data is only used when CARTMATCH_DATA_MODE=MOCK. In LIVE mode this
 * file is never read.
 */

import type { Availability, Cents, RetailerId } from "@/types";

export interface MockPriceFixture {
  /** Key from src/fixtures/products.ts */
  productKey: string;
  retailerId: RetailerId;
  /** INVENTED. Not a real price. */
  priceCents: Cents;
  regularPriceCents: Cents | null;
  salePriceCents: Cents | null;
  availability: Availability;
  /** Reserved .invalid TLD — cannot resolve, cannot be mistaken for real. */
  productUrl: string;
  retailerProductId: string;
  /** Title as a retailer listing might render it — drives matcher testing. */
  listingTitle: string;
  /** Hours in the past this observation is pretended to have been made. */
  ageHours: number;
}

const url = (retailer: string, slug: string) =>
  `https://mock.invalid/${retailer}/product/${slug}`;

export const MOCK_PRICES: MockPriceFixture[] = [
  // --- Oikos Vanilla 650 g: the primary demo path -------------------------
  {
    productKey: "oikos-vanilla-650",
    retailerId: "maxi",
    priceCents: 749,
    regularPriceCents: 749,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("maxi", "oikos-greek-yogurt-vanilla-0-650g"),
    retailerProductId: "MOCK-MAXI-0001",
    listingTitle: "Oikos Greek Yogurt Vanilla 0% M.F. 650 g",
    ageHours: 2,
  },
  {
    productKey: "oikos-vanilla-650",
    retailerId: "superc",
    priceCents: 649,
    regularPriceCents: 749,
    salePriceCents: 649,
    availability: "IN_STOCK",
    productUrl: url("superc", "oikos-yogourt-grec-vanille-0-650g"),
    retailerProductId: "MOCK-SUPERC-0001",
    listingTitle: "Oikos Yogourt Grec Vanille 0 % M.G. 650 g",
    ageHours: 5,
  },
  {
    productKey: "oikos-vanilla-650",
    retailerId: "metro",
    priceCents: 699,
    regularPriceCents: 699,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("metro", "oikos-greek-yogurt-vanilla-650g"),
    retailerProductId: "MOCK-METRO-0001",
    listingTitle: "Oikos Greek Yogurt Vanilla 650 g",
    ageHours: 30, // ACCEPTABLE band, exercises the freshness logic
  },
  {
    productKey: "oikos-vanilla-650",
    retailerId: "iga",
    priceCents: 599,
    regularPriceCents: 599,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("iga", "oikos-yogourt-grec-vanille-650g"),
    retailerProductId: "MOCK-IGA-0001",
    listingTitle: "Oikos Yogourt Grec Vanille 650 g",
    ageHours: 96, // STALE — must be excluded from checkout-ready results
  },
  {
    // Wrong size at Walmart: the matcher must reject this outright rather
    // than reporting a large "saving" against a different product.
    productKey: "oikos-vanilla-750",
    retailerId: "walmart",
    priceCents: 629,
    regularPriceCents: 629,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("walmart", "oikos-greek-yogurt-vanilla-750g"),
    retailerProductId: "MOCK-WMT-0001",
    listingTitle: "Oikos Greek Yogurt Vanilla 750 g",
    ageHours: 3,
  },

  // --- Milk: fat percentage discrimination --------------------------------
  {
    productKey: "milk-2pct-2l",
    retailerId: "maxi",
    priceCents: 549,
    regularPriceCents: 549,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("maxi", "natrel-milk-2-2l"),
    retailerProductId: "MOCK-MAXI-0002",
    listingTitle: "Natrel Milk 2% 2 L",
    ageHours: 4,
  },
  {
    productKey: "milk-2pct-2l",
    retailerId: "provigo",
    priceCents: 519,
    regularPriceCents: 519,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("provigo", "natrel-lait-2-2l"),
    retailerProductId: "MOCK-PROVIGO-0002",
    listingTitle: "Natrel Lait 2 % 2 L",
    ageHours: 6,
  },

  // --- Coffee: a real saving that clears the default threshold ------------
  {
    productKey: "coffee-folgers-920",
    retailerId: "maxi",
    priceCents: 1499,
    regularPriceCents: 1499,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("maxi", "folgers-classic-roast-920g"),
    retailerProductId: "MOCK-MAXI-0003",
    listingTitle: "Folgers Ground Coffee Classic Roast 920 g",
    ageHours: 1,
  },
  {
    productKey: "coffee-folgers-920",
    retailerId: "superc",
    priceCents: 1249,
    regularPriceCents: 1499,
    salePriceCents: 1249,
    availability: "IN_STOCK",
    productUrl: url("superc", "folgers-cafe-moulu-920g"),
    retailerProductId: "MOCK-SUPERC-0003",
    listingTitle: "Folgers Café Moulu Classic Roast 920 g",
    ageHours: 8,
  },

  // --- Pasta: below-threshold saving, must be filtered out -----------------
  {
    productKey: "pasta-barilla-454",
    retailerId: "maxi",
    priceCents: 279,
    regularPriceCents: 279,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("maxi", "barilla-spaghetti-454g"),
    retailerProductId: "MOCK-MAXI-0004",
    listingTitle: "Barilla Spaghetti 454 g",
    ageHours: 2,
  },
  {
    productKey: "pasta-barilla-454",
    retailerId: "metro",
    priceCents: 270, // $0.09 cheaper — below the $0.50 default threshold
    regularPriceCents: 270,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("metro", "barilla-spaghetti-454g"),
    retailerProductId: "MOCK-METRO-0004",
    listingTitle: "Barilla Spaghetti 454 g",
    ageHours: 9,
  },

  // --- Crackers: out of stock at the competitor ---------------------------
  {
    productKey: "crackers-ritz-200",
    retailerId: "maxi",
    priceCents: 429,
    regularPriceCents: 429,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("maxi", "ritz-crackers-original-200g"),
    retailerProductId: "MOCK-MAXI-0005",
    listingTitle: "Ritz Crackers Original 200 g",
    ageHours: 3,
  },
  {
    productKey: "crackers-ritz-200",
    retailerId: "superc",
    priceCents: 329,
    regularPriceCents: 329,
    salePriceCents: null,
    availability: "OUT_OF_STOCK",
    productUrl: url("superc", "ritz-craquelins-original-200g"),
    retailerProductId: "MOCK-SUPERC-0005",
    listingTitle: "Ritz Craquelins Original 200 g",
    ageHours: 7,
  },

  // --- Paper towels: healthy multi-retailer spread -------------------------
  {
    productKey: "papertowel-bounty-6",
    retailerId: "maxi",
    priceCents: 1199,
    regularPriceCents: 1199,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("maxi", "bounty-select-a-size-6-rolls"),
    retailerProductId: "MOCK-MAXI-0006",
    listingTitle: "Bounty Paper Towels Select-A-Size 6 rolls",
    ageHours: 5,
  },
  {
    productKey: "papertowel-bounty-6",
    retailerId: "walmart",
    priceCents: 1047,
    regularPriceCents: 1047,
    salePriceCents: null,
    availability: "IN_STOCK",
    productUrl: url("walmart", "bounty-select-a-size-6-rolls"),
    retailerProductId: "MOCK-WMT-0006",
    listingTitle: "Bounty Paper Towels Select-A-Size 6 rolls",
    ageHours: 11,
  },
];

export function mockPricesFor(
  productKey: string,
  retailerId: RetailerId,
): MockPriceFixture[] {
  return MOCK_PRICES.filter(
    (p) => p.productKey === productKey && p.retailerId === retailerId,
  );
}

export function mockPricesAtRetailer(
  retailerId: RetailerId,
): MockPriceFixture[] {
  return MOCK_PRICES.filter((p) => p.retailerId === retailerId);
}
