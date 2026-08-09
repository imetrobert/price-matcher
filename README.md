# CartMatch

Mobile-first grocery price-match assistant for Montreal. You are standing in a
store; you photograph your cart; the app tells you which of those exact items
are verifiably cheaper elsewhere, and gives you something you can show a
cashier.

Working name. Renaming means editing `src/app/layout.tsx` and the strings in
`src/app/page.tsx` — the name is not baked into module paths or types.

---

## ⚠️ Read this first: what is real and what is not

This section is the most important part of the README. The app is built around
refusing to state things it cannot back up, and the same standard applies here.

| Area | Status |
|---|---|
| Product matching engine | **Real and tested.** 59 automated tests, including every discrimination case from the spec. |
| Money / savings arithmetic | **Real and tested.** Integer cents throughout. |
| Freshness, eligibility, audit trail | **Real and tested.** |
| Mobile UI, Checkout Mode, proof sheet | **Real.** Exercised against the running server. |
| Supabase persistence | **Written, never run.** No Supabase project was reachable from the build environment. |
| Gemini cart recognition | **Written, never run with a real key.** No `GEMINI_API_KEY` was available. |
| **Retailer price integrations** | **NOT IMPLEMENTED.** See below. |

### The blocker: retailer egress is refused

Every one of the six retailer domains is refused by the network policy of the
environment this was built in — the proxy answers `403 Forbidden` to the
`CONNECT` request:

```
www.maxi.ca:443     -> 403
www.superc.ca:443   -> 403
www.walmart.ca:443  -> 403
www.metro.ca:443    -> 403
www.iga.net:443     -> 403
www.provigo.ca:443  -> 403
```

No retailer page has ever been fetched. That means no search URL, no product
URL pattern, and no page structure has been observed. Writing CSS selectors
against pages nobody has loaded would produce a scraper that *looks* finished
and silently returns wrong prices — the exact failure this app exists to
prevent.

So, per the build spec's own instruction for this situation:

- `LiveRetailerAdapter` implements the full adapter interface and reports
  `UNAVAILABLE` with the real reason. It does a genuine reachability probe, so
  the moment egress is permitted the status text changes on its own.
- Every data method returns a typed `NOT_IMPLEMENTED` error rather than a price.
- `MockRetailerAdapter` serves clearly-labelled fixtures so the pipeline and UI
  are fully exercisable today.
- **No price, URL, UPC, or retailer policy in this repository is a claim about
  the real world.**

`src/services/retailers/liveAdapter.ts` contains a step-by-step guide for
implementing a retailer once you can reach it.

### Retailer policies are all `UNKNOWN`

`src/config/policies.ts` sets every field to `UNKNOWN` with an empty
`sourceUrl`, because no policy page could be read. The consequence is
deliberate: the app **never** claims a price-match opportunity on policy
grounds. It tops out at *"this competitor price is verified"* — a statement
about a page that was actually fetched — and never *"they will match it"*.

---

## What it does

```
PHOTO → IDENTIFY → CONFIRM → CANONICALISE → SEARCH → VERIFY → COMPARE → PROVE
```

1. **Setup** — postal code, language, minimum savings. Stored in
   `localStorage`; no account, no server-side user record.
2. **Store selection** — which banner you are in, optionally which store.
3. **Photo** — one or more cart photos, camera or library.
4. **Recognition** — Gemini returns strict structured JSON (never free text).
5. **Confirmation** — every detection is editable; low-confidence ones are
   flagged. You can type the shelf price here, which matters a lot (below).
6. **Comparison** — competitors are searched in parallel, candidates are ranked
   by a deterministic matcher, and only the winner's price is fetched.
7. **Results** — only rows that clear your threshold *and* every trust gate.
8. **Checkout Mode** — one match per screen, very large type, no computation.

### Why it asks for the shelf price

Savings are measured against what *you* are about to pay. Where the current
retailer's own price cannot be independently verified, the app will not invent
one — it asks you to type the shelf tag, records it as `USER_ENTERED`, and
never describes it as independently verified.

---

## Trust model

Three states, kept strictly separate, and a row only ever moves *down*:

| State | Means |
|---|---|
| `CHEAPER_ELSEWHERE` | A verified competitor price is lower. |
| `POTENTIAL_PRICE_MATCH` | The above, **and** a reviewed retailer policy permits a match. Currently unreachable — no policy is verified. |
| `CHECKOUT_READY_PROOF` | Exact match + fresh + in stock + direct product URL + high confidence + real (non-mock) data. |

**Checkout Mode only ever shows `CHECKOUT_READY_PROOF`.**

### Match scoring

Deterministic ladder — you land on the highest rung you fully satisfy:

| Score | Level | Condition |
|---|---|---|
| 100 | L1 | GTIN equal (check-digit validated, normalised to GTIN-14) |
| 98 | L2 | Retailer product id already mapped to this canonical product |
| 95 | L3 | brand + name + variant + fat% + exact size + package count |
| 90 | L3 | as above, fat% known on only one side |
| ≤70 | L4 | Fuzzy token overlap — **never** checkout-eligible |

**Hard blockers force the score to 0** regardless of textual similarity:
different brand, variant, size (beyond 2% unit-conversion tolerance), package
count, fat percentage, product line (`Oikos` vs `Oikos Pro`), or conflicting
GTINs.

Thresholds live in `src/config/thresholds.ts`: ≥95 `EXACT_MATCH`, ≥90
`HIGH_CONFIDENCE`, ≥75 `REVIEW_REQUIRED`, below that `REJECTED`.

GTIN equality is checked **before** the blockers, deliberately — see next
section.

### Bilingual matching (Montreal-specific)

The same tub is *"Oikos Greek Yogurt Vanilla 650 g"* at one banner and *"Oikos
Yogourt Grec Vanille 650 g"* at another. A naive matcher rejects that as a
different flavour and a different product line. `TERM_EQUIVALENTS` in
`src/services/products/normalize.ts` maps exact FR↔EN equivalents so those
match, while `Vanille` vs `Strawberry` still fails. The map is deliberately
short: a wrong entry manufactures false matches, so only exact synonyms belong
in it.

This was caught by a runtime smoke test, not by unit tests — the French Super C
fixture was silently being rejected.

### Freshness

`FRESH` < 24 h, `ACCEPTABLE` < 48 h, `STALE` beyond, per-retailer overrides
available. A flyer price outside its printed validity window is `EXPIRED`
regardless of how recently it was fetched. Only `FRESH` and `ACCEPTABLE` can
back a checkout claim.

### Source reliability

`VERIFIED` (retailer's own product page, with store context) →
`CONDITIONALLY_VERIFIED` (regional/online price, or user-entered) → `STALE` →
`UNVERIFIED`. Mock fixtures are always `UNVERIFIED`.

---

## Setup

```bash
npm install
cp .env.example .env.local     # fill in what you have
npm run dev                    # http://localhost:3000
```

The app runs with **no keys at all** in mock mode — useful for UI work.

### Environment variables

All server-side only. None is exposed to the browser bundle.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Cart photo recognition. Without it, vision falls back to mock and says so. |
| `GEMINI_MODEL` | Default `gemini-2.0-flash`. |
| `CARTMATCH_DATA_MODE` | `MOCK` (fixtures, labelled) or `LIVE` (real adapters only). |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Use your existing Supabase project for persistence. |
| `SUPABASE_SCHEMA`, `SUPABASE_TABLE_*` | Optional overrides to fit your naming. |
| `CARTMATCH_DATA_DIR` | Local file store, used only when Supabase is not configured. |
| `GOOGLE_SEARCH_API_KEY` / `GOOGLE_SEARCH_ENGINE_ID` | Optional, to *discover* candidate product URLs. A snippet is never used as a price. |
| `RETAILER_FETCH_TIMEOUT_MS` | Default 12000. |
| `CARTMATCH_PERSIST_PHOTOS` | Default `false`. Photos are otherwise processed in memory and discarded. |

### Using your existing Supabase project

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, then apply the schema once:

```bash
psql "$SUPABASE_DB_URL" -f supabase/schema.sql
```

Three tables (`cartmatch_price_observations`, `cartmatch_audit_records`,
`cartmatch_validations`), prefixed so they sit safely beside your existing
tables, RLS on with no policies so only the service role can reach them. Rows
keep the whole domain object in a `payload jsonb` column with hot fields
promoted, so adding a TypeScript field needs no migration. It talks to PostgREST
over `fetch` — no `@supabase/*` dependency.

Without these variables the app uses a local JSONL file store. Nothing else
changes.

There is also a `cartmatch_retailer_reliability` view that turns your
"Verify This Match" feedback into measured accuracy per retailer — the intended
future input to `priceReliability`.

### Commands

```bash
npm run dev        # dev server
npm run build      # production build
npm run test       # vitest (59 tests)
npm run typecheck  # tsc --noEmit
npm run verify     # typecheck + test + build
```

---

## Architecture

```
src/
  app/                    screens + API routes
    api/vision            POST  photo -> structured products
    api/pipeline          POST  confirmed items -> verified opportunities
    api/health            GET   adapter + config status
    api/admin/audit       GET   audit trail
    api/validate          POST  real-world outcome feedback
  components/             UI (proof sheet, mock banner, primitives)
  config/                 retailers, policies, thresholds, env
  fixtures/               product identities + clearly-marked mock prices
  lib/                    money (integer cents), region, prefs, store/
  services/
    vision/               Gemini + mock, strict JSON schema
    products/             normalization, canonical identity
    matching/             scoring ladder + candidate ranking
    retailers/            adapter interface, registry, live scaffold, mock
    pricing/              freshness
    policies/             the eligibility gauntlet
    pipeline/             orchestration
  types/                  domain types
tests/                    vitest suites
supabase/schema.sql       tables for your existing project
```

Two rules shape the layout:

- **AI does interpretation; code does everything else.** Gemini reads photos.
  Arithmetic, thresholds, timestamps, freshness, filtering, sorting and
  eligibility are plain deterministic code. `savings = current - competitor` is
  never delegated to a model.
- **No type can hold a price without its provenance.** `PriceObservation`
  requires `sourceType` and `observedAt`; there is no shortcut constructor.

### Adding a retailer

1. Add an entry to `src/config/retailers.ts` (leave `priceReliability` at
   `UNKNOWN`).
2. Add a policy entry in `src/config/policies.ts` — with a real `sourceUrl`, or
   leave it `UNKNOWN`.
3. Subclass `LiveRetailerAdapter` and implement search + product-page parsing,
   following the steps in that file.
4. Add fixtures to `src/fixtures/` so it is testable offline.
5. Only after live pages have actually been parsed, update
   `priceReliability` and record what you measured.

Nothing else hard-codes a retailer.

### Testing a product without a photo

`/test` runs `IDENTIFY → MATCH → SEARCH → VERIFY → COMPARE` against typed-in
attributes, with one-tap fixture loading for the hard cases. `/admin` shows the
audit trail, price observations, config, and the "Verify This Match" form.

---

## Privacy

Postal code is the only location detail stored, and it lives in `localStorage`.
Photos are processed in memory and discarded unless
`CARTMATCH_PERSIST_PHOTOS=true`. No account, no payment data, no precise
location, no advertising identifiers.

---

## Known limitations

1. **No working retailer integration** — the headline item. See the top.
2. **Gemini path unexercised** — the request shape follows the documented REST
   contract and the endpoint is reachable, but no call has been made with a
   valid key.
3. **Supabase path unexercised** — same situation.
4. **All retailer policies `UNKNOWN`**, so `POTENTIAL_PRICE_MATCH` is
   unreachable by design.
5. **No GTINs in fixtures.** Inventing barcode numbers would let a fabricated
   identifier reach a Level-1 "exact UPC match". Populate them from real scans.
6. **UI is English only.** The language preference persists but nothing is
   translated.
7. **Per-retailer rejections are not individually audited.** When an item
   produces at least one displayable row, competitors rejected by the matcher
   do not each get an audit row. Item-level failures are recorded.
8. **`.data/` file store is not concurrency-safe** — fine for one developer,
   which is why Supabase is the recommended backend.
9. **Store-level pricing is unproven.** Without a confirmed store context, a
   price is labelled a Montreal-area online price, never a shelf guarantee.

## Not a guarantee

CartMatch is a price-match *assistance* tool. Whether a retailer honours a
price match is the retailer's decision under its own policy. The app
distinguishes "verified competitor price" from "guaranteed price match" and
never claims the latter.
