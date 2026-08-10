/**
 * Deterministic product normalization.
 *
 * This module is pure, synchronous and has no I/O and no AI. It exists so that
 * "is this the same product?" is answered by code with a readable rule set,
 * not by a language model's opinion. The matcher is only as good as this file.
 */

import type {
  CanonicalProduct,
  DetectedProduct,
  IdentitySource,
  NormalizedSize,
  UnitSystem,
} from "@/types";

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(input: string): string[] {
  const t = normalizeText(input);
  return t === "" ? [] : t.split(" ").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Sub-brand / line handling
// ---------------------------------------------------------------------------

/**
 * Product "lines" that change the formulation while keeping the parent brand.
 * These are the classic false-positive generators: Oikos vs Oikos Pro is a
 * different product with different macros, but naive token overlap scores it
 * as nearly identical.
 *
 * A line token present on one side and absent on the other is a hard blocker.
 */
export const PRODUCT_LINE_TOKENS = new Set([
  "pro",
  "protein",
  "zero",
  "light",
  "lite",
  "diet",
  "max",
  "plus",
  "extra",
  "double",
  "premium",
  "organic",
  "bio",
  "original",
  "classic",
  "greek",
  "skyr",
  "decaf",
  "decaffeinated",
  "unsweetened",
  "sweetened",
  "salted",
  "unsalted",
  "whole",
  "skim",
  "gluten-free",
  "lactose-free",
  "sans-lactose",
]);

/** Tokens that describe packaging noise and should not affect identity. */
const NOISE_TOKENS = new Set([
  "the",
  "de",
  "du",
  "la",
  "le",
  "les",
  "of",
  "and",
  "et",
  "a",
  "an",
  "pack",
  "pk",
  "size",
  "format",
  "new",
  "nouveau",
  // Fat-content markers printed beside the number, in both languages:
  // "0 % M.F." (milk fat) / "0 % M.G." (matière grasse). The NUMBER is
  // identity-bearing and is compared separately via fatPercentage; the marker
  // itself is noise.
  "m.f.",
  "m.g.",
  "mf",
  "mg",
]);

/**
 * French → English term equivalences.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ESSENTIAL IN MONTREAL, AND WHY IT IS DELIBERATELY SHORT
 * ---------------------------------------------------------------------------
 * The same tub of yogurt is listed as "Oikos Greek Yogurt Vanilla 650 g" at
 * one banner and "Oikos Yogourt Grec Vanille 650 g" at another. Without this
 * map the matcher sees a different flavour and a different product line, and
 * rejects a genuine exact match — the single most likely false negative in
 * this market.
 *
 * Only terms whose two forms mean EXACTLY the same thing belong here. A pair
 * that merely looks similar (e.g. "crème" vs "cream cheese") does not, because
 * a wrong entry here silently manufactures false matches — the failure mode
 * this whole codebase is built to avoid. When in doubt, leave it out: a missed
 * match is recoverable, a wrong one shown to a cashier is not.
 */
const TERM_EQUIVALENTS: Record<string, string> = {
  // Product types
  yogourt: "yogurt",
  yaourt: "yogurt",
  grec: "greek",
  grecque: "greek",
  lait: "milk",
  fromage: "cheese",
  cheddar: "cheddar",
  beurre: "butter",
  cafe: "coffee",
  moulu: "ground",
  jus: "juice",
  craquelins: "crackers",
  biscuits: "cookies",
  cereales: "cereal",
  pates: "pasta",
  sauce: "sauce",
  essuie: "paper",
  "essuie-tout": "paper-towels",
  papier: "paper",
  rouleaux: "rolls",
  rouleau: "rolls",
  detergent: "detergent",
  lessive: "laundry",
  boisson: "drink",
  gazeuse: "soft",

  // Flavours / variants
  vanille: "vanilla",
  fraise: "strawberry",
  fraises: "strawberry",
  bleuet: "blueberry",
  bleuets: "blueberry",
  framboise: "raspberry",
  framboises: "raspberry",
  peche: "peach",
  peches: "peach",
  nature: "plain",
  miel: "honey",
  chocolat: "chocolate",
  citron: "lemon",
  mangue: "mango",
  cerise: "cherry",
  cerises: "cherry",
  noix: "nut",
  coco: "coconut",
  erable: "maple",
  original: "original",
  originale: "original",

  // Product-line words that must stay identity-bearing in both languages
  biologique: "organic",
  sale: "salted",
  salee: "salted",
  "non-salee": "unsalted",
  ecreme: "skim",
  entier: "whole",
};

/** Map a token to its canonical (English) form when an exact equivalent exists. */
export function canonicalizeTerm(token: string): string {
  return TERM_EQUIVALENTS[token] ?? token;
}

export function meaningfulTokens(input: string): string[] {
  return tokenize(input)
    .filter((t) => !NOISE_TOKENS.has(t) && t.length > 1)
    .map(canonicalizeTerm)
    .filter((t) => !NOISE_TOKENS.has(t));
}

// ---------------------------------------------------------------------------
// Size parsing
// ---------------------------------------------------------------------------

const MASS_UNITS: Record<string, number> = {
  g: 1,
  gr: 1,
  gram: 1,
  grams: 1,
  grammes: 1,
  kg: 1000,
  kgs: 1000,
  kilogram: 1000,
  kilograms: 1000,
  lb: 453.59237,
  lbs: 453.59237,
  oz: 28.349523125,
};

const VOLUME_UNITS: Record<string, number> = {
  ml: 1,
  mls: 1,
  millilitre: 1,
  millilitres: 1,
  milliliter: 1,
  l: 1000,
  litre: 1000,
  litres: 1000,
  liter: 1000,
  liters: 1000,
};

const COUNT_UNITS = new Set([
  "ct",
  "count",
  "un",
  "units",
  "unit",
  "pack",
  "pk",
  "sachets",
  "sachet",
  "rolls",
  "roll",
  "bars",
  "bar",
  "pods",
  "pod",
  "capsules",
  "capsule",
]);

export interface ParsedSize {
  size: NormalizedSize | null;
  /** Multi-pack count, e.g. "4 x 100 g" -> 4. Defaults to 1. */
  packageCount: number;
}

/**
 * Parse a printed size into a canonical base unit plus a package count.
 *
 * Handles: "650 g", "0.65 kg", "1 L", "4 x 100 g", "4x100g", "12 x 355 mL",
 * "500ml", "6 ct", "2 L".
 *
 * IMPORTANT: "4 x 100 g" yields baseValue 400 AND packageCount 4. Total mass
 * alone is not enough — a 400 g tub and 4 x 100 g cups are different products
 * and the matcher treats packageCount as a hard discriminator.
 */
export function parseSize(raw: string | null | undefined): ParsedSize {
  if (!raw) return { size: null, packageCount: 1 };

  const text = normalizeText(raw).replace(/×/g, "x");
  if (text === "") return { size: null, packageCount: 1 };

  // Multi-pack: "<count> x <value><unit>"
  const multi = text.match(
    /(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*([a-z]+)/,
  );
  if (multi) {
    const count = Number.parseInt(multi[1]!, 10);
    const value = Number.parseFloat(multi[2]!.replace(",", "."));
    const unit = multi[3]!;
    const single = toBase(value, unit);
    if (single) {
      return {
        size: {
          system: single.system,
          baseValue: round3(single.baseValue * count),
          raw: raw.trim(),
        },
        packageCount: count,
      };
    }
  }

  // Bare count: "6 ct", "12 pods"
  const countOnly = text.match(/(\d+)\s*([a-z]+)/);
  if (countOnly && COUNT_UNITS.has(countOnly[2]!)) {
    const count = Number.parseInt(countOnly[1]!, 10);
    return {
      size: { system: "COUNT", baseValue: count, raw: raw.trim() },
      packageCount: count,
    };
  }

  // Single value + unit: "650 g", "1.89 l"
  const single = text.match(/(\d+(?:[.,]\d+)?)\s*([a-z]+)/);
  if (single) {
    const value = Number.parseFloat(single[1]!.replace(",", "."));
    const unit = single[2]!;
    const base = toBase(value, unit);
    if (base) {
      return {
        size: {
          system: base.system,
          baseValue: round3(base.baseValue),
          raw: raw.trim(),
        },
        packageCount: 1,
      };
    }
  }

  return { size: null, packageCount: 1 };
}

function toBase(
  value: number,
  unit: string,
): { system: UnitSystem; baseValue: number } | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (MASS_UNITS[unit] !== undefined) {
    return { system: "MASS", baseValue: value * MASS_UNITS[unit]! };
  }
  if (VOLUME_UNITS[unit] !== undefined) {
    return { system: "VOLUME", baseValue: value * VOLUME_UNITS[unit]! };
  }
  if (COUNT_UNITS.has(unit)) {
    return { system: "COUNT", baseValue: value };
  }
  return null;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Are two sizes the same product size?
 *
 * Tolerance exists only to absorb unit-conversion rounding (0.65 kg vs 650 g),
 * NOT to bridge genuinely different pack sizes. 650 g vs 750 g is a 15%
 * difference and must never pass.
 */
export const SIZE_TOLERANCE_RATIO = 0.02;

export function sizesMatch(
  a: NormalizedSize | null,
  b: NormalizedSize | null,
): boolean {
  if (!a || !b) return false;
  if (a.system !== b.system) return false;
  if (a.baseValue <= 0 || b.baseValue <= 0) return false;
  const diff = Math.abs(a.baseValue - b.baseValue);
  const ratio = diff / Math.max(a.baseValue, b.baseValue);
  return ratio <= SIZE_TOLERANCE_RATIO;
}

// ---------------------------------------------------------------------------
// GTIN
// ---------------------------------------------------------------------------

/**
 * Normalize any GTIN-8/12/13/14 to GTIN-14 (zero-padded) so that a UPC-A and
 * its EAN-13 form compare equal. Returns null when the input is not a valid
 * GTIN with a correct check digit.
 */
export function normalizeGtin(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  if (!isValidGtinCheckDigit(digits)) return null;
  return digits.padStart(14, "0");
}

/** Standard GS1 mod-10 check digit validation. */
export function isValidGtinCheckDigit(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 8) return false;
  const body = digits.slice(0, -1);
  const check = Number.parseInt(digits.slice(-1), 10);
  let sum = 0;
  // Weights alternate 3,1 starting from the rightmost body digit.
  for (let i = body.length - 1, mult = 3; i >= 0; i -= 1, mult = mult === 3 ? 1 : 3) {
    sum += Number.parseInt(body[i]!, 10) * mult;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === check;
}

export function gtinsMatch(a: string | null, b: string | null): boolean {
  const na = normalizeGtin(a);
  const nb = normalizeGtin(b);
  return na !== null && nb !== null && na === nb;
}

// ---------------------------------------------------------------------------
// Fat percentage
// ---------------------------------------------------------------------------

/** "0%", "0 %", "2 M.F.", "3.25%" -> "0", "0", "2", "3.25" */
export function normalizeFatPercentage(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  const m = normalizeText(input).match(/(\d+(?:\.\d+)?)\s*%?/);
  if (!m) return null;
  const value = Number.parseFloat(m[1]!);
  if (!Number.isFinite(value)) return null;
  return String(value);
}

// ---------------------------------------------------------------------------
// Canonical construction
// ---------------------------------------------------------------------------

export interface CanonicalInput {
  gtin?: string | null;
  brand: string;
  name: string;
  variant?: string | null;
  fatPercentage?: string | null;
  size?: string | null;
  packageCount?: number | null;
  identitySource: IdentitySource;
  /** Stable id; generated when absent. */
  id?: string;
}

export function buildCanonicalProduct(
  input: CanonicalInput,
): CanonicalProduct {
  const parsed = parseSize(input.size ?? null);
  const packageCount =
    input.packageCount && input.packageCount > 0
      ? input.packageCount
      : parsed.packageCount;

  const brand = input.brand.trim();
  const name = input.name.trim();
  const variant = input.variant?.trim() || null;
  const fat = normalizeFatPercentage(input.fatPercentage ?? null);

  const tokens = Array.from(
    new Set([
      ...meaningfulTokens(brand),
      ...meaningfulTokens(name),
      ...(variant ? meaningfulTokens(variant) : []),
    ]),
  ).sort();

  return {
    id: input.id ?? canonicalId({ brand, name, variant, fat, parsed, packageCount }),
    gtin: normalizeGtin(input.gtin ?? null),
    brand,
    name,
    variant,
    fatPercentage: fat,
    size: parsed.size,
    packageCount,
    normalizedTokens: tokens,
    identitySource: input.identitySource,
  };
}

function canonicalId(parts: {
  brand: string;
  name: string;
  variant: string | null;
  fat: string | null;
  parsed: ParsedSize;
  packageCount: number;
}): string {
  const sizePart = parts.parsed.size
    ? `${parts.parsed.size.system}-${parts.parsed.size.baseValue}`
    : "nosize";
  return [
    normalizeText(parts.brand).replace(/\s/g, "-") || "nobrand",
    normalizeText(parts.name).replace(/\s/g, "-") || "noname",
    parts.variant ? normalizeText(parts.variant).replace(/\s/g, "-") : "novariant",
    parts.fat ? `fat${parts.fat}` : "nofat",
    sizePart,
    `x${parts.packageCount}`,
  ].join("_");
}

/** Convert a confirmed vision detection into a canonical identity. */
export function canonicalFromDetection(
  detected: DetectedProduct,
): CanonicalProduct | null {
  if (!detected.brand && !detected.productName) return null;
  return buildCanonicalProduct({
    gtin: detected.visibleUpc,
    brand: detected.brand ?? "",
    name: detected.productName ?? "",
    variant: detected.variant,
    fatPercentage: detected.fatPercentage,
    size: detected.size,
    packageCount: detected.packageQuantity,
    identitySource: detected.visibleUpc
      ? "VISIBLE_BARCODE"
      : detected.userConfirmed
        ? "USER_ENTERED"
        : "ATTRIBUTE_SEARCH",
  });
}

/** Short human label used on cards and in Checkout Mode. */
export function productLabel(p: CanonicalProduct): string {
  const bits = [p.brand, p.name].filter(Boolean).join(" ");
  const detail = [p.variant, p.size?.raw].filter(Boolean).join(", ");
  return detail ? `${bits} — ${detail}` : bits;
}
