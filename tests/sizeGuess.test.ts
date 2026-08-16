/**
 * A size the model proposed, kept separate from one it read.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SEPARATION IS THE WHOLE FEATURE
 * ---------------------------------------------------------------------------
 * Matching needs a score of 90, and with the size unknown on either side the
 * best rung available is the fuzzy one, capped at 70. So an item with no size
 * cannot match a flyer at all — which makes a guessed size very tempting and
 * very dangerous: "650 g" accepted against a flyer's 750 g tub is a confident
 * match on the wrong product, carried to a till with a page number attached.
 *
 * The guess therefore has to stay out of `size` until a person accepts it.
 * These tests pin that, and pin that the reasoning shown beside it is the
 * app's vocabulary rather than whatever text the model returned.
 */

import { describe, expect, it } from "vitest";

import { parseVisionResponse } from "@/services/vision/schema";
import { scoreMatch } from "@/services/matching/scoring";
import { buildCanonicalProduct } from "@/services/products/normalize";

const raw = (product: Record<string, unknown>) => ({ products: [product] });

describe("reading a proposed size", () => {
  it("keeps a guess out of size", () => {
    const [p] = parseVisionResponse(
      raw({
        brand: "Oikos",
        product_name: "Oikos",
        size: null,
        size_guess: "650 g",
        size_guess_basis: "typical",
        confidence: 0.9,
      }),
      { isMock: false },
    );

    expect(p!.size).toBeNull();
    expect(p!.sizeGuess).toBe("650 g");
    expect(p!.sizeGuessBasis).toBe("typical");
  });

  it("keeps a read size exactly as read, guess or no guess", () => {
    const [p] = parseVisionResponse(
      raw({
        brand: "Oikos",
        size: "750 g",
        size_guess: "650 g",
        size_guess_basis: "typical",
        confidence: 0.9,
      }),
      { isMock: false },
    );
    // The label wins. A model that returns both is not a reason to prefer its
    // recollection over its eyes.
    expect(p!.size).toBe("750 g");
  });

  it("has no guess when none was offered", () => {
    const [p] = parseVisionResponse(raw({ brand: "Oikos", confidence: 0.5 }), {
      isMock: false,
    });
    expect(p!.sizeGuess).toBeNull();
    expect(p!.sizeGuessBasis).toBeNull();
  });
});

describe("the basis is the app's vocabulary, not the model's prose", () => {
  const basisOf = (v: unknown) =>
    parseVisionResponse(raw({ brand: "X", size_guess: "650 g", size_guess_basis: v, confidence: 1 }), {
      isMock: false,
    })[0]!.sizeGuessBasis;

  it("keeps the three known words and their combinations", () => {
    expect(basisOf("partial_label")).toBe("partial_label");
    expect(basisOf("dimensions")).toBe("dimensions");
    expect(basisOf("typical")).toBe("typical");
    expect(basisOf("partial_label+typical")).toBe("partial_label+typical");
  });

  it("drops anything else, rather than showing it to a person", () => {
    // This string is rendered on a screen where somebody decides whether to
    // trust a number. Free text there would let the reasoning be whatever the
    // model felt like writing.
    expect(basisOf("because I reckon so")).toBeNull();
    expect(basisOf("<b>trust me</b>")).toBeNull();
    expect(basisOf(42)).toBeNull();
    expect(basisOf(null)).toBeNull();
  });

  it("keeps the known words out of surrounding noise", () => {
    expect(basisOf("mostly typical, honestly")).toBe("typical");
  });

  it("does not repeat a word twice", () => {
    expect(basisOf("typical typical")).toBe("typical");
  });
});

describe("why a missing size matters at all", () => {
  const oikos = (size: string | null) =>
    buildCanonicalProduct({
      brand: "Oikos",
      name: "Oikos",
      variant: "Strawberry",
      size,
      identitySource: "USER_ENTERED",
    });

  it("matches without a size, but never as proof", () => {
    /*
      This reverses a rule that was in force earlier the same day, and the
      reversal was deliberate. Requiring a size to match meant a trolley of
      tubs photographed at an angle produced no results at all and gave no
      reason — the strictness was invisible, which made it useless as a
      safeguard and expensive as a feature.

      Now it matches, and the caution is carried on the result instead: the
      match cannot back a claim at a till, and the screens say the size is
      unconfirmed. A person can act on that; a silently dropped item is not
      something anybody can act on.
    */
    const result = scoreMatch(oikos(null), oikos("650 g"));
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.level).toBe("L3_NO_SIZE");
    expect(result.eligibleForCheckoutProof).toBe(false);
  });

  it("reaches one once the size is supplied", () => {
    const result = scoreMatch(oikos("650 g"), oikos("650 g"));
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("still refuses when the supplied size disagrees", () => {
    // The reason a guess must never be silently accepted: this is the outcome
    // a wrong one converts into a confident match.
    const result = scoreMatch(oikos("750 g"), oikos("650 g"));
    expect(result.score).toBeLessThan(90);
  });
});
