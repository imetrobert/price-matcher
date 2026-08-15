/**
 * When a saved cart stops being worth keeping.
 *
 * The rule is the point of the feature: every number in a saved cart came from
 * a flyer that runs for a week, and the day after that week ends none of those
 * numbers is a price. A history screen full of confident, expired figures is
 * exactly the failure this project designs against, so the expiry is pinned
 * here rather than trusted to a comment.
 */

import { describe, expect, it } from "vitest";

import { cartIsCurrent, cartValidTo, type SavedCart } from "@/services/carts/history";
import type { CartComparison } from "@/services/flyers/cartMatch";
import type { StoredOffer } from "@/services/flyers/storage";
import type { RetailerId } from "@/types";

function offer(validTo: string, id = "o1"): StoredOffer {
  return {
    id,
    flyerId: "maxi-2026-08-13",
    retailerId: "maxi" as RetailerId,
    advertisedText: "Lait 2% 2 L",
    brand: "Lactantia",
    size: "2 L",
    retailerSku: null,
    price: 599,
    basis: "PER_ITEM",
    regularPrice: null,
    regularBasis: null,
    condition: "UNIT_PRICE",
    conditionText: null,
    flyerPage: 3,
    confirmedAt: null,
    box: null,
    rejectedAt: null,
    validFrom: "2026-08-13",
    validTo,
  };
}

function comparison(offers: StoredOffer[]): CartComparison {
  const line = {
    item: { id: "i1" },
    outcome: "CHEAPER_ELSEWHERE",
    hereOffer: null,
    bestElsewhere: offers[0] ?? null,
    yourPriceCents: null,
    yourPriceSource: null,
    savingCents: null,
    matches: offers,
    measuredMatches: [],
    measuredElsewhere: [],
  };
  return {
    lines: offers.length > 0 ? [line] : [],
    notInFlyers: [],
    bestHere: [],
    cheaperElsewhere: [],
    onSaleElsewhere: [],
    totalSavingCents: 0,
    offersConsidered: offers.length,
  } as unknown as CartComparison;
}

function cart(patch: Partial<SavedCart> = {}): SavedCart {
  return {
    id: "c1",
    at: "2026-08-15T12:00:00.000Z",
    retailerId: "maxi" as RetailerId,
    validTo: "2026-08-19",
    comparison: comparison([offer("2026-08-19")]),
    ...patch,
  };
}

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe("the last day a cart's prices are true", () => {
  it("is the latest flyer behind it, not the day it was scanned", () => {
    // Two flyers running to different days. The cart is only finished when the
    // last of them is.
    expect(
      cartValidTo(comparison([offer("2026-08-19", "a"), offer("2026-08-22", "b")])),
    ).toBe("2026-08-22");
  });

  it("counts weight-priced matches too", () => {
    const c = comparison([offer("2026-08-19")]);
    c.lines[0]!.measuredMatches = [offer("2026-08-25", "kg")];
    expect(cartValidTo(c)).toBe("2026-08-25");
  });

  it("is null when nothing matched at all", () => {
    expect(cartValidTo(comparison([]))).toBeNull();
  });
});

describe("expiring with the flyers", () => {
  it("keeps a cart on the last day its flyer runs", () => {
    // The 19th is still a day the price is printed for. Deleting it that
    // morning would throw away a cart somebody could still act on.
    expect(cartIsCurrent(cart(), day("2026-08-19"))).toBe(true);
  });

  it("drops it the day after", () => {
    expect(cartIsCurrent(cart(), day("2026-08-20"))).toBe(false);
  });

  it("keeps one scanned today, obviously", () => {
    expect(cartIsCurrent(cart(), day("2026-08-15"))).toBe(true);
  });

  it("gives a cart that matched nothing a week from its scan", () => {
    // No flyer behind it means no expiry to read. A week is long enough to
    // look at and short enough not to pile up.
    const none = cart({ validTo: null });
    expect(cartIsCurrent(none, day("2026-08-20"))).toBe(true);
    expect(cartIsCurrent(none, day("2026-08-22"))).toBe(true);
    expect(cartIsCurrent(none, day("2026-08-23"))).toBe(false);
  });

  it("drops a cart whose date cannot be read", () => {
    // A record nobody can date is a record nobody can trust to expire, and
    // keeping it forever is the one outcome this feature must not have.
    expect(cartIsCurrent(cart({ validTo: null, at: "not a date" }))).toBe(false);
  });
});
