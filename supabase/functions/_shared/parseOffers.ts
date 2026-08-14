/**
 * Turning what a model says it saw on a flyer page into candidate offers.
 *
 * ---------------------------------------------------------------------------
 * ONE COPY, TWO RUNTIMES
 * ---------------------------------------------------------------------------
 * This file is imported by the browser AND by the scheduled worker that reads
 * pages after the tab has closed. It deliberately imports nothing: no path
 * aliases, no framework types, nothing Deno and Next do not both have.
 *
 * That constraint is worth the awkwardness. These are the rules that decide
 * whether a number reaches a cashier, and a second implementation of them —
 * drifting quietly, in a file nobody looks at — is the most dangerous thing
 * this project could contain.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL TRANSCRIBES. THIS FILE DOES THE ARITHMETIC.
 * ---------------------------------------------------------------------------
 * A flyer sets the dollars enormous and the cents as a raised superscript;
 * there is often no decimal point printed at all, and Quebec flyers that print
 * one use a comma. So the model is asked for the two numerals it can literally
 * see, and the cents are assembled here.
 *
 * "4 with a small 99" rendered as a single number could plausibly come back as
 * 4.99, 499, 4,99 or 4 99, and one of those is a hundredfold error in a figure
 * shown to a cashier. Removing the decision removes the failure.
 *
 * ---------------------------------------------------------------------------
 * EVERY REJECTION HERE IS DELIBERATE
 * ---------------------------------------------------------------------------
 * Anything malformed is dropped with a reason rather than repaired, because
 * repairing a price means inventing one. A page that yields eight good offers
 * and two rejects is a good page; a parser that yields ten by guessing is not.
 */

export type PriceBasis =
  | "PER_ITEM"
  | "PER_LB"
  | "PER_KG"
  | "PER_100G"
  | "PER_100ML";

export type OfferCondition =
  | "UNIT_PRICE"
  | "MULTI_BUY"
  | "LOYALTY_ONLY"
  | "LIMIT_APPLIES"
  | "WITH_PURCHASE";

/** Integer cents. Never a float: 7.49 * 100 is 748.9999999999999. */
export type Cents = number;

export interface ExtractedOffer {
  advertisedText: string;
  brand: string | null;
  size: string | null;
  retailerSku: string | null;
  price: Cents;
  currency: "CAD";
  basis: PriceBasis;
  regularPrice: Cents | null;
  regularBasis: PriceBasis | null;
  condition: OfferCondition;
  conditionText: string | null;
  pageNumber: number;
}

const BASES: readonly PriceBasis[] = [
  "PER_ITEM",
  "PER_LB",
  "PER_KG",
  "PER_100G",
  "PER_100ML",
];

const CONDITIONS: readonly OfferCondition[] = [
  "UNIT_PRICE",
  "MULTI_BUY",
  "LOYALTY_ONLY",
  "LIMIT_APPLIES",
  "WITH_PURCHASE",
];

/**
 * Above this, the reading is not a grocery price.
 *
 * A flyer tile does not advertise a thousand dollars, so a four-figure result
 * is a misread — most likely a phone number, an article number, or dollars and
 * cents run together. Cheap to check, and it catches the one error class that
 * would otherwise be spectacular.
 */
const MAX_PLAUSIBLE_CENTS = 100_000;

export interface ParsedExtraction {
  offers: ExtractedOffer[];
  /** One line per dropped offer, saying what was wrong. Shown, not swallowed. */
  rejected: string[];
  /**
   * The store name the model saw branded on the page, verbatim.
   *
   * Not mapped to a RetailerId here. This is a reading of a logo, and turning
   * "Super C" into an id is a decision about which retailer's prices these
   * are — which belongs where a person can see and override it.
   */
  retailerName: string | null;
  /**
   * The run dates printed on the page, as YYYY-MM-DD.
   *
   * Kept only when they parse as a real date. A model asked for a date will
   * produce something date-shaped whatever it saw, and a flyer's window is the
   * one field a cashier checks first — so a malformed answer is dropped rather
   * than repaired into a plausible one.
   */
  validFrom: string | null;
  validTo: string | null;
}

/** YYYY-MM-DD, and a date that exists. Anything else is not a date. */
function readIsoDate(value: unknown): string | null {
  const text = readString(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const roundTrips =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m! - 1 &&
    date.getUTCDate() === d;
  return roundTrips ? text : null;
}

/**
 * Parse one page's worth of model output.
 *
 * `pageNumber` is supplied by the caller rather than asked of the model: the
 * app knows which page it sent, and a page number is exactly the kind of fact
 * a model will helpfully invent.
 */
export function parseFlyerExtraction(
  raw: unknown,
  pageNumber: number,
): ParsedExtraction {
  const offers: ExtractedOffer[] = [];
  const rejected: string[] = [];

  const row =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const retailerName = readString(row.retailerName);
  const validFrom = readIsoDate(row.validFrom);
  const validTo = readIsoDate(row.validTo);
  // A window that runs backwards was misread, and half a window cannot be
  // shown as one. Both or neither.
  const windowOk = validFrom !== null && validTo !== null && validFrom <= validTo;

  const list = readArray(raw, "offers");
  if (list === null) {
    return {
      offers,
      rejected: ["The reply contained no list of offers."],
      retailerName,
      validFrom: windowOk ? validFrom : null,
      validTo: windowOk ? validTo : null,
    };
  }

  for (const [index, item] of list.entries()) {
    const parsed = parseOne(item, pageNumber);
    if ("error" in parsed) {
      rejected.push(`Offer ${index + 1} on page ${pageNumber}: ${parsed.error}`);
      continue;
    }
    offers.push(parsed.offer);
  }

  return {
    offers,
    rejected,
    retailerName,
    validFrom: windowOk ? validFrom : null,
    validTo: windowOk ? validTo : null,
  };
}

type OneResult = { offer: ExtractedOffer } | { error: string };

function parseOne(item: unknown, pageNumber: number): OneResult {
  if (typeof item !== "object" || item === null) {
    return { error: "not an object." };
  }
  const row = item as Record<string, unknown>;

  const advertisedText = readString(row.advertisedText);
  if (!advertisedText) {
    return { error: "no product wording, so there is nothing to match against." };
  }

  const price = readMoney(row.priceDollars, row.priceCents);
  if (price === null) {
    return { error: `price could not be read as dollars and cents.` };
  }
  if (price > MAX_PLAUSIBLE_CENTS) {
    return { error: `price of ${price} cents is not a grocery price.` };
  }

  const basis = readEnum(row.basis, BASES);
  if (basis === null) {
    // Not defaulted to PER_ITEM. A missing unit is precisely the failure that
    // turns a price per pound into a comparable-looking number.
    return { error: "no price basis, so it cannot be known what the price is for." };
  }

  const condition = readEnum(row.condition, CONDITIONS);
  if (condition === null) {
    return { error: "no condition, so it cannot be known whether strings attach." };
  }

  const regularPrice = readMoney(row.regularDollars, row.regularCents);
  // Falls back to the sale price's basis only when the flyer printed no unit
  // for the regular price — which is the ordinary case for a per-item tile.
  // It is never assumed for a tile that printed one.
  const regularBasis = readEnum(row.regularBasis, BASES);

  return {
    offer: {
      advertisedText,
      brand: readString(row.brand),
      size: readString(row.size),
      // Digits only. "N° 51087737" and "51087737" are the same article number,
      // and storing the ornamentation makes two of them.
      retailerSku: readString(row.retailerSku)?.replace(/\D+/g, "") || null,
      price,
      currency: "CAD",
      basis,
      // A "regular" price at or below the sale price is a misread, not a
      // saving. Dropped rather than shown, since a struck-through price that is
      // lower than the one beside it is worse than none at all.
      // A "regular" price at or below the sale price is a misread — but only
      // when the two are measured the same way. Across different units the
      // comparison says nothing, so the guard is skipped rather than deciding
      // that $30.99 per kg is not above $6.49 per lb.
      regularPrice: keepRegular(price, basis, regularPrice, regularBasis)
        ? regularPrice
        : null,
      regularBasis: keepRegular(price, basis, regularPrice, regularBasis)
        ? (regularBasis ?? basis)
        : null,
      condition,
      conditionText: readString(row.conditionText),
      pageNumber,
    },
  };
}

/**
 * Is this regular price worth keeping?
 *
 * Same unit: it must be above the sale price, or it was misread — a
 * struck-through price lower than the one beside it is worse than none.
 *
 * Different unit: keep it. "$6.49 /lb, reg. $30.99 /kg" is exactly what the
 * flyer printed, and the units are carried so nothing subtracts them.
 */
function keepRegular(
  price: Cents,
  basis: PriceBasis,
  regularPrice: Cents | null,
  regularBasis: PriceBasis | null,
): boolean {
  if (regularPrice === null) return false;
  const sameUnit = regularBasis === null || regularBasis === basis;
  return sameUnit ? regularPrice > price : true;
}

/**
 * Two numerals into cents.
 *
 * Rejects rather than coerces: a non-integer, a negative, or cents outside
 * 0..99 means the reading was not what was asked for, and the safe response to
 * an unexpected shape is to decline it.
 */
function readMoney(dollars: unknown, cents: unknown): Cents | null {
  if (dollars === null || dollars === undefined) return null;
  if (cents === null || cents === undefined) return null;
  if (typeof dollars !== "number" || typeof cents !== "number") return null;
  if (!Number.isInteger(dollars) || !Number.isInteger(cents)) return null;
  if (dollars < 0 || cents < 0 || cents > 99) return null;
  return dollars * 100 + cents;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof value !== "string") return null;
  return allowed.includes(value as T) ? (value as T) : null;
}

function readArray(raw: unknown, key: string): unknown[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

// ===========================================================================
// SEVERAL PAGES IN ONE REPLY
// ===========================================================================

export interface ParsedBatch {
  /** One entry per page, keyed by the page number the caller sent. */
  byPage: Map<number, ParsedExtraction>;
  /**
   * Why the reply could not be trusted as a batch, or null. When set, nothing
   * in `byPage` should be used — the caller reads the pages singly instead.
   */
  error: string | null;
}

/**
 * Parse a reply covering several pages at once.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS STRICTER THAN THE SINGLE-PAGE PARSER
 * ---------------------------------------------------------------------------
 * The single-page parser never asks the model which page it read: the app knows
 * which page it sent, and a page number is exactly the kind of fact a model
 * will helpfully invent. Batching cannot keep that property outright — several
 * images go up together and their groups have to be told apart somehow.
 *
 * So the labels are checked rather than trusted. The reply must carry one group
 * per page sent, and the set of labels must be exactly the set of pages sent:
 * no page missing, no page twice, no page nobody asked for. Anything else and
 * the whole batch is refused.
 *
 * That is deliberately all-or-nothing. A partially aligned reply is the
 * dangerous case — offers landing under the wrong page number look completely
 * normal and produce a citation that sends somebody to a page that does not
 * carry the product. "IGA, page 7" has to mean page 7 or it is worse than
 * saying nothing, so a batch that cannot be aligned with certainty is discarded
 * and its pages are read one at a time.
 */
export function parseFlyerBatch(raw: unknown, pagesSent: number[]): ParsedBatch {
  const empty = new Map<number, ParsedExtraction>();

  const groups = readArray(raw, "pages");
  if (groups === null) {
    return { byPage: empty, error: "The reply contained no list of pages." };
  }
  if (groups.length !== pagesSent.length) {
    return {
      byPage: empty,
      error: `The reply covered ${groups.length} pages; ${pagesSent.length} were sent.`,
    };
  }

  const expected = new Set(pagesSent);
  const seen = new Set<number>();
  const byPage = new Map<number, ParsedExtraction>();

  for (const group of groups) {
    const row =
      typeof group === "object" && group !== null
        ? (group as Record<string, unknown>)
        : {};
    const label = row.pageNumber;
    if (typeof label !== "number" || !Number.isInteger(label)) {
      return { byPage: empty, error: "A page group carried no whole-number page label." };
    }
    if (!expected.has(label)) {
      return { byPage: empty, error: `The reply labelled a page ${label}, which was not sent.` };
    }
    if (seen.has(label)) {
      return { byPage: empty, error: `The reply labelled page ${label} twice.` };
    }
    seen.add(label);
    byPage.set(label, parseFlyerExtraction(row, label));
  }

  return { byPage, error: null };
}
