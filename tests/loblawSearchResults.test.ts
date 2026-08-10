/**
 * Loblaw search result parsing, tested against a real capture.
 *
 * `maxi-search-oikos.results.json` is what maxi.ca returned for the query
 * "oikos" at store 7495. Both results in it are sponsored Yoplait drinks —
 * which is not a quirk of the capture, it is what the endpoint does, and it is
 * why `isSponsored` is carried through rather than ignored.
 */

import { describe, expect, it } from "vitest";

import capture from "@/fixtures/captures/maxi-search-oikos.results.json";
import {
  parseLoblawSearchResult,
  parseLoblawSearchResults,
} from "@/services/retailers/loblaw/searchResults";

const ORIGIN = "https://www.maxi.ca";
const first = capture.results[0];

function parse(item: unknown = first) {
  const result = parseLoblawSearchResult(item, ORIGIN);
  if (!result) throw new Error("fixture failed to parse");
  return result;
}

describe("the real capture", () => {
  it("reads both results", () => {
    expect(parseLoblawSearchResults(capture.results, ORIGIN)).toHaveLength(2);
  });

  it("takes brand as a field rather than guessing it from the title", () => {
    // The product page required inferring brand from prose. Here it is given.
    expect(parse().brand).toBe("Yoplait");
    expect(parse().title).toBe("YOP Drinkable Yogurt 1.5% M.F. Peach");
  });

  it("reads the price as integer cents", () => {
    expect(parse().priceCents).toBe(100);
  });

  it("builds an absolute product URL from the relative link", () => {
    expect(parse().url).toBe(
      "https://www.maxi.ca/en/yop-drinkable-yogurt-1-5-m-f-peach/p/21757961_EA",
    );
  });

  it("keeps the article number for later identity mapping", () => {
    expect(parse().productId).toBe("21757961_EA");
    expect(parse().articleNumber).toBe("21757961");
  });
});

describe("packageSizing carries two facts, and only one is a size", () => {
  it('takes "200 ml" from "200 ml, $0.50/100ml"', () => {
    // Passing the whole string to the size parser would hand it a dollar
    // figure to interpret.
    expect(parse().size).toBe("200 ml");
  });

  it("handles a size with no unit price after it", () => {
    expect(parse({ ...first, packageSizing: "650 g" }).size).toBe("650 g");
  });

  it("returns null when the field holds something that is not a size", () => {
    expect(parse({ ...first, packageSizing: "Sold by weight" }).size).toBeNull();
    expect(parse({ ...first, packageSizing: "" }).size).toBeNull();
  });
});

describe("sponsored results are advertisements", () => {
  it("marks them, because their position was bought rather than earned", () => {
    // A search for "oikos" returned two Yoplait products. Ranking must never
    // read position here as relevance.
    expect(parse().isSponsored).toBe(true);
  });

  it("still parses them, because a paid listing is a real product at a real price", () => {
    expect(parse().priceCents).toBe(100);
  });
});

describe("member-only pricing is never treated as the price", () => {
  it("keeps the shelf price when a loyalty price also exists", () => {
    // A loyalty price requires an account and sometimes a loaded offer.
    // Comparing against it produces a saving that evaporates at the till.
    const result = parse({
      ...first,
      pricing: { ...first.pricing, price: "7.49", memberOnlyPrice: "4.99" },
    });
    expect(result.priceCents).toBe(749);
    expect(result.memberOnlyPriceCents).toBe(499);
  });
});

describe("sale prices", () => {
  it("records the struck-through price as the regular one", () => {
    const result = parse({
      ...first,
      pricing: { ...first.pricing, price: "5.99", wasPrice: "7.49" },
    });
    expect(result.priceCents).toBe(599);
    expect(result.regularPriceCents).toBe(749);
  });

  it("leaves regular price null when the item is not on sale", () => {
    expect(parse().regularPriceCents).toBeNull();
  });
});

describe("availability", () => {
  it("treats low stock as in stock", () => {
    expect(parse().availability).toBe("IN_STOCK");
  });

  it("treats a null indicator as normally stocked", () => {
    expect(parse({ ...first, inventoryIndicator: null }).availability).toBe(
      "IN_STOCK",
    );
  });

  it("reports an unrecognised indicator as UNKNOWN rather than available", () => {
    const result = parse({
      ...first,
      inventoryIndicator: { indicatorId: "SOMETHING_NEW" },
    });
    expect(result.availability).toBe("UNKNOWN");
  });
});

describe("refusing to guess", () => {
  it("drops a result whose price cannot be read", () => {
    // Better no row than a comparison with a blank where the number goes.
    for (const price of ["2 for $5", "$1.00", "1,00", "", null]) {
      const result = parseLoblawSearchResult(
        { ...first, pricing: { ...first.pricing, price } },
        ORIGIN,
      );
      expect(result, `price ${JSON.stringify(price)} must be dropped`).toBeNull();
    }
  });

  it("drops a result with no pricing block", () => {
    const { pricing: _omitted, ...noPricing } = first;
    expect(parseLoblawSearchResult(noPricing, ORIGIN)).toBeNull();
  });

  it("skips unparseable items rather than failing the whole search", () => {
    const mixed = [first, null, { title: "no id" }, capture.results[1]];
    expect(parseLoblawSearchResults(mixed, ORIGIN)).toHaveLength(2);
  });

  it("returns nothing for a non-array", () => {
    expect(parseLoblawSearchResults(null, ORIGIN)).toEqual([]);
  });
});
