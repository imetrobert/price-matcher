# Flyer PDF import

Loading a week's advertised prices from a flyer PDF the shopper already
received, so a cart photo can be checked against it.

## Why this route exists

Every fetch-based route has been measured and refused:

| Source | Result |
| --- | --- |
| Maxi product page | HTTP 403 to a datacenter request |
| IGA product page | HTTP 403 to a datacenter request |
| IGA search | offers are not in the page HTML at all |
| Flipp item page | HTTP 200, 41 KB, no offer data — Angular app shell |
| Retailer APIs | none published by any Canadian grocer |
| Licensed feeds | enterprise CPG panels, wrong product, $75k+/yr |

A PDF is not fetched, not scraped, and not behind an access control. It is a
document handed to the customer. It is also the strongest form of the evidence:
a price-match desk asks for the competitor's *advertised* price, printed, with
dates — which is exactly what a page of the PDF is.

## The rule this pipeline exists to hold

A model reading a flyer page can misread a price. The failure is silent and the
number ends up in front of a cashier, so a model's reading is treated as a
**claim**, not as data.

Most flyer PDFs carry a text layer — real characters placed by the publishing
tool, not an OCR guess. That is a second witness the model did not write.

```
extraction (model)  ──►  verify against the page's own text  ──►  offer
                                      │
                                      └── inconclusive ──► a person decides
```

Nothing becomes a `FlyerOffer` on the strength of the model's reading alone, and
`toFlyerOffers` is the only door. A `REJECTED` verdict cannot be overridden by a
person: the page said the price is not there, and a tap is not evidence against
the document.

## Verdicts

| Price evidence | Meaning | Verdict |
| --- | --- | --- |
| `EXACT` | `$7.49` / `7,49 $` found in the text layer | `CONFIRMED`, if the product wording matches too |
| `SPLIT_DIGITS` | `7 49` / `749` — superscript-cents typesetting | `NEEDS_REVIEW`; digits agree but a bare digit run is not proof |
| `NOT_IN_TEXT` | page is readable and the price is not on it | `REJECTED` |
| `NO_TEXT_LAYER` | page is a flat image | `NEEDS_REVIEW`; nothing to check against |

Product wording is checked as well as the price, because at a till the right
price on the wrong product is worse than no price. A named brand that does not
appear on the page is decisive.

A good import looks like "38 confirmed, 12 to check, 4 dropped". One that
confirms everything means the check is not checking.

## What is built, and what is not

Built and tested here:

- the verification rules (`verify.ts`)
- the conversion gate (`toOffers.ts`)
- the types the two ends agree on (`types.ts`)

Not built yet:

- **PDF text + page extraction.** Needs a real sample to settle: whether IGA's
  flyer carries a text layer at all, and how it typesets prices. Everything
  above is written to work either way, but which branch dominates is a
  measurement, not a guess.
- **The Gemini extraction call.** Will reuse the structured-output schema
  already used by `cartmatch-vision`. A 124-page flyer is processed in page
  ranges, not one request.
- **The review screen** — the page image beside the extracted price, accept or
  reject. Required before any `NEEDS_REVIEW` offer can be used.
- **Storage of the document** so `flyerDocumentRef` can render the page at the
  till, and expiry of it when the flyer's window closes.

## Scope note

This is a flyer the user received, imported for their own shopping. It involves
no fetching from a retailer, no access control, and no terms of service.
