"use client";

/**
 * Mock vision provider.
 *
 * Returns a fixed, plausible cart so the confirmation and results screens work
 * without a Gemini key. It does not look at the image bytes at all — it cannot,
 * and pretending otherwise would be the deception this project exists to
 * avoid. Every detection is stamped `isMock: true`.
 */

import {
  parseVisionResponse,
  type CoverageReport,
} from "@/services/vision/schema";
import type { DetectedProduct } from "@/types";

interface VisionImageLike {
  base64: string;
  mimeType: string;
}

type MockOutcome =
  | {
      ok: true;
      products: DetectedProduct[];
      isMock: boolean;
      note: string;
      coverage: CoverageReport;
    }
  | { ok: false; error: string; code: "NO_IMAGES" };

/**
 * Deliberately mixed confidences so the confirmation UI has to render the
 * "needs confirmation" state, including one item whose size is unreadable.
 */
const MOCK_CART = {
  products: [
    {
      brand: "Oikos",
      product_name: "Greek Yogurt",
      product_type: "yogurt",
      variant: "Vanilla",
      fat_percentage: "0",
      size: "650 g",
      package_quantity: 1,
      visible_upc: null,
      language: "en",
      manufacturer: "Danone",
      notes: null,
      confidence: 0.94,
    },
    {
      brand: "Folgers",
      product_name: "Ground Coffee",
      product_type: "coffee",
      variant: "Classic Roast",
      fat_percentage: null,
      size: "920 g",
      package_quantity: 1,
      visible_upc: null,
      language: "en",
      manufacturer: "Smucker",
      notes: null,
      confidence: 0.88,
    },
    {
      brand: "Natrel",
      product_name: "Milk",
      product_type: "milk",
      variant: null,
      fat_percentage: "2",
      size: "2 L",
      package_quantity: 1,
      visible_upc: null,
      language: "fr",
      manufacturer: "Agropur",
      notes: null,
      confidence: 0.79,
    },
    {
      brand: "Bounty",
      product_name: "Paper Towels",
      product_type: "paper towels",
      variant: "Select-A-Size",
      fat_percentage: null,
      size: "6 rolls",
      package_quantity: 1,
      visible_upc: null,
      language: "en",
      manufacturer: "P&G",
      notes: null,
      confidence: 0.71,
    },
    {
      brand: "Barilla",
      product_name: "Spaghetti",
      product_type: "pasta",
      variant: null,
      fat_percentage: null,
      size: "454 g",
      package_quantity: 1,
      visible_upc: null,
      language: "en",
      manufacturer: "Barilla",
      notes: null,
      confidence: 0.83,
    },
    {
      // Size unreadable on purpose: exercises the "needs confirmation" path
      // and the rule that an unknown size caps the achievable match score.
      brand: "Ritz",
      product_name: "Crackers",
      product_type: "crackers",
      variant: "Original",
      fat_percentage: null,
      size: null,
      package_quantity: 1,
      visible_upc: null,
      language: "en",
      manufacturer: "Mondelez",
      notes: "Size panel not legible in photo",
      confidence: 0.42,
    },
  ],
};

export async function mockRecognizeCart(
  images: VisionImageLike[],
  opts: { reason: string },
): Promise<MockOutcome> {
  if (images.length === 0) {
    return { ok: false, code: "NO_IMAGES", error: "No images supplied." };
  }

  // Small delay so loading states are visible during UI development.
  await new Promise((r) => setTimeout(r, 250));

  const products = parseVisionResponse(MOCK_CART, { isMock: true });

  return {
    ok: true,
    products,
    isMock: true,
    note: `MOCK recognition — the photo was not analysed (${opts.reason}). These products come from src/services/vision/mock.ts.`,
    // Nothing was looked at, so nothing can be reported as hidden. Claiming
    // full coverage of a photo nobody read would be the fixture asserting
    // something about the shopper's actual cart.
    coverage: { obscured: 0, note: null },
  };
}
