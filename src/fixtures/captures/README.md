# Real retailer captures

Pages that were actually loaded, saved verbatim, and used as test fixtures.

Everything else in `src/fixtures/` is invented data clearly labelled MOCK. This
directory is the opposite: it is the only place in the repository containing
real retailer output, and adapters are tested against it so that parsing is
verified against a page that genuinely existed rather than one someone imagined.

## Rules

**Captured by a person, in a browser, from a real store.** Nothing here is
fetched by this codebase — retailer domains are blocked from the environment it
is developed in, which is the reason these files exist at all.

**Record where each came from**, including the store, because prices are
store-specific and a capture without that context cannot be interpreted later.

**Never commit anything identifying.** No cookies, no `Authorization` headers,
no session or cart identifiers, no account state. Loblaw search URLs carry a
`cartId` — it belongs to the person browsing and must be stripped. `storeId` is
not secret, but it says where someone shops, so it lives in user settings rather
than in this repository.

**A capture is a snapshot, not a contract.** Prices in these files were correct
at the moment of capture and are stale immediately. They exist to pin *parsing*,
never to be served as a price. Nothing in `src/` reads this directory at runtime.

## Index

| File | Source | Captured |
|---|---|---|
| `maxi-product-21305945.jsonld.json` | `maxi.ca` product page JSON-LD, store 7495 (Côte-Saint-Luc) | 2026-08-10 |
| `maxi-search-oikos.results.json` | `maxi.ca` search results for "oikos", from `__NEXT_DATA__`, store 7495 | 2026-08-10 |
| `iga-product-598017.jsonld.json` | `iga.ca` product page JSON-LD, Côte-Saint-Luc | 2026-08-10 |

The Maxi and IGA product captures are the **same tub of yogurt on the same
day** — $7.49 and $8.49. They are the only pair in this repository that
supports a genuine comparison, and `tests/igaProduct.test.ts` computes the
saving from them rather than from an invented number.

Both results in the search capture are `isSponsored: true` — a search for
*Oikos* returned two Yoplait drinks. That is not a quirk of the capture; it is
what the endpoint does, and it is why the parser carries the flag through
rather than treating list position as relevance.
