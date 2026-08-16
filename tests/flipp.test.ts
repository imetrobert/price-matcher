/**
 * Normalising Flipp flyer items, against payloads that actually came back.
 *
 * Every fixture below is real: copied from responses to
 * backflipp.wishabi.com/flipp/flyers/8073211 (Maxi) and /8072235 (Adonis).
 * That matters more than usual here, because the whole reason this module is
 * cautious is a discrepancy nobody would have predicted — see the Tropicana
 * case at the bottom.
 */

import { describe, expect, it } from "vitest";

import {
  basisFromPrintId,
  brandsFrom,
  normaliseFlyerItems,
  priceToCents,
  retailerFromMerchant,
  sizeFromName,
} from "@shared/flipp";

describe("which shop an offer belongs to", () => {
  it("recognises the six banners", () => {
    expect(retailerFromMerchant("Maxi")).toBe("maxi");
    expect(retailerFromMerchant("Walmart")).toBe("walmart");
    expect(retailerFromMerchant("Super C")).toBe("superc");
    expect(retailerFromMerchant("Metro")).toBe("metro");
    expect(retailerFromMerchant("IGA")).toBe("iga");
    expect(retailerFromMerchant("Adonis")).toBe("adonis");
  });

  it("copes with accents and case, which the feed uses freely", () => {
    // Real merchant names from the feed: "Supermarché Aurès", "Marché Ami".
    expect(retailerFromMerchant("SUPER C")).toBe("superc");
    expect(retailerFromMerchant("super c")).toBe("superc");
  });

  it("drops a shop it does not know rather than guessing", () => {
    // An offer filed under the wrong banner is worse than no offer.
    expect(retailerFromMerchant("T&T Supermarket")).toBeNull();
    expect(retailerFromMerchant("Shoppers Drug Mart")).toBeNull();
    expect(retailerFromMerchant("Marché Lian Tai")).toBeNull();
    expect(retailerFromMerchant(null)).toBeNull();
  });
});

describe("the unit, from print_id", () => {
  it("reads Loblaw's suffixes", () => {
    expect(basisFromPrintId("21351847_EA")).toBe("PER_ITEM");
    expect(basisFromPrintId("20524922001_KG")).toBe("PER_KG");
  });

  it("refuses to call a case of 48 a per-item price", () => {
    // $64.85 for 48 beers compared against one bottle is the same class of
    // error as a multi-buy, so a case suffix is UNKNOWN rather than PER_ITEM.
    expect(basisFromPrintId("20596793_C48")).toBe("UNKNOWN");
    expect(basisFromPrintId("20121729_C12")).toBe("UNKNOWN");
  });

  it("does not assume per-item when the merchant publishes nothing", () => {
    // Every Adonis row has print_id: null. Absence is not evidence of "each".
    expect(basisFromPrintId(null)).toBe("UNKNOWN");
    expect(basisFromPrintId(undefined)).toBe("UNKNOWN");
  });
});

describe("prices as integer cents", () => {
  it("reads the strings the feed sends", () => {
    expect(priceToCents("4.0")).toBe(400);
    expect(priceToCents("64.85")).toBe(6485);
    expect(priceToCents("1.38")).toBe(138);
    expect(priceToCents("10.0")).toBe(1000);
  });

  it("returns null rather than zero for anything unreadable", () => {
    // Zero is a price. "I could not read it" is not, and the two must never
    // arrive at a comparison looking the same.
    expect(priceToCents(null)).toBeNull();
    expect(priceToCents("")).toBeNull();
    expect(priceToCents("2/$5")).toBeNull();
    expect(priceToCents("gratuit")).toBeNull();
  });
});

describe("size, out of the name, or not at all", () => {
  it("finds a single printed size", () => {
    expect(sizeFromName("BOUILLON À FONDUE CANTON | FONDUE BROTH, 1 L").size).toBe("1 L");
    expect(sizeFromName("MARGARINE PC MENU BLEU, 907 g").size).toBe("907 g");
    expect(sizeFromName("TOMATES RAISINS DÉLICES DU MARCHÉ | grape tomatoes, 283 g").size)
      .toBe("283 g");
  });

  it("refuses a RANGE, which is the case a naive regex gets wrong", () => {
    /*
      "110-150 G" covers several packs. Taking "110" from it produces a
      confident size for a product that may be any of them, and every match in
      this app rests on size agreeing. Five of twenty-five Maxi rows were
      ranges, so this is not a corner case.
    */
    const bars = sizeFromName("BARRES ... MADE GOOD, 110-150 G");
    expect(bars.size).toBeNull();
    expect(bars.ambiguous).toBe(true);

    expect(sizeFromName("SOINS CAPILLAIRES HEAD & SHOULDERS | HAIR CARE, 315-370 ML").ambiguous)
      .toBe(true);
    expect(sizeFromName("MICRO CROISSANTS LA PETITE BRETONNE, 320-400 G").ambiguous).toBe(true);
  });

  it("refuses a tile listing alternative sizes", () => {
    // One row, one price, three different packs.
    const cheese = sizeFromName(
      "FROMAGE EN BARRE SAPUTO MOZZARELLISSIMA, 500 G OU 400 G OU RÂPÉ, 320 G PC",
    );
    expect(cheese.size).toBeNull();
    expect(cheese.ambiguous).toBe(true);
  });

  it("says nothing rather than something when there is no size", () => {
    const yams = sizeFromName("PATATES DOUCES JAPONAISES | JAPANESE SWEET YAMS");
    expect(yams.size).toBeNull();
    expect(yams.ambiguous).toBe(false); // absent, not ambiguous — different facts
  });
});

describe("tiles advertising several products at one price", () => {
  it("splits the brands the feed joins with a pipe", () => {
    expect(brandsFrom("SAPUTO | PC")).toEqual(["SAPUTO", "PC"]);
    expect(brandsFrom("TROPICANA | LAIT'S GO")).toEqual(["TROPICANA", "LAIT'S GO"]);
    expect(brandsFrom("Made Good")).toEqual(["Made Good"]);
    expect(brandsFrom(null)).toEqual([]);
  });

  it("handles the seven-brand beer row without falling over", () => {
    const beers = brandsFrom(
      "COORS LIGHT | BUD LIGHT | BUDWEISER | MILLER LITE | MOLSON DRY | EXPORT | ULTRA",
    );
    expect(beers).toHaveLength(7);
  });
});

describe("normalising a whole flyer", () => {
  // Verbatim rows from flyer 8073211 (Maxi) and 8072235 (Adonis).
  const maxi = [
    {
      id: 1032541816,
      flyer_id: 8073211,
      name: "BARRES, BISCUITS ... MADE GOOD, 110-150 G",
      brand: "Made Good",
      price: "2.28",
      print_id: "21351847_EA",
      discount: null,
      cutout_image_url: "http://f.wishabi.net/page_items/430361849/1786480242/extra_large.jpg",
      valid_from: "2026-08-13T00:00:00-04:00",
      valid_to: "2026-08-19T23:59:59-04:00",
    },
    {
      id: 1031722566,
      flyer_id: 8073211,
      name: "PATATES DOUCES JAPONAISES | JAPANESE SWEET YAMS",
      brand: null,
      price: "2.49",
      print_id: "20524922001_KG",
      discount: null,
      valid_from: "2026-08-13T00:00:00-04:00",
      valid_to: "2026-08-19T23:59:59-04:00",
    },
    {
      id: 1032541772,
      flyer_id: 8073211,
      name: "BOISSON AUX FRUITS SANS NOM®, 2 L",
      brand: "sans nom®",
      price: "1.5",
      print_id: "20320439003_EA",
      discount: 25,
      valid_from: "2026-08-13T00:00:00-04:00",
      valid_to: "2026-08-19T23:59:59-04:00",
    },
  ];

  it("keeps what it can state and says what it dropped", () => {
    const { offers, rejected } = normaliseFlyerItems(maxi, "Maxi", 8073211);
    expect(offers).toHaveLength(3);
    expect(Object.values(rejected).every((n) => n === 0)).toBe(true);
  });

  it("carries the unit through, so a per-kilo price stays per-kilo", () => {
    const { offers } = normaliseFlyerItems(maxi, "Maxi", 8073211);
    const yams = offers.find((o) => o.advertisedText.includes("PATATES"))!;
    expect(yams.basis).toBe("PER_KG");
    expect(yams.priceCents).toBe(249);
  });

  it("marks the range row as size-ambiguous rather than inventing 110 g", () => {
    const { offers } = normaliseFlyerItems(maxi, "Maxi", 8073211);
    const bars = offers.find((o) => o.advertisedText.includes("MADE GOOD"))!;
    expect(bars.size).toBeNull();
    expect(bars.sizeAmbiguous).toBe(true);
  });

  it("keeps the discount percentage, which survives the price ambiguity", () => {
    const { offers } = normaliseFlyerItems(maxi, "Maxi", 8073211);
    expect(offers.find((o) => o.advertisedText.includes("SANS NOM"))!.discountPercent).toBe(25);
  });

  it("upgrades the image URL to https", () => {
    const { offers } = normaliseFlyerItems(maxi, "Maxi", 8073211);
    expect(offers[0]!.imageUrl!.startsWith("https://")).toBe(true);
  });

  it("counts every row it refused, by reason", () => {
    const messy = [
      { id: 1, name: null, price: "4.0", valid_from: "2026-08-13T00:00:00-04:00", valid_to: "2026-08-19T23:59:59-04:00" },
      { id: 2, name: "Something", price: null, valid_from: "2026-08-13T00:00:00-04:00", valid_to: "2026-08-19T23:59:59-04:00" },
      { id: 3, name: "Something else", price: "1.0" },
      "not a record",
    ];
    const { offers, rejected } = normaliseFlyerItems(messy, "Maxi", 8073211);
    expect(offers).toHaveLength(0);
    expect(rejected["no-name"]).toBe(1);
    expect(rejected["no-price"]).toBe(1);
    expect(rejected["no-dates"]).toBe(1);
    expect(rejected["not-a-record"]).toBe(1);
  });

  it("drops the whole flyer when the banner is not one of ours", () => {
    const { offers, rejected } = normaliseFlyerItems(maxi, "T&T Supermarket", 8082480);
    expect(offers).toHaveLength(0);
    expect(rejected["unknown-merchant"]).toBe(3);
  });
});

describe("the Tropicana row — why every offer here is condition-unknown", () => {
  /*
    This exact item, from two endpoints on the same day:

      flyer  : price "4.0", discount 19, print_id null, text_areas []
      search : current_price 4, pre_price_text "2/",
               post_price_text "OU 2,49$/L'UNITÉ"

    It is TWO FOR $4 — $2.49 each. The flyer endpoint contains nothing that
    says so. If this module ever emits an offer that can be subtracted from
    something, that $4.00 becomes a unit price and the app states a number
    60% above the truth.
  */
  const adonis = [
    {
      id: 1031569911,
      flyer_id: 8072235,
      name: "BOISSON REFRIGÉRÉE TROPICANA OU LAIT LAIT'S GO | TROPICANA REFRIGERATED DRINK OR MILK 2GO MILK",
      brand: "TROPICANA | LAIT'S GO",
      price: "4.0",
      print_id: null,
      discount: 19,
      cutout_image_url: "http://f.wishabi.net/page_items/429796306/1786013989/extra_large.jpg",
      valid_from: "2026-08-13T00:00:00-04:00",
      valid_to: "2026-08-19T23:59:59-04:00",
    },
  ];

  const [offer] = normaliseFlyerItems(adonis, "Adonis", 8072235).offers;

  it("is emitted, because 'on sale at Adonis' is true", () => {
    expect(offer).toBeDefined();
    expect(offer!.retailerId).toBe("adonis");
    expect(offer!.priceCents).toBe(400);
  });

  it("is condition-unknown, always, for this source", () => {
    expect(offer!.conditionUnknown).toBe(true);
  });

  it("has no basis, because Adonis publishes no print_id", () => {
    expect(offer!.basis).toBe("UNKNOWN");
  });

  it("is flagged as advertising more than one product", () => {
    expect(offer!.multiProduct).toBe(true);
    expect(offer!.brand).toBeNull(); // no single brand can be claimed
    expect(offer!.brands).toEqual(["TROPICANA", "LAIT'S GO"]);
  });

  it("keeps the 19%, which is true whichever quantity the price is for", () => {
    expect(offer!.discountPercent).toBe(19);
  });
});
