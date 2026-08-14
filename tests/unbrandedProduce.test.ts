/**
 * Matching produce, which has no brand to match on.
 *
 * `brandsMatch` treats an empty brand as a blocker. That is right for a
 * packaged good — a tin of tomatoes has a maker, so a missing brand is a
 * failed reading, and pairing on the noun alone would compare two different
 * companies' products. It is wrong for a cauliflower, which has no brand to
 * read, and a price-match desk treats one cauliflower as another.
 *
 * The exemption has to be narrow or it becomes the hole every wrong match
 * comes through, so everything below is about where its edges are.
 */

import { describe, expect, it } from "vitest";

import { scoreMatch, SCORE } from "@/services/matching/scoring";
import { buildCanonicalProduct } from "@/services/products/normalize";

function produce(name: string, patch: Record<string, unknown> = {}) {
  return buildCanonicalProduct({
    brand: "",
    name,
    identitySource: "ATTRIBUTE_SEARCH",
    ...patch,
  });
}

describe("produce matches produce", () => {
  it("pairs the same item across two flyers", () => {
    const result = scoreMatch(produce("Chou-fleur du Québec"), produce("Chou-fleur"));
    expect(result.score).toBe(SCORE.strongAttribute);
    expect(result.blockers).toHaveLength(0);
  });

  it("ignores where it was grown and how it was graded", () => {
    // Two shops will not agree on "du Québec" or "Catégorie 1", and for an
    // unbranded item that suffix is the whole difference between the names.
    const result = scoreMatch(
      produce("Cantaloup du Canada Catégorie 1"),
      produce("Cantaloup importé"),
    );
    expect(result.score).toBe(SCORE.strongAttribute);
  });

  it("scores at the floor a comparison needs, not above it", () => {
    // Nothing corroborates the reading — no brand, no size, no variant. It
    // earns exactly the threshold and not a step more.
    expect(scoreMatch(produce("Brocoli"), produce("Brocoli")).score).toBe(90);
  });
});

describe("where the exemption stops", () => {
  it("does not pair cabbage with cauliflower", () => {
    // "chou" is a strict subset of "chou-fleur", which the branded path would
    // accept. The phrase pass keeps the compound whole and the identity
    // tokens must be equal, so this stays apart.
    const result = scoreMatch(produce("Chou vert"), produce("Chou-fleur"));
    expect(result.score).toBe(0);
    expect(result.blockers.join(" ")).toMatch(/not the same product/);
  });

  it("does not pair a plain noun with a qualified one", () => {
    const result = scoreMatch(produce("Poulet"), produce("Poulet pané"));
    expect(result.score).toBe(0);
  });

  it("still blocks two unbranded PACKAGED goods", () => {
    // A printed size says somebody packaged this, so the brand should have
    // been readable and its absence is a failed read. Two dairies' butter
    // must not become one product.
    const result = scoreMatch(
      produce("Beurre", { size: "454 g" }),
      produce("Butter", { size: "454 g" }),
    );
    expect(result.score).toBe(0);
    expect(result.blockers.join(" ")).toMatch(/brand/i);
  });

  it("still blocks when only one side names a brand", () => {
    // Not the same situation at all: one side made a claim and the other did
    // not, which is a reading failure rather than an absent attribute.
    const result = scoreMatch(
      produce("Chou-fleur"),
      buildCanonicalProduct({
        brand: "Green Giant",
        name: "Chou-fleur",
        identitySource: "ATTRIBUTE_SEARCH",
      }),
    );
    expect(result.score).toBe(0);
    expect(result.blockers.join(" ")).toMatch(/brand/i);
  });
});

describe("across the two languages", () => {
  it("pairs a French flyer against an English reading of the package", () => {
    // The cart photograph is read in whichever language faces the camera;
    // Canadian packaging is bilingual and the flyer is not.
    expect(scoreMatch(produce("Brocoli"), produce("Broccoli")).score).toBe(90);
    expect(scoreMatch(produce("Chou-fleur"), produce("Cauliflower")).score).toBe(90);
    expect(scoreMatch(produce("Maïs"), produce("Corn")).score).toBe(90);
  });
});
