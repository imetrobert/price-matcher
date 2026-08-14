import { describe, expect, it } from "vitest";

import {
  distinctiveTerms,
  findPriceEvidence,
  verifyExtractedOffer,
  verifyExtraction,
} from "@/services/flyers/pdf/verify";
import { toFlyerOffers } from "@/services/flyers/pdf/toOffers";
import type {
  ExtractedOffer,
  FlyerPdfDocument,
  FlyerPdfPage,
} from "@/services/flyers/pdf/types";
import { offerCanSupportCheckoutProof } from "@/types/flyer";

function offer(overrides: Partial<ExtractedOffer> = {}): ExtractedOffer {
  return {
    advertisedText: "Oikos Greek yogurt plain 0% 650 g",
    brand: "Oikos",
    size: "650 g",
    retailerSku: null,
    price: 749,
    currency: "CAD",
    basis: "PER_ITEM",
    regularPrice: 849,
    condition: "UNIT_PRICE",
    conditionText: null,
    pageNumber: 3,
    ...overrides,
  };
}

function page(text: string, pageNumber = 3): FlyerPdfPage {
  return { pageNumber, text };
}

/** Long enough to count as a real text layer in every fixture below. */
const FILLER =
  " Circulaire valide du 14 au 20 aout. Certaines conditions sapplicent. ";

describe("findPriceEvidence", () => {
  it("finds a price written the way an English flyer writes it", () => {
    expect(findPriceEvidence(749, `${FILLER} oikos yogourt $7.49 each`)).toBe(
      "EXACT",
    );
  });

  it("finds a price written the way a Quebec flyer writes it", () => {
    // Narrow no-break space before the dollar sign, as French typography sets it.
    expect(findPriceEvidence(749, `${FILLER} yogourt oikos 7,49 $`)).toBe(
      "EXACT",
    );
  });

  it("grades superscript-cents typesetting as weaker evidence", () => {
    expect(findPriceEvidence(749, `${FILLER} oikos 7 49 650 g`)).toBe(
      "SPLIT_DIGITS",
    );
    expect(findPriceEvidence(749, `${FILLER} oikos 749 650 g`)).toBe(
      "SPLIT_DIGITS",
    );
  });

  it("does not match a price hiding inside a longer number", () => {
    expect(findPriceEvidence(749, `${FILLER} article 17.49 reference`)).toBe(
      "NOT_IN_TEXT",
    );
    expect(findPriceEvidence(749, `${FILLER} lot 7.4999 code`)).toBe(
      "NOT_IN_TEXT",
    );
  });

  it("reports an image-only page as having nothing to check", () => {
    expect(findPriceEvidence(749, "3")).toBe("NO_TEXT_LAYER");
  });
});

describe("distinctiveTerms", () => {
  it("drops boilerplate and short words in both languages", () => {
    expect(distinctiveTerms("Save on selected varieties with each pack")).toEqual(
      [],
    );
    expect(distinctiveTerms("Certaines variétés assorties, limite 4")).toEqual(
      [],
    );
  });

  it("keeps the words that tell one tile from the next", () => {
    expect(distinctiveTerms("Oikos Greek yogurt plain 650 g").sort()).toEqual([
      "greek",
      "oikos",
      "plain",
      "yogurt",
    ]);
  });

  it("folds accents so the artwork and the text layer agree", () => {
    expect(distinctiveTerms("Yogourt grec Oikos")).toContain("yogourt");
    expect(distinctiveTerms("Épicerie")).toContain("epicerie");
  });
});

describe("verifyExtractedOffer", () => {
  it("confirms when the page's own text carries both the price and the product", () => {
    const result = verifyExtractedOffer(
      offer(),
      page(`${FILLER} Oikos yogourt grec nature 0% 650 g $7.49`),
    );
    expect(result.verdict).toBe("CONFIRMED");
    expect(result.priceEvidence).toBe("EXACT");
    expect(result.matchedTerms).toContain("oikos");
  });

  it("rejects a price the readable page does not contain", () => {
    const result = verifyExtractedOffer(
      offer({ price: 599 }),
      page(`${FILLER} Oikos yogourt grec nature 0% 650 g $7.49`),
    );
    expect(result.verdict).toBe("REJECTED");
    expect(result.priceEvidence).toBe("NOT_IN_TEXT");
  });

  it("rejects a real price attached to the wrong product", () => {
    const result = verifyExtractedOffer(
      offer(),
      page(`${FILLER} Cheerios cereal family size $7.49`),
    );
    expect(result.verdict).toBe("REJECTED");
    expect(result.reason).toContain("Oikos");
  });

  it("sends an image-only page to a person rather than trusting or dropping it", () => {
    const result = verifyExtractedOffer(offer(), page("3"));
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.priceEvidence).toBe("NO_TEXT_LAYER");
  });

  it("sends superscript-cents typesetting to a person", () => {
    const result = verifyExtractedOffer(
      offer(),
      page(`${FILLER} Oikos yogourt grec nature 650 g 7 49`),
    );
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.priceEvidence).toBe("SPLIT_DIGITS");
  });

  it("refuses to check an offer against a page it did not come from", () => {
    const result = verifyExtractedOffer(offer({ pageNumber: 4 }), page("x", 3));
    expect(result.verdict).toBe("REJECTED");
  });
});

describe("verifyExtraction", () => {
  it("reports the honest split, not just a count of offers found", () => {
    const pages = [
      page(`${FILLER} Oikos yogourt grec 650 g $7.49`, 3),
      page("4", 4),
      page(`${FILLER} Pain tranché Bon Matin $2.99`, 5),
    ];
    const { summary } = verifyExtraction(
      [
        offer(),
        offer({ pageNumber: 4 }),
        offer({
          advertisedText: "Bon Matin sliced bread",
          brand: "Bon Matin",
          price: 299,
          pageNumber: 5,
        }),
        offer({ price: 199, pageNumber: 5 }),
        offer({ pageNumber: 99 }),
      ],
      pages,
    );

    expect(summary).toEqual({
      confirmed: 2,
      needsReview: 1,
      rejected: 2,
      unreadablePages: [4],
    });
  });
});

describe("toFlyerOffers", () => {
  const document: FlyerPdfDocument = {
    retailerId: "iga",
    validity: { startsAt: "2026-08-14", endsAt: "2026-08-20" },
    documentRef: "flyer/iga-2026-08-14",
    storeId: null,
    pageCount: 12,
  };

  it("passes confirmed offers through and holds back unreviewed ones", () => {
    const offers = toFlyerOffers(
      document,
      [
        {
          offer: offer(),
          verification: {
            verdict: "CONFIRMED",
            priceEvidence: "EXACT",
            matchedTerms: ["oikos"],
            reason: "",
          },
          review: "PENDING",
        },
        {
          offer: offer({ pageNumber: 4 }),
          verification: {
            verdict: "NEEDS_REVIEW",
            priceEvidence: "NO_TEXT_LAYER",
            matchedTerms: [],
            reason: "",
          },
          review: "PENDING",
        },
      ],
      "2026-08-13T12:00:00.000Z",
    );

    expect(offers).toHaveLength(1);
    expect(offers[0].price).toBe(749);
    expect(offers[0].source).toBe("FLYER_PDF");
    expect(offers[0].flyerPage).toBe(3);
  });

  it("lets a person's acceptance stand in for a check the page could not give", () => {
    const offers = toFlyerOffers(
      document,
      [
        {
          offer: offer({ pageNumber: 4 }),
          verification: {
            verdict: "NEEDS_REVIEW",
            priceEvidence: "NO_TEXT_LAYER",
            matchedTerms: [],
            reason: "",
          },
          review: "ACCEPTED",
        },
      ],
      "2026-08-13T12:00:00.000Z",
    );
    expect(offers).toHaveLength(1);
  });

  it("never lets a tap overturn the document", () => {
    const offers = toFlyerOffers(
      document,
      [
        {
          offer: offer(),
          verification: {
            verdict: "REJECTED",
            priceEvidence: "NOT_IN_TEXT",
            matchedTerms: [],
            reason: "",
          },
          review: "ACCEPTED",
        },
      ],
      "2026-08-13T12:00:00.000Z",
    );
    expect(offers).toEqual([]);
  });

  it("gives the same flyer the same ids, so a re-import corrects instead of duplicating", () => {
    const items = [
      {
        offer: offer(),
        verification: {
          verdict: "CONFIRMED" as const,
          priceEvidence: "EXACT" as const,
          matchedTerms: ["oikos"],
          reason: "",
        },
        review: "PENDING" as const,
      },
    ];
    const first = toFlyerOffers(document, items, "2026-08-13T12:00:00.000Z");
    const second = toFlyerOffers(document, items, "2026-08-14T12:00:00.000Z");
    expect(first[0].id).toBe(second[0].id);
  });

  it("produces an offer a stored flyer page is enough to prove at the till", () => {
    const [built] = toFlyerOffers(
      document,
      [
        {
          offer: offer(),
          verification: {
            verdict: "CONFIRMED",
            priceEvidence: "EXACT",
            matchedTerms: ["oikos"],
            reason: "",
          },
          review: "PENDING",
        },
      ],
      "2026-08-13T12:00:00.000Z",
    );
    expect(built.flyerUrl).toBeNull();
    expect(offerCanSupportCheckoutProof(built)).toBe(true);
  });

  it("still refuses an offer whose flyer never printed an end date", () => {
    const [built] = toFlyerOffers(
      { ...document, validity: { startsAt: "2026-08-14", endsAt: null } },
      [
        {
          offer: offer(),
          verification: {
            verdict: "CONFIRMED",
            priceEvidence: "EXACT",
            matchedTerms: ["oikos"],
            reason: "",
          },
          review: "PENDING",
        },
      ],
      "2026-08-13T12:00:00.000Z",
    );
    expect(offerCanSupportCheckoutProof(built)).toBe(false);
  });
});
