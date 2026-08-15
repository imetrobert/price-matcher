/**
 * Strict schema for cart-photo recognition.
 *
 * The model is constrained to emit JSON matching this schema (Gemini
 * `responseSchema`), and the result is re-validated in TypeScript before it
 * touches anything downstream. Free-text model output is never parsed by
 * downstream code.
 */

import type { DetectedProduct } from "@/types";

/** Gemini responseSchema (OpenAPI 3 subset). */
export const CART_VISION_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          brand: { type: "string", nullable: true },
          product_name: { type: "string", nullable: true },
          product_type: { type: "string", nullable: true },
          variant: { type: "string", nullable: true },
          fat_percentage: { type: "string", nullable: true },
          size: { type: "string", nullable: true },
          size_guess: { type: "string", nullable: true },
          size_guess_basis: { type: "string", nullable: true },
          package_quantity: { type: "integer", nullable: true },
          visible_upc: { type: "string", nullable: true },
          language: { type: "string", nullable: true },
          manufacturer: { type: "string", nullable: true },
          notes: { type: "string", nullable: true },
          confidence: { type: "number" },
        },
        required: ["confidence"],
      },
    },
  },
  required: ["products"],
} as const;

export const VISION_PROMPT = `You are identifying grocery products visible in a photograph of a shopping cart, taken in a store in Montreal, Quebec, Canada. Packaging may be in French, English, or bilingual.

For each DISTINCT product you can actually see, return one entry.

Rules you must follow:
- Report only what is legible in the image. If you cannot read the size, return null for size. Do not infer a typical size from product knowledge. "size" is for text you can actually read.
- When, and only when, "size" is null, you may propose one in "size_guess", and you must say how you arrived at it in "size_guess_basis" using one or more of these words:
    "partial_label"  — some of the size text is legible: a unit, a digit, a fragment.
    "dimensions"     — judged from how large the package looks beside other items in the photo whose size you did read, or from packaging you recognise by shape.
    "typical"        — the sizes this brand and product are normally sold in.
  Combine them when more than one applies, most reliable first, for example "partial_label+typical".
- A size_guess is a suggestion for a person to accept or reject. It is never as good as reading the label, so never move one into "size", and never raise "confidence" because you made one.
- If you have no basis at all, leave size_guess null. A guess with nothing behind it is worse than no guess.
- Do the same for every field: an unreadable field is null, never a guess.
- "confidence" is your confidence that a shopper would agree with your reading of the visible package, from 0 to 1. Use values below 0.5 freely when the package is partly hidden, blurry, or at a steep angle.
- If the same product appears multiple times, return it once and set package_quantity to the number of identical units visible.
- package_quantity means units of that product in the cart. Multi-packs printed on the label (for example "4 x 100 g") belong in "size", not package_quantity.
- Copy "size" exactly as printed, including units, for example "650 g", "1.89 L", "4 x 100 g".
- fat_percentage applies to dairy and similar products; give just the number as a string, for example "0" or "3.25". Null when not shown.
- variant means the flavour or sub-type as printed, for example "Vanilla", "Vanille", "Old Cheddar", "Classic Roast".
- If a barcode is legible, put the digits in visible_upc. Never transcribe a barcode you cannot read clearly, and never invent digits.
- If a product line is printed on the package (for example "Pro", "Zero", "Light", "Organic"), include it in product_name exactly as shown. This distinction matters.
- Ignore non-product items: the cart itself, shelves, hands, floor, other shoppers.

Return JSON only, matching the provided schema.`;

interface RawProduct {
  brand?: string | null;
  product_name?: string | null;
  product_type?: string | null;
  variant?: string | null;
  fat_percentage?: string | null;
  size?: string | null;
  size_guess?: string | null;
  size_guess_basis?: string | null;
  package_quantity?: number | null;
  visible_upc?: string | null;
  language?: string | null;
  manufacturer?: string | null;
  notes?: string | null;
  confidence?: number;
}

/**
 * Validate and coerce raw model output. Anything malformed is dropped rather
 * than repaired — a half-understood detection is worse than a missing one.
 */
export function parseVisionResponse(
  raw: unknown,
  opts: { isMock: boolean },
): DetectedProduct[] {
  if (typeof raw !== "object" || raw === null) return [];
  const products = (raw as { products?: unknown }).products;
  if (!Array.isArray(products)) return [];

  const out: DetectedProduct[] = [];
  products.forEach((item, index) => {
    if (typeof item !== "object" || item === null) return;
    const p = item as RawProduct;

    const brand = cleanString(p.brand);
    const productName = cleanString(p.product_name);
    // A detection with neither brand nor name cannot be matched on. Drop it.
    if (!brand && !productName) return;

    const confidence =
      typeof p.confidence === "number" && Number.isFinite(p.confidence)
        ? Math.min(Math.max(p.confidence, 0), 1)
        : 0;

    out.push({
      id: `det-${index}-${slug(brand ?? "")}-${slug(productName ?? "")}`,
      brand,
      productName,
      productType: cleanString(p.product_type),
      variant: cleanString(p.variant),
      fatPercentage: cleanString(p.fat_percentage),
      size: cleanString(p.size),
      // Kept apart from `size`, permanently. The moment a guess can be
      // mistaken for a reading, every downstream claim that rests on size —
      // which is every price match — inherits the guess without saying so.
      sizeGuess: cleanString(p.size_guess),
      sizeGuessBasis: cleanBasis(p.size_guess_basis),
      packageQuantity: cleanQuantity(p.package_quantity),
      visibleUpc: cleanUpc(p.visible_upc),
      language: cleanString(p.language),
      manufacturer: cleanString(p.manufacturer),
      notes: cleanString(p.notes),
      confidence,
      isMock: opts.isMock,
      userConfirmed: false,
    });
  });

  return out;
}

/**
 * The basis words, and only those words.
 *
 * The screen turns this into a sentence a person reads before deciding whether
 * to trust a number. Passing arbitrary model text through to that sentence
 * would let the reasoning be whatever the model felt like writing; a fixed
 * vocabulary means the app is making the claim, not repeating one.
 */
const BASIS_WORDS = ["partial_label", "dimensions", "typical"];

function cleanBasis(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const kept = v
    .toLowerCase()
    .split(/[^a-z_]+/)
    .filter((w) => BASIS_WORDS.includes(w));
  return kept.length > 0 ? [...new Set(kept)].join("+") : null;
}

function cleanString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "" || t.toLowerCase() === "null" || t.toLowerCase() === "unknown") {
    return null;
  }
  return t;
}

function cleanQuantity(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  return n > 0 && n < 100 ? n : null;
}

/** Only accept barcode-shaped digit strings; anything else is discarded. */
function cleanUpc(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const digits = v.replace(/\D/g, "");
  return [8, 12, 13, 14].includes(digits.length) ? digits : null;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * What the camera could see but not name.
 *
 * ---------------------------------------------------------------------------
 * WHY A COUNT OF FAILURES IS PART OF THE READING
 * ---------------------------------------------------------------------------
 * Six products read from a photograph of eleven is not a reading of that cart,
 * and nothing in the response distinguished it from a photograph of six. The
 * shopper is the only one who can fix it — another angle, moving the bread —
 * and they can only decide to if somebody tells them there is something to
 * fix.
 *
 * Deliberately a count and a sentence, not a list. An item nobody can identify
 * has no fields to report, and inventing placeholder cards for them would put
 * unnamed rows in a list whose whole job is naming things.
 */
export interface CoverageReport {
  /** Distinct items visibly present that could not be identified at all. */
  obscured: number;
  /** Why, in the model's own words, or null. */
  note: string | null;
}

export function parseCoverage(raw: unknown): CoverageReport {
  if (typeof raw !== "object" || raw === null) return { obscured: 0, note: null };
  const row = raw as { obscured_count?: unknown; obscured_note?: unknown };

  // Absent, negative or non-integer all mean the same thing: no usable claim
  // about what was missed. Zero is the honest floor — never a guess upward.
  const count =
    typeof row.obscured_count === "number" && Number.isFinite(row.obscured_count)
      ? Math.max(0, Math.round(row.obscured_count))
      : 0;

  const note = cleanString(row.obscured_note);
  return { obscured: count, note: count > 0 ? note : null };
}
