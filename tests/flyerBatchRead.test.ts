/**
 * Reading several pages in one request.
 *
 * The saving is requests, not work — but it costs the one property the
 * single-page parser had for free. That parser never asks which page it read,
 * because the app knows what it sent and a page number is exactly the kind of
 * fact a model will helpfully invent. A batch has to tell its groups apart
 * somehow, so the labels come back from the model and are CHECKED rather than
 * trusted.
 *
 * Everything below is that check. An offer filed under the wrong page number
 * looks entirely normal and sends somebody to a page that does not carry the
 * product, which at a price-match desk is worse than no page at all.
 */

import { describe, expect, it } from "vitest";

import { parseFlyerBatch } from "@shared/parseOffers";

function offer(text: string, dollars: number, cents: number) {
  return {
    advertisedText: text,
    priceDollars: dollars,
    priceCents: cents,
    basis: "PER_ITEM",
    condition: "UNIT_PRICE",
  };
}

function group(pageNumber: number, texts: string[]) {
  return {
    pageNumber,
    offers: texts.map((t, i) => offer(t, 3 + i, 99)),
  };
}

describe("a reply that lines up", () => {
  it("files each page's offers under that page", () => {
    const { byPage, error } = parseFlyerBatch(
      { pages: [group(4, ["Lait 2%"]), group(5, ["Bœuf haché", "Pain"])] },
      [4, 5],
    );

    expect(error).toBeNull();
    expect(byPage.get(4)!.offers).toHaveLength(1);
    expect(byPage.get(5)!.offers).toHaveLength(2);
    expect(byPage.get(4)!.offers[0]!.pageNumber).toBe(4);
    expect(byPage.get(5)!.offers[0]!.pageNumber).toBe(5);
  });

  it("accepts the groups in an order of their own", () => {
    // Reordering is safe precisely because the label is checked. Position
    // alone would have silently swapped these two pages' offers.
    const { byPage, error } = parseFlyerBatch(
      { pages: [group(9, ["Fromage"]), group(7, ["Poulet"])] },
      [7, 9],
    );

    expect(error).toBeNull();
    expect(byPage.get(7)!.offers[0]!.advertisedText).toBe("Poulet");
    expect(byPage.get(9)!.offers[0]!.advertisedText).toBe("Fromage");
  });

  it("keeps a page that genuinely carried nothing", () => {
    // A back cover with no offers is a real answer, and different from a page
    // the model skipped — which is why the schema demands an entry either way.
    const { byPage, error } = parseFlyerBatch(
      { pages: [group(1, ["Lait"]), { pageNumber: 2, offers: [] }] },
      [1, 2],
    );

    expect(error).toBeNull();
    expect(byPage.get(2)!.offers).toHaveLength(0);
  });
});

describe("a reply that does not line up is refused whole", () => {
  // Partial acceptance is the dangerous case: the pages that did align look
  // perfect, and the misfiled ones are indistinguishable from correct data.

  it("refuses a batch missing a page", () => {
    const { byPage, error } = parseFlyerBatch({ pages: [group(4, ["Lait"])] }, [4, 5]);
    expect(error).toMatch(/covered 1 pages; 2 were sent/);
    expect(byPage.size).toBe(0);
  });

  it("refuses a page label nobody sent", () => {
    const { byPage, error } = parseFlyerBatch(
      { pages: [group(4, ["Lait"]), group(6, ["Pain"])] },
      [4, 5],
    );
    expect(error).toMatch(/labelled a page 6, which was not sent/);
    expect(byPage.size).toBe(0);
  });

  it("refuses the same page twice", () => {
    // Two groups for page 4 means one of them is really page 5, and there is
    // no way to tell which.
    const { byPage, error } = parseFlyerBatch(
      { pages: [group(4, ["Lait"]), group(4, ["Pain"])] },
      [4, 5],
    );
    expect(error).toMatch(/labelled page 4 twice/);
    expect(byPage.size).toBe(0);
  });

  it("refuses a group with no whole-number label", () => {
    const { byPage, error } = parseFlyerBatch(
      { pages: [group(4, ["Lait"]), { pageNumber: "five", offers: [] }] },
      [4, 5],
    );
    expect(error).toMatch(/no whole-number page label/);
    expect(byPage.size).toBe(0);
  });

  it("refuses a reply with no pages list at all", () => {
    const { error } = parseFlyerBatch({ offers: [] }, [4, 5]);
    expect(error).toMatch(/no list of pages/);
  });
});

describe("the per-offer rules still apply inside a batch", () => {
  it("drops an offer the single-page parser would drop", () => {
    // One parser, one set of rules. A batch must not become a way for a price
    // to reach a cashier that could not have reached one on its own.
    const { byPage, error } = parseFlyerBatch(
      {
        pages: [
          {
            pageNumber: 3,
            offers: [
              offer("Lait 2%", 4, 99),
              // 199 cents is not a cents field; the single-page parser rejects
              // it rather than reading it as $1.99.
              { ...offer("Pain", 2, 199) },
            ],
          },
        ],
      },
      [3],
    );

    expect(error).toBeNull();
    expect(byPage.get(3)!.offers).toHaveLength(1);
    expect(byPage.get(3)!.rejected).toHaveLength(1);
  });
});
