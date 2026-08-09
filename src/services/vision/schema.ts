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
- Report only what is legible in the image. If you cannot read the size, return null for size. Do not infer a typical size from product knowledge.
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
