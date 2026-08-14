/**
 * Matching a French flyer against an English cart, and vice versa.
 *
 * Every term below comes from the real week-33 Montreal flyers — 257 offers
 * read off Maxi's, and the bilingual tiles on Walmart's — rather than from a
 * dictionary. A lexicon entry that never occurs in a flyer is a liability, not
 * a feature: it can only ever manufacture a wrong match.
 */

import { describe, expect, it } from "vitest";

import {
  buildCanonicalProduct,
  dependsOnTranslation,
  meaningfulTokens,
} from "@/services/products/normalize";
import { scoreMatch } from "@/services/matching/scoring";

describe("the lexicon covers what the flyers actually say", () => {
  it("translates the nouns that appeared in Maxi's week", () => {
    const cases: [string, string][] = [
      ["beurre", "butter"],
      ["poulet", "chicken"],
      ["fromage", "cheese"],
      ["tomates", "tomato"],
      ["laitue", "lettuce"],
      ["oignons", "onion"],
      ["carottes", "carrot"],
      ["saucisses", "sausage"],
      ["jambon", "ham"],
      ["boeuf", "beef"],
      ["porc", "pork"],
      ["biere", "beer"],
      ["jus", "juice"],
      ["creme", "cream"],
      ["barres", "bar"],
      ["avocats", "avocado"],
      ["courgettes", "zucchini"],
    ];
    for (const [fr, en] of cases) {
      expect(meaningfulTokens(fr)).toEqual(meaningfulTokens(en));
    }
  });

  it("handles accents the way a flyer prints them", () => {
    expect(meaningfulTokens("Bœuf haché").sort()).toEqual(
      meaningfulTokens("ground beef").sort(),
    );
    expect(meaningfulTokens("Épinards")).toEqual(meaningfulTokens("spinach"));
  });

  it("drops the boilerplate that recurs on every second tile", () => {
    // "certaines varietes" appeared 28 times in one flyer. Two unrelated tiles
    // both saying it must not look like agreement.
    expect(meaningfulTokens("certaines variétés")).toEqual([]);
    expect(meaningfulTokens("Chac. Produit du Canada. Limite de 8")).toEqual([
      "canada",
    ]);
  });
});

describe("phrases whose words lie", () => {
  it("keeps potatoes from becoming apples", () => {
    // "pommes" alone is apple, so a token-by-token reading of "pommes de
    // terre" is not merely incomplete — it is a different vegetable.
    expect(meaningfulTokens("pommes de terre")).toEqual(["potato"]);
    expect(meaningfulTokens("pommes")).toEqual(["apple"]);
    expect(meaningfulTokens("pommes de terre")).not.toEqual(
      meaningfulTokens("pommes"),
    );
  });

  it("still matches potatoes across languages", () => {
    expect(meaningfulTokens("pommes de terre")).toEqual(
      meaningfulTokens("potato"),
    );
  });

  it("reads the compound cuts a flyer prints", () => {
    // Order follows the language's own word order, so compare as sets.
    expect(meaningfulTokens("hauts de cuisse de poulet").sort()).toEqual(
      meaningfulTokens("chicken thigh").sort(),
    );
  });
});

describe("knowing when a match leaned on translation", () => {
  it("says no when the two literally share words", () => {
    expect(dependsOnTranslation("Oikos yogurt", "Oikos yogurt plain")).toBe(false);
  });

  it("says yes when only the lexicon connects them", () => {
    expect(dependsOnTranslation("beurre", "butter")).toBe(true);
  });

  it("says no when they do not match at all", () => {
    expect(dependsOnTranslation("beurre", "chicken")).toBe(false);
  });
});

describe("what the matcher does with a translated name", () => {
  const size = "454 g";

  it("treats a translated name as a full match when both name a brand", () => {
    // The brand blocker has already established these are the same maker, so
    // the translated noun is corroboration rather than the whole case.
    const fr = buildCanonicalProduct({
      brand: "Lactantia",
      name: "beurre",
      size,
      identitySource: "ATTRIBUTE_SEARCH",
    });
    const en = buildCanonicalProduct({
      brand: "Lactantia",
      name: "butter",
      size,
      identitySource: "ATTRIBUTE_SEARCH",
    });
    const result = scoreMatch(fr, en);
    expect(result.level).toBe("L3_ATTRIBUTES");
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("blocks outright when neither side names a brand", () => {
    // "beurre 454 g" and "butter 454 g" could be two different dairies. The
    // brand blocker already refuses this — an unknown brand is treated as a
    // different brand — which is stronger than merely lowering the score, and
    // is why no translation-specific cap is needed at Level 3.
    const fr = buildCanonicalProduct({ brand: "", name: "beurre", size,
      identitySource: "ATTRIBUTE_SEARCH",
    });
    const en = buildCanonicalProduct({ brand: "", name: "butter", size,
      identitySource: "ATTRIBUTE_SEARCH",
    });
    const result = scoreMatch(fr, en);
    expect(result.score).toBe(0);
    expect(result.blockers.join(" ")).toMatch(/brand/i);
  });

  it("still blocks a different brand outright, translation or not", () => {
    const fr = buildCanonicalProduct({
      brand: "Lactantia",
      name: "beurre",
      size,
      identitySource: "ATTRIBUTE_SEARCH",
    });
    const en = buildCanonicalProduct({
      brand: "Natrel",
      name: "butter",
      size,
      identitySource: "ATTRIBUTE_SEARCH",
    });
    expect(scoreMatch(fr, en).score).toBe(0);
  });

  it("still blocks a different size, translation or not", () => {
    const fr = buildCanonicalProduct({
      brand: "Lactantia",
      name: "beurre",
      size: "454 g",
      identitySource: "ATTRIBUTE_SEARCH",
    });
    const en = buildCanonicalProduct({
      brand: "Lactantia",
      name: "butter",
      size: "250 g",
      identitySource: "ATTRIBUTE_SEARCH",
    });
    expect(scoreMatch(fr, en).score).toBe(0);
  });
});
