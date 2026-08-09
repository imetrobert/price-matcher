/**
 * Vision response parsing and model-capability gating.
 *
 * The parser is the boundary between an LLM's output and everything
 * downstream, so it is tested for what it REFUSES as much as what it accepts.
 */

import { describe, expect, it } from "vitest";

import { parseVisionResponse } from "@/services/vision/schema";

describe("vision response parsing", () => {
  it("parses a well-formed detection", () => {
    const out = parseVisionResponse(
      {
        products: [
          {
            brand: "Oikos",
            product_name: "Greek Yogurt",
            variant: "Vanilla",
            fat_percentage: "0",
            size: "650 g",
            package_quantity: 1,
            visible_upc: null,
            confidence: 0.94,
          },
        ],
      },
      { isMock: false },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.brand).toBe("Oikos");
    expect(out[0]!.size).toBe("650 g");
    expect(out[0]!.confidence).toBeCloseTo(0.94);
    expect(out[0]!.isMock).toBe(false);
  });

  it("drops a detection with neither brand nor product name", () => {
    const out = parseVisionResponse(
      { products: [{ variant: "Vanilla", confidence: 0.9 }] },
      { isMock: false },
    );
    expect(out).toHaveLength(0);
  });

  it("discards a barcode that is not barcode-shaped", () => {
    const out = parseVisionResponse(
      {
        products: [
          { brand: "Oikos", product_name: "Yogurt", visible_upc: "12345", confidence: 0.9 },
          { brand: "Ritz", product_name: "Crackers", visible_upc: "not-a-barcode", confidence: 0.9 },
        ],
      },
      { isMock: false },
    );
    expect(out[0]!.visibleUpc).toBeNull();
    expect(out[1]!.visibleUpc).toBeNull();
  });

  it("keeps a plausibly-shaped barcode for later check-digit validation", () => {
    const out = parseVisionResponse(
      {
        products: [
          { brand: "Oikos", product_name: "Yogurt", visible_upc: "0000012345670", confidence: 0.9 },
        ],
      },
      { isMock: false },
    );
    expect(out[0]!.visibleUpc).toBe("0000012345670");
  });

  it("treats the string 'null'/'unknown' as absent rather than as a value", () => {
    const out = parseVisionResponse(
      {
        products: [
          {
            brand: "Oikos",
            product_name: "Yogurt",
            size: "unknown",
            variant: "null",
            confidence: 0.8,
          },
        ],
      },
      { isMock: false },
    );
    expect(out[0]!.size).toBeNull();
    expect(out[0]!.variant).toBeNull();
  });

  it("clamps confidence and defaults a missing one to zero", () => {
    const out = parseVisionResponse(
      {
        products: [
          { brand: "A", product_name: "X", confidence: 5 },
          { brand: "B", product_name: "Y", confidence: -1 },
          { brand: "C", product_name: "Z" },
        ],
      },
      { isMock: false },
    );
    expect(out[0]!.confidence).toBe(1);
    expect(out[1]!.confidence).toBe(0);
    expect(out[2]!.confidence).toBe(0);
  });

  it("survives malformed payloads instead of throwing", () => {
    expect(parseVisionResponse(null, { isMock: false })).toEqual([]);
    expect(parseVisionResponse("nonsense", { isMock: false })).toEqual([]);
    expect(parseVisionResponse({}, { isMock: false })).toEqual([]);
    expect(parseVisionResponse({ products: "no" }, { isMock: false })).toEqual([]);
    expect(
      parseVisionResponse({ products: [null, 42] }, { isMock: false }),
    ).toEqual([]);
  });

  it("stamps isMock through so the UI can label it", () => {
    const out = parseVisionResponse(
      { products: [{ brand: "A", product_name: "X", confidence: 0.9 }] },
      { isMock: true },
    );
    expect(out[0]!.isMock).toBe(true);
  });
});
