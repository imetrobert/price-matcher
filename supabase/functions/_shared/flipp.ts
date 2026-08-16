/**
 * Turning a Flipp flyer item into an offer this app is willing to state.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING TO UNDERSTAND BEFORE CHANGING ANYTHING HERE
 * ---------------------------------------------------------------------------
 * A Flipp flyer item's `price` is AMBIGUOUS. It may be the price of one thing,
 * or the price of two. Measured against the same item in the search endpoint:
 *
 *   flyer endpoint : {"name":"BOISSON ... TROPICANA ...","price":"4.0",
 *                     "discount":19,"print_id":null,"text_areas":[]}
 *   search endpoint: {"current_price":4,"pre_price_text":"2/",
 *                     "post_price_text":"OU 2,49$/L'UNITÉ"}
 *
 * The real offer is TWO FOR $4 — $2.49 each. The flyer endpoint says "4.0" and
 * carries nothing that distinguishes that from "$4.00 each". Not the name, not
 * `discount` (19% is calculated on the multi-buy total, so it does not
 * disambiguate), not `text_areas` (coordinates only, no text). In one sample
 * search, two of seven items were multi-buys.
 *
 * So every offer from this source is emitted with condition UNKNOWN, and
 * UNKNOWN is never subtracted from anything. These offers exist to say "this
 * is on sale at Maxi, go and look" — which is true — and never to say "you
 * save $1.50", which would be false about a third of the time.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PERCENTAGE IS THE HEADLINE AND THE DOLLAR FIGURE IS NOT
 * ---------------------------------------------------------------------------
 * `discount: 19` means 19% off whichever quantity the price refers to. It is
 * the one price signal that survives the ambiguity, because a percentage is
 * unit-agnostic. The dollar amount is shown too, labelled as printed, with the
 * caveat attached.
 *
 * ---------------------------------------------------------------------------
 * WHAT ELSE IS NOT IN THE FEED
 * ---------------------------------------------------------------------------
 * No page number, no page image, no PDF. The positional fields are a stitched
 * canvas across the whole flyer, not page coordinates, and there is nothing to
 * divide them by. So an offer from here can never carry "page 7" and the
 * screens must not imply one.
 *
 * `print_id` carries a unit suffix (_EA, _KG, _C48) at Loblaw banners and is
 * null at Adonis, so it is read when present and never assumed.
 */

export type FlippRetailer =
  | "maxi"
  | "walmart"
  | "superc"
  | "metro"
  | "iga"
  | "provigo"
  | "adonis";

/**
 * Merchant names as the feed spells them, mapped to this app's ids.
 *
 * Matched on a normalised, accent-stripped substring, because the feed prints
 * "Supermarché Aurès" and "Marché Ami" and will print something unexpected for
 * a banner nobody has seen yet. Anything unmatched is dropped rather than
 * guessed at: an offer filed under the wrong shop is worse than no offer.
 */
const MERCHANTS: [RegExp, FlippRetailer][] = [
  [/\bmaxi\b/, "maxi"],
  [/\bwalmart\b/, "walmart"],
  [/\bsuper\s*c\b/, "superc"],
  [/\bmetro\b/, "metro"],
  [/\biga\b/, "iga"],
  [/\bprovigo\b/, "provigo"],
  [/\badonis\b/, "adonis"],
];

export function retailerFromMerchant(name: unknown): FlippRetailer | null {
  if (typeof name !== "string") return null;
  const clean = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  for (const [pattern, id] of MERCHANTS) {
    if (pattern.test(clean)) return id;
  }
  return null;
}

/** What the feed calls a unit, where it says so at all. */
export type FlippBasis = "PER_ITEM" | "PER_KG" | "PER_LB" | "UNKNOWN";

/**
 * The unit, from `print_id`'s suffix.
 *
 * "21351847_EA" is each; "20524922001_KG" is per kilogram. A case suffix
 * (_C12, _C48) is a pack of that many and is NOT a per-item price, so it is
 * reported as UNKNOWN rather than as PER_ITEM — a case of 48 beers at $64.85
 * compared against a single bottle is the same class of error as a multi-buy.
 *
 * Null print_id means the merchant does not publish one. Not an excuse to
 * assume PER_ITEM.
 */
export function basisFromPrintId(printId: unknown): FlippBasis {
  if (typeof printId !== "string") return "UNKNOWN";
  const suffix = printId.split("_").pop()?.toUpperCase() ?? "";
  if (suffix === "EA") return "PER_ITEM";
  if (suffix === "KG") return "PER_KG";
  if (suffix === "LB") return "PER_LB";
  return "UNKNOWN";
}

/**
 * A price string as integer cents, or null.
 *
 * The feed sends "4.0", "10.0", "64.85" — strings, sometimes with one decimal
 * place. Parsed exactly; anything unreadable is null rather than zero, because
 * zero is a price and "I could not read it" is not.
 */
export function priceToCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  if (typeof value !== "string") return null;
  const match = /^\s*\$?\s*(\d+(?:[.,]\d+)?)\s*$/.exec(value);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]!.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export interface SizeReading {
  /** The size as printed, when there is exactly one. */
  size: string | null;
  /**
   * True when the name carries a RANGE ("110-150 G") or several alternatives
   * ("500 G OU 400 G"). The tile covers more than one pack, so no single size
   * describes it and none is offered.
   */
  ambiguous: boolean;
}

/**
 * The size, out of the name, or an admission that there isn't one.
 *
 * Flipp has no size field — it is inside the name, in French, English or both:
 *
 *   "BOUILLON À FONDUE CANTON | FONDUE BROTH, 1 L"      -> 1 L
 *   "BARRES ... MADE GOOD, 110-150 G"                   -> a RANGE, refused
 *   "FROMAGE ... 500 G OU 400 G OU RÂPÉ, 320 G PC"      -> alternatives, refused
 *
 * A range is the important case and the one a naive regex gets wrong: taking
 * "110" from "110-150 G" produces a confident size for a pack that may be any
 * of several, and the whole matcher rests on size agreeing.
 */
const RANGE = /\d+(?:[.,]\d+)?\s*-\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l|un|oz)\b/i;
const MULTI_ALTERNATIVE = /\b(?:ou|or)\b[^|]{0,40}?\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\b/i;
const SINGLE =
  /(\d+(?:[.,]\d+)?\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\b|\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\b)/i;

export function sizeFromName(name: unknown): SizeReading {
  if (typeof name !== "string" || name.trim() === "") {
    return { size: null, ambiguous: false };
  }
  if (RANGE.test(name)) return { size: null, ambiguous: true };
  if (MULTI_ALTERNATIVE.test(name)) return { size: null, ambiguous: true };

  const match = SINGLE.exec(name);
  return match ? { size: match[1]!.trim(), ambiguous: false } : { size: null, ambiguous: false };
}

/**
 * Brands, where the feed lists several for one tile.
 *
 * "SAPUTO | PC" and "COORS LIGHT | BUD LIGHT | ... | ULTRA" are one row
 * advertising several products at one price. The app's own flyer reader splits
 * these into an entry per product; this feed does not, and nothing in the row
 * says which brand goes with which size. So a multi-brand tile keeps every
 * brand for display and is marked so the matcher can refuse to treat it as one
 * product.
 */
export function brandsFrom(brand: unknown): string[] {
  if (typeof brand !== "string") return [];
  return brand
    .split("|")
    .map((b) => b.trim())
    .filter((b) => b !== "");
}

export interface NormalisedFlippOffer {
  /** Stable across weeks: the feed's own item id. */
  id: string;
  flyerId: string;
  retailerId: FlippRetailer;
  advertisedText: string;
  /** The single brand, or null when the tile lists several or none. */
  brand: string | null;
  /** Every brand named, for display on a multi-product tile. */
  brands: string[];
  size: string | null;
  /** True when the name gave a range or alternatives rather than one size. */
  sizeAmbiguous: boolean;
  priceCents: number;
  /** Percent off, when the feed states it. Unit-agnostic, so always safe. */
  discountPercent: number | null;
  basis: FlippBasis;
  /** Always true for this source. See the header. */
  conditionUnknown: true;
  imageUrl: string | null;
  validFrom: string;
  validTo: string;
  /** True when one row advertises several different products. */
  multiProduct: boolean;
}

export type Rejection =
  | "no-name"
  | "no-price"
  | "unknown-merchant"
  | "no-dates"
  | "not-a-record";

export interface NormaliseResult {
  offers: NormalisedFlippOffer[];
  /** Why rows were dropped, counted. Silence about discards is how a feed
   *  quietly halves and nobody notices. */
  rejected: Record<Rejection, number>;
}

/** An ISO timestamp as a plain day, or null. */
function isoDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1]! : null;
}

/** https for an image the feed serves over http. */
function secureUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("http")) return null;
  return value.replace(/^http:\/\//, "https://");
}

/**
 * Normalise one flyer's items.
 *
 * `merchantName` and `flyerId` come from the flyer record rather than the
 * items, because the items carry only `flyer_id`.
 */
export function normaliseFlyerItems(
  items: unknown,
  merchantName: unknown,
  flyerId: unknown,
): NormaliseResult {
  const rejected: Record<Rejection, number> = {
    "no-name": 0,
    "no-price": 0,
    "unknown-merchant": 0,
    "no-dates": 0,
    "not-a-record": 0,
  };
  const offers: NormalisedFlippOffer[] = [];

  const retailerId = retailerFromMerchant(merchantName);
  if (!Array.isArray(items)) return { offers, rejected };

  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) {
      rejected["not-a-record"] += 1;
      continue;
    }
    const row = raw as Record<string, unknown>;

    if (retailerId === null) {
      rejected["unknown-merchant"] += 1;
      continue;
    }

    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (name === "") {
      // Roughly one row in seven. Image-only tiles the feed never captioned;
      // they cannot be matched to anything and must not be stored.
      rejected["no-name"] += 1;
      continue;
    }

    const priceCents = priceToCents(row.price);
    if (priceCents === null) {
      rejected["no-price"] += 1;
      continue;
    }

    const validFrom = isoDay(row.valid_from);
    const validTo = isoDay(row.valid_to ?? row.available_to);
    if (!validFrom || !validTo) {
      rejected["no-dates"] += 1;
      continue;
    }

    const brands = brandsFrom(row.brand);
    const { size, ambiguous } = sizeFromName(name);
    const discount =
      typeof row.discount === "number" && Number.isFinite(row.discount) && row.discount > 0
        ? Math.round(row.discount)
        : null;

    offers.push({
      id: `flipp-${String(row.id ?? row.flyer_item_id ?? "")}`,
      flyerId: String(row.flyer_id ?? flyerId ?? ""),
      retailerId,
      advertisedText: name,
      brand: brands.length === 1 ? brands[0]! : null,
      brands,
      size,
      sizeAmbiguous: ambiguous,
      priceCents,
      discountPercent: discount,
      basis: basisFromPrintId(row.print_id),
      conditionUnknown: true,
      imageUrl: secureUrl(row.cutout_image_url),
      validFrom,
      validTo,
      multiProduct: brands.length > 1,
    });
  }

  return { offers, rejected };
}
