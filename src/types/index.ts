/**
 * CartMatch domain types.
 *
 * Design rule that runs through this whole file: anything that could be
 * mistaken for a fact about the real world (a price, a URL, a product
 * identity) carries provenance with it — where it came from, when it was
 * observed, and how much we trust it. There is deliberately no type in this
 * file that lets you hold "a price" without also holding its source.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Currency amount in integer minor units (cents). Never a float. */
export type Cents = number;

export type CurrencyCode = "CAD";

// ---------------------------------------------------------------------------
// Retailers
// ---------------------------------------------------------------------------

export type RetailerId =
  | "maxi"
  | "walmart"
  | "superc"
  | "metro"
  | "iga"
  | "provigo"
  | "adonis";

/**
 * How much we trust a retailer's price data. These are NOT guesses — a
 * retailer stays at UNKNOWN until its adapter has actually been exercised
 * against the live site and the result recorded. See docs in
 * src/config/retailers.ts.
 */
export type PriceReliability = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface RetailerConfig {
  id: RetailerId;
  name: string;
  /** Public-facing name to show a cashier. */
  displayName: string;
  enabled: boolean;
  region: string;
  homepage: string;
  supportsProductPages: boolean;
  supportsOnlinePricing: boolean;
  supportsStoreContext: boolean;
  /** Evidence-based, not aspirational. UNKNOWN until measured. */
  priceReliability: PriceReliability;
  /** Why the reliability rating is what it is. Free text, shown in /admin. */
  reliabilityNote: string;
}

/**
 * A retailer's price-match / low-price policy. Every field must be traceable
 * to a published source; `sourceUrl` is required and `lastReviewed` records
 * when a human last checked it. An unreviewed policy is treated as unknown.
 */
export interface RetailerPolicy {
  retailerId: RetailerId;
  /** Does the retailer publish a competitor price-match program? */
  priceMatchSupported: boolean | "UNKNOWN";
  /** Some Quebec banners run a "verified price"/scanner-accuracy program. */
  verifiedPriceProgram: boolean | "UNKNOWN";
  requiresExactProduct: boolean | "UNKNOWN";
  proofRequired: boolean | "UNKNOWN";
  localPromotionRules: string;
  notes: string;
  /** URL of the published policy. Empty string = we have no source. */
  sourceUrl: string;
  /** ISO date a human last verified `sourceUrl`. Empty = never verified. */
  lastReviewed: string;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export type UnitSystem = "MASS" | "VOLUME" | "COUNT";

/** A size normalized to a canonical base unit so 650 g and 0.65 kg compare. */
export interface NormalizedSize {
  system: UnitSystem;
  /** grams for MASS, millilitres for VOLUME, units for COUNT. */
  baseValue: number;
  /** As printed on the package, e.g. "650 g". */
  raw: string;
}

/** What the vision model claims it saw. Untrusted until confirmed. */
export interface DetectedProduct {
  id: string;
  brand: string | null;
  productName: string | null;
  variant: string | null;
  fatPercentage: string | null;
  size: string | null;
  /**
   * A size the model proposed because it could not read one.
   *
   * Never used by matching and never copied into `size` by the app. It is
   * shown as a suggestion with its basis, and becomes real only when a person
   * accepts it — at which point it is their reading, not the model's guess.
   */
  sizeGuess: string | null;
  /** How it arrived at the guess: partial_label, dimensions, typical. */
  sizeGuessBasis: string | null;
  packageQuantity: number | null;
  visibleUpc: string | null;
  language: string | null;
  manufacturer: string | null;
  productType: string | null;
  notes: string | null;
  /** Model's self-reported confidence, 0..1. */
  confidence: number;
  /** True when produced by the mock vision provider. */
  isMock: boolean;
  /** Set once a human has accepted or corrected the card. */
  userConfirmed: boolean;
}

/**
 * The identity we actually compare on. A CanonicalProduct is what "the same
 * product" means in this system.
 */
export interface CanonicalProduct {
  id: string;
  /** GTIN-14 normalized. null when we could not establish one. */
  gtin: string | null;
  brand: string;
  name: string;
  variant: string | null;
  fatPercentage: string | null;
  size: NormalizedSize | null;
  packageCount: number;
  /** Lowercased, punctuation-stripped tokens used by the matcher. */
  normalizedTokens: string[];
  /** How the identity was established, for the audit trail. */
  identitySource: IdentitySource;
}

export type IdentitySource =
  | "VISIBLE_BARCODE"
  | "RETAILER_PRODUCT_DATA"
  | "PRODUCT_DATABASE"
  | "ATTRIBUTE_SEARCH"
  | "USER_ENTERED"
  | "TEST_FIXTURE";

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export type MatchLevel =
  | "L1_GTIN"
  | "L2_RETAILER_ID"
  | "L3_ATTRIBUTES"
  | "L4_FUZZY"
  | "NO_MATCH";

export type MatchTier =
  | "EXACT_MATCH"
  | "HIGH_CONFIDENCE"
  | "REVIEW_REQUIRED"
  | "REJECTED";

export interface MatchResult {
  level: MatchLevel;
  /** 0..100, deterministic. See src/services/matching/scoring.ts. */
  score: number;
  tier: MatchTier;
  /** Human-readable reasons, shown in /admin and the proof screen. */
  reasons: string[];
  /** Hard disqualifiers (size mismatch, variant mismatch, ...). */
  blockers: string[];
  /** Only true for tiers allowed to back a checkout claim. */
  eligibleForCheckoutProof: boolean;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export type PriceSourceType =
  | "RETAILER_PRODUCT_PAGE"
  | "RETAILER_CATALOG"
  | "RETAILER_FLYER"
  | "RETAILER_API"
  | "AUTHORIZED_THIRD_PARTY"
  | "USER_ENTERED"
  | "MOCK_FIXTURE";

export type Availability =
  | "IN_STOCK"
  | "OUT_OF_STOCK"
  | "UNKNOWN"
  | "ONLINE_ONLY";

export type SourceReliability =
  | "VERIFIED"
  | "CONDITIONALLY_VERIFIED"
  | "STALE"
  | "UNVERIFIED";

export type CheckoutProofStatus =
  | "CHECKOUT_READY"
  | "VERIFICATION_REQUIRED"
  | "NOT_ELIGIBLE";

export type Freshness = "FRESH" | "ACCEPTABLE" | "STALE" | "EXPIRED";

/** Validity window for flyer / promotional pricing. */
export interface ValidityPeriod {
  startsAt: string | null;
  endsAt: string | null;
}

/**
 * One observation of one price, at one retailer, at one moment.
 *
 * There is no code path that constructs a PriceObservation without a
 * `sourceType` and `observedAt`. That is the whole point of the type.
 */
export interface PriceObservation {
  id: string;
  retailerId: RetailerId;
  storeId: string | null;
  postalCode: string | null;
  canonicalProductId: string;
  retailerProductId: string | null;
  productName: string;
  /** Direct product page URL. null when we could not verify one. */
  productUrl: string | null;
  price: Cents;
  regularPrice: Cents | null;
  salePrice: Cents | null;
  currency: CurrencyCode;
  availability: Availability;
  observedAt: string;
  sourceUrl: string | null;
  sourceType: PriceSourceType;
  /** 0..1 confidence that this price is currently correct. */
  priceConfidence: number;
  matchConfidence: number;
  checkoutProofStatus: CheckoutProofStatus;
  sourceReliability: SourceReliability;
  validity: ValidityPeriod | null;
  restrictions: string[];
  notes: string[];
  /** Opaque pointer to the captured evidence (raw HTML hash, fixture id). */
  rawSourceReference: string | null;
  /** True for fixture data. Mock rows can never be CHECKOUT_READY. */
  isMock: boolean;
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export type AdapterStatus = "AVAILABLE" | "UNAVAILABLE" | "MOCK_ONLY";

export interface AdapterHealth {
  retailerId: RetailerId;
  status: AdapterStatus;
  /** Why an adapter is unavailable — surfaced verbatim to the user. */
  reason: string;
  lastCheckedAt: string | null;
}

export interface StoreContext {
  retailerId: RetailerId;
  storeId: string | null;
  storeName: string | null;
  postalCode: string;
  capturedAt: string;
}

export interface ProductSearchCandidate {
  retailerId: RetailerId;
  retailerProductId: string | null;
  title: string;
  url: string | null;
  /** Parsed from the candidate listing; must still be page-verified. */
  rawSize: string | null;
  rawBrand: string | null;
  isMock: boolean;
}

/**
 * Every adapter method returns this envelope. `ok: false` is a first-class,
 * expected outcome — a blocked or broken retailer degrades that retailer only.
 */
export type AdapterResult<T> =
  | { ok: true; data: T; warnings: string[] }
  | { ok: false; error: AdapterError };

export interface AdapterError {
  code:
    | "NETWORK_BLOCKED"
    | "NOT_IMPLEMENTED"
    | "PARSE_FAILED"
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "TIMEOUT"
    | "DISABLED"
    | "UNKNOWN";
  message: string;
  retailerId: RetailerId;
}

export interface RetailerAdapter {
  readonly retailerId: RetailerId;
  health(): Promise<AdapterHealth>;
  searchProduct(
    query: CanonicalProduct,
    ctx: StoreContext,
  ): Promise<AdapterResult<ProductSearchCandidate[]>>;
  getProduct(
    retailerProductId: string,
    ctx: StoreContext,
  ): Promise<AdapterResult<ProductSearchCandidate>>;
  /** Must fetch and parse the actual product page — never a search snippet. */
  getPrice(
    candidate: ProductSearchCandidate,
    canonical: CanonicalProduct,
    ctx: StoreContext,
  ): Promise<AdapterResult<PriceObservation>>;
  getPriceMatchPolicy(): RetailerPolicy;
}

// ---------------------------------------------------------------------------
// Comparison + results
// ---------------------------------------------------------------------------

export type OpportunityState =
  | "CHEAPER_ELSEWHERE"
  | "POTENTIAL_PRICE_MATCH"
  | "CHECKOUT_READY_PROOF";

export interface SavingsOpportunity {
  id: string;
  canonical: CanonicalProduct;
  currentStore: PriceObservation;
  competitor: PriceObservation;
  match: MatchResult;
  savingsCents: Cents;
  state: OpportunityState;
  competitorFreshness: Freshness;
  /** True only when every gate passed. Drives Checkout Mode inclusion. */
  checkoutReady: boolean;
  /** Ordered, human-readable gate results for the proof screen. */
  proofPoints: ProofPoint[];
  /** Why this row is being shown at all — audit trail. */
  displayReason: string;
  isMock: boolean;
}

export interface ProofPoint {
  label: string;
  passed: boolean;
  detail: string;
}

/** A cart item that could not be turned into a displayable opportunity. */
export interface UnverifiedItem {
  canonical: CanonicalProduct | null;
  detected: DetectedProduct | null;
  reason: string;
  detail: string;
}

export interface PipelineResult {
  runId: string;
  createdAt: string;
  storeContext: StoreContext;
  thresholdCents: Cents;
  opportunities: SavingsOpportunity[];
  unverified: UnverifiedItem[];
  totalSavingsCents: Cents;
  qualifyingCount: number;
  adapterHealth: AdapterHealth[];
  dataMode: DataMode;
  /** True if ANY row in the result set came from fixtures. */
  containsMockData: boolean;
}

export type DataMode = "LIVE" | "MOCK";

// ---------------------------------------------------------------------------
// User preferences (stored client-side only)
// ---------------------------------------------------------------------------

export interface UserPreferences {
  postalCode: string;
  language: "en" | "fr";
  minSavingsCents: Cents;
  currentRetailerId: RetailerId | null;
  currentStoreId: string | null;
  /**
   * Whether to keep a picture of each flyer page.
   *
   * The page image is the strongest thing to show a cashier, and it is the only
   * part of this app that consumes storage worth thinking about. Without it the
   * citation still works — every offer stores its page number, so "IGA flyer,
   * page 7, valid to Aug 19" survives — but the shopper has to open their own
   * copy of the flyer to show it.
   *
   * A choice rather than a policy, because the trade is somebody else's to
   * make: better evidence at the till, against a storage bill they may not want.
   */
  keepFlyerPages: boolean;
}

// ---------------------------------------------------------------------------
// Real-world validation feedback ("Verify This Match")
// ---------------------------------------------------------------------------

export interface MatchValidationReport {
  id: string;
  opportunityId: string;
  retailerId: RetailerId;
  competitorRetailerId: RetailerId;
  pageExisted: boolean | null;
  exactProductMatched: boolean | null;
  priceMatched: boolean | null;
  itemAvailable: boolean | null;
  cashierAcceptedPrice: boolean | null;
  priceMatchRequestAccepted: boolean | null;
  notes: string;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export interface AuditRecord {
  id: string;
  runId: string;
  createdAt: string;
  canonicalProductId: string;
  productLabel: string;
  currentRetailerId: RetailerId;
  competitorRetailerId: RetailerId | null;
  currentPriceCents: Cents | null;
  competitorPriceCents: Cents | null;
  savingsCents: Cents | null;
  matchLevel: MatchLevel;
  matchScore: number;
  gtin: string | null;
  priceConfidence: number;
  sourceUrl: string | null;
  observedAt: string | null;
  freshness: Freshness | null;
  checkoutProofStatus: CheckoutProofStatus;
  eligibility: OpportunityState | "EXCLUDED";
  reason: string;
  isMock: boolean;
}
