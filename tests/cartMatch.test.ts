/**
 * A cart against this week's flyers.
 *
 * Three answers per item, and the boundaries between them are the feature: a
 * shopper acts on exactly one of the three, and the other two exist so that
 * "nothing to do here" is said out loud rather than left as silence.
 */

import { describe, expect, it } from "vitest";

import {
  compareCartToFlyers,
  needsConfirming,
  itemLabel,
  type CartLine,
} from "@/services/flyers/cartMatch";
import type { StoredOffer } from "@/services/flyers/storage";
import type { DetectedProduct, RetailerId } from "@/types";

function item(patch: Partial<DetectedProduct> = {}): DetectedProduct {
  return {
    id: "i1",
    brand: "Lactantia",
    productName: "Lait 2%",
    variant: null,
    fatPercentage: null,
    size: "2 L",
    packageQuantity: 1,
    visibleUpc: null,
    language: "fr",
    manufacturer: null,
    productType: null,
    notes: null,
    confidence: 0.95,
    isMock: false,
    userConfirmed: false,
    ...patch,
  };
}

function offer(patch: Partial<StoredOffer> = {}): StoredOffer {
  return {
    id: "o1",
    flyerId: "maxi-2026-08-13",
    retailerId: "maxi" as RetailerId,
    advertisedText: "Lait 2%",
    brand: "Lactantia",
    size: "2 L",
    retailerSku: null,
    price: 599,
    basis: "PER_ITEM",
    regularPrice: null,
    regularBasis: null,
    condition: "UNIT_PRICE",
    conditionText: null,
    flyerPage: 4,
    confirmedAt: null,
    rejectedAt: null,
    validFrom: "2026-08-13",
    validTo: "2026-08-19",
    ...patch,
  };
}

describe("not in any flyer", () => {
  it("is the answer when nobody advertised it", () => {
    const cart = compareCartToFlyers([item()], [], "iga" as RetailerId);
    expect(cart.notInFlyers).toHaveLength(1);
    expect(cart.lines[0]!.savingCents).toBeNull();
  });

  it("does not become a match on a loose resemblance", () => {
    // Same category, different product. Pairing a trolley photograph to a
    // flyer tile on token overlap would stack one inference on another and
    // present the result at a till as fact.
    const cart = compareCartToFlyers(
      [item({ brand: "Lactantia", productName: "Lait 2%", size: "2 L" })],
      [offer({ brand: "Natrel", advertisedText: "Lait 3.25%", size: "1 L" })],
      "iga" as RetailerId,
    );
    expect(cart.notInFlyers).toHaveLength(1);
  });
});

describe("best where you are standing", () => {
  it("says so when your shop's price is not beaten", () => {
    const cart = compareCartToFlyers(
      [item()],
      [
        offer({ id: "a", retailerId: "iga" as RetailerId, price: 399 }),
        offer({ id: "b", retailerId: "maxi" as RetailerId, price: 599 }),
      ],
      "iga" as RetailerId,
    );
    expect(cart.bestHere).toHaveLength(1);
    expect(cart.bestHere[0]!.hereOffer!.price).toBe(399);
    expect(cart.cheaperElsewhere).toHaveLength(0);
  });

  it("counts a tie as best here, not as a saving of nothing", () => {
    const cart = compareCartToFlyers(
      [item()],
      [
        offer({ id: "a", retailerId: "iga" as RetailerId, price: 499 }),
        offer({ id: "b", retailerId: "maxi" as RetailerId, price: 499 }),
      ],
      "iga" as RetailerId,
    );
    expect(cart.bestHere).toHaveLength(1);
  });

  it("is not a comparison when only your own shop advertised it", () => {
    const cart = compareCartToFlyers(
      [item()],
      [offer({ retailerId: "iga" as RetailerId, price: 399 })],
      "iga" as RetailerId,
    );
    expect(cart.bestHere).toHaveLength(1);
    expect(cart.bestHere[0]!.bestElsewhere).toBeNull();
  });
});

describe("cheaper somewhere else", () => {
  it("reports the gap in integer cents", () => {
    const cart = compareCartToFlyers(
      [item()],
      [
        offer({ id: "a", retailerId: "iga" as RetailerId, price: 599 }),
        offer({ id: "b", retailerId: "maxi" as RetailerId, price: 399 }),
      ],
      "iga" as RetailerId,
    );
    expect(cart.cheaperElsewhere).toHaveLength(1);
    expect(cart.cheaperElsewhere[0]!.savingCents).toBe(200);
    expect(cart.totalSavingCents).toBe(200);
  });

  it("quotes no saving when your own shop did not advertise it", () => {
    // The shelf price of an unadvertised product is not in this app, and a
    // competitor's sale price is no basis for guessing it. Still worth
    // showing; not worth a number.
    const cart = compareCartToFlyers(
      [item()],
      [offer({ retailerId: "maxi" as RetailerId, price: 399 })],
      "iga" as RetailerId,
    );
    expect(cart.cheaperElsewhere).toHaveLength(1);
    expect(cart.cheaperElsewhere[0]!.savingCents).toBeNull();
    expect(cart.totalSavingCents).toBe(0);
  });

  it("picks the cheapest competitor, not the first", () => {
    const cart = compareCartToFlyers(
      [item()],
      [
        offer({ id: "a", retailerId: "iga" as RetailerId, price: 599 }),
        offer({ id: "b", retailerId: "maxi" as RetailerId, price: 499 }),
        offer({ id: "c", retailerId: "superc" as RetailerId, price: 429 }),
      ],
      "iga" as RetailerId,
    );
    expect(cart.cheaperElsewhere[0]!.bestElsewhere!.price).toBe(429);
    expect(cart.cheaperElsewhere[0]!.savingCents).toBe(170);
  });
});

describe("units are never subtracted from each other", () => {
  it("keeps a per-pound price out of the arithmetic", () => {
    // $3.62/lb against $5.99 each is not a saving of $2.37.
    const cart = compareCartToFlyers(
      [item()],
      [
        offer({ id: "a", retailerId: "iga" as RetailerId, price: 599 }),
        offer({ id: "b", retailerId: "maxi" as RetailerId, price: 362, basis: "PER_LB" }),
      ],
      "iga" as RetailerId,
    );
    expect(cart.bestHere).toHaveLength(1);
    expect(cart.lines[0]!.measuredMatches).toHaveLength(1);
    expect(cart.lines[0]!.savingCents).toBeNull();
  });

  it("still shows a weight price as information", () => {
    const cart = compareCartToFlyers(
      [item()],
      [offer({ retailerId: "maxi" as RetailerId, price: 362, basis: "PER_KG" })],
      "iga" as RetailerId,
    );
    // Nothing per-item to compare, so no action — but the reading is kept.
    expect(cart.notInFlyers).toHaveLength(1);
    expect(cart.lines[0]!.measuredMatches).toHaveLength(1);
  });
});

describe("conditional prices follow the deals screen's rule", () => {
  it("ignores a card price unless asked", () => {
    const offers = [
      offer({ id: "a", retailerId: "iga" as RetailerId, price: 599 }),
      offer({
        id: "b",
        retailerId: "maxi" as RetailerId,
        price: 399,
        condition: "LOYALTY_ONLY",
        conditionText: "avec carte",
      }),
    ];
    expect(compareCartToFlyers([item()], offers, "iga" as RetailerId).cheaperElsewhere).toHaveLength(0);
    expect(
      compareCartToFlyers([item()], offers, "iga" as RetailerId, {
        includeConditional: true,
      }).cheaperElsewhere,
    ).toHaveLength(1);
  });

  it("never lets a multi-buy in", () => {
    const offers = [
      offer({ id: "a", retailerId: "iga" as RetailerId, price: 399 }),
      offer({
        id: "b",
        retailerId: "maxi" as RetailerId,
        price: 500,
        condition: "MULTI_BUY",
        conditionText: "2 pour 5$",
      }),
    ];
    const cart = compareCartToFlyers([item()], offers, "iga" as RetailerId, {
      includeConditional: true,
    });
    expect(cart.cheaperElsewhere).toHaveLength(0);
  });
});

describe("which readings need a human", () => {
  it("flags a low-confidence reading", () => {
    expect(needsConfirming(item({ confidence: 0.4 }))).toBe(true);
  });

  it("flags an item whose name could not be read at all", () => {
    expect(needsConfirming(item({ productName: null, confidence: 0.99 }))).toBe(true);
  });

  it("stops flagging once a person has touched it", () => {
    expect(
      needsConfirming(item({ confidence: 0.2, userConfirmed: true })),
    ).toBe(false);
  });

  it("leaves a confident reading alone", () => {
    expect(needsConfirming(item({ confidence: 0.95 }))).toBe(false);
  });
});

describe("naming an item in a list", () => {
  it("uses whatever the camera managed to read", () => {
    expect(itemLabel(item())).toBe("Lactantia Lait 2% 2 L");
  });

  it("says so when it read nothing", () => {
    expect(
      itemLabel(item({ brand: null, productName: null, size: null })),
    ).toBe("Unidentified item");
  });
});

describe("what may be shown to a cashier", () => {
  // Mirrors the gate in /checkout. Kept here because it is a claim about the
  // data, not about a screen: a match with no computable gap, a conditional
  // price, or no page behind it must not reach a till whatever renders it.

  const gate = (line: CartLine) =>
    line.savingCents !== null &&
    line.bestElsewhere !== null &&
    line.hereOffer !== null &&
    line.bestElsewhere.condition === "UNIT_PRICE";

  it("admits a gap between two advertised prices", () => {
    const cart = compareCartToFlyers(
      [item()],
      [
        offer({ id: "a", retailerId: "iga" as RetailerId, price: 599 }),
        offer({ id: "b", retailerId: "maxi" as RetailerId, price: 399 }),
      ],
      "iga" as RetailerId,
    );
    expect(gate(cart.cheaperElsewhere[0]!)).toBe(true);
  });

  it("refuses one where your own shop never advertised the product", () => {
    // Nothing to subtract from. The results screen still shows it; a till is
    // not the place to explain that the gap is unknown.
    const cart = compareCartToFlyers(
      [item()],
      [offer({ retailerId: "maxi" as RetailerId, price: 399 })],
      "iga" as RetailerId,
    );
    expect(cart.cheaperElsewhere).toHaveLength(1);
    expect(gate(cart.cheaperElsewhere[0]!)).toBe(false);
  });

  it("refuses a card price even when it was opted into", () => {
    const cart = compareCartToFlyers(
      [item()],
      [
        offer({ id: "a", retailerId: "iga" as RetailerId, price: 599 }),
        offer({
          id: "b",
          retailerId: "maxi" as RetailerId,
          price: 399,
          condition: "LOYALTY_ONLY",
          conditionText: "avec carte",
        }),
      ],
      "iga" as RetailerId,
      { includeConditional: true },
    );
    expect(cart.cheaperElsewhere).toHaveLength(1);
    expect(gate(cart.cheaperElsewhere[0]!)).toBe(false);
  });
});
