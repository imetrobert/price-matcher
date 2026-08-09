# CartMatch

Mobile-first grocery price-match assistant for Montreal. You are standing in a
store; you photograph your cart; the app tells you which of those exact items
are verifiably cheaper elsewhere, and gives you something you can show a
cashier.

Deployed as a **static site on GitHub Pages**, with Supabase for sign-in, data,
and the one call that needs a secret. See [Architecture](#architecture) for what
that costs and what it buys.

Working name. Renaming means editing `src/app/layout.tsx` and the strings in
`src/app/page.tsx` — the name is not baked into module paths or types.

---

## ⚠️ Read this first: what is real and what is not

This section is the most important part of the README. The app is built around
refusing to state things it cannot back up, and the same standard applies here.

| Area | Status |
|---|---|
| Product matching engine | **Real and tested.** 76 automated tests, including every discrimination case from the spec. |
| Money / savings arithmetic | **Real and tested.** Integer cents throughout. |
| Freshness, eligibility, audit trail | **Real and tested.** |
| Mobile UI, Checkout Mode, proof sheet | **Real.** Exercised against the built static export. |
| Static export + Pages workflow | **Real.** All 8 pages build and serve; the secret-leak guard is tested in both directions. |
| Sign-in gate in the browser | **Real, but it is not a security control** — see [Where the security actually is](#where-the-security-actually-is). |
| Supabase persistence + RLS policies | **Written, never run.** No Supabase project was reachable from the build environment. |
| Supabase sign-in (credential exchange) | **Written, never run with a real project.** |
| Gemini cart recognition (Edge Function) | **Written, never deployed.** No `GEMINI_API_KEY` and no Supabase project were available. |
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

## Sign-in

CartMatch uses **Supabase Auth against the same project as your other apps**,
so it is the same `auth.users` table and therefore the same email and password.
There is no sign-up form on purpose — accounts are created in the Supabase
dashboard, and a public sign-up on a personal tool invites strangers in.

### Where the security actually is

GitHub Pages serves files; it cannot run a server. So the whole app is a static
bundle, and since this repository is public, **anyone can read that bundle and
skip the sign-in screen entirely.** The login page is a UX affordance, not a
gate. Two things are the real controls:

| Control | Enforced by | Protects |
|---|---|---|
| JWT verification + `has_app_access('cartmatch')` | Supabase Edge Function, before any Gemini call | your API key and your quota |
| Row Level Security (`supabase/policies.sql`) | Postgres, on every query | your scans, prices, and postal code |

Design accordingly: never put anything in this repository that depends on the
UI hiding it. Nothing in `src/` is trusted.

**The two Supabase keys are not interchangeable.** The **publishable** key
(`sb_publishable_…`, formerly `anon`) is designed to ship to the browser and is
powerless alone — every request it makes is evaluated against RLS, which is why
the `NEXT_PUBLIC_` prefix is correct there. The **secret** key (`sb_secret_…`,
formerly `service_role`) bypasses RLS entirely. **This app no longer uses it at
all**, and the deploy workflow refuses to publish if anything matching a
secret-key pattern appears in the build output.

### Who gets in

Supabase Auth is scoped to a **project**, not an app. This project serves six
apps off one `auth.users` table, so a valid session proves only that somebody
has an account *somewhere* on it — not that they belong here. `to
authenticated` is therefore not access control; it describes the session, not
the entitlement.

Entitlement is a row in **`public.app_access`**, read through
`public.has_app_access('cartmatch')`. The same question is asked in three
places, all from that one table:

| Asked by | Consequence of "no" |
|---|---|
| Row Level Security, on every query | zero rows, refused writes |
| The `cartmatch-vision` Edge Function | `403`, before any Gemini spend |
| `src/lib/auth/access.ts` in the browser | a page explaining they lack a grant |

Only the first two are enforcement. The third exists so the answer arrives as
an explanation rather than an app that loads and then fails at everything.

Granting is one statement, and takes effect on that person's next page load:

```sql
insert into public.app_access (user_id, app, role)
select id, 'cartmatch', 'member' from auth.users where email = 'x@example.com'
on conflict (user_id, app) do update set role = excluded.role;
```

`role` is `member` or `app_admin`. An `app_admin` can *read* everyone's rows —
so somebody supporting the app can see what happened — but still cannot write a
row as anyone else. That asymmetry is deliberate.

**This replaced a pair of email allowlists** (`NEXT_PUBLIC_CARTMATCH_ALLOWED_EMAILS`
at build time, `CARTMATCH_ALLOWED_EMAILS` in the Edge Function secrets). Two
copies of one fact, kept in step by hand: granting access meant editing both and
redeploying, and forgetting either produced a sign-in that worked followed by a
`403` on every scan, with nothing on screen connecting the two. If either
variable still exists on your project, delete it — a stale allowlist that
nothing reads is worse than none, because the next person to debug an access
problem will edit it and wait for something to happen.

## Setup

```bash
npm install
cp .env.example .env.local     # fill in what you have
npm run dev                    # http://localhost:3000
```

The app runs with **no keys at all** in mock mode — useful for UI work. `npm run
dev` still uses the Next.js dev server; only the production build is a static
export. The vision Edge Function is not part of `npm run dev`, so photo
recognition falls back to mock locally unless you run `supabase functions serve`
and point `NEXT_PUBLIC_SUPABASE_URL` at it.

## Deploying to pricecheck.imetrobert.com

See **[DEPLOY.md](./DEPLOY.md)** for the full runbook: the two SQL files, the
Edge Function and its secrets, the GitHub Actions variables, the `CNAME`, and
the `curl` checks — including the one that matters, which proves the Edge
Function refuses an unauthenticated caller.

None of it has been executed — I have no access to your DNS, your GitHub Pages
settings, or your Supabase project.

### Build variables (all public)

`NEXT_PUBLIC_*` values are inlined into the bundle at build time. The bundle and
this repository are both world-readable, so **everything in this table is
public** regardless of whether GitHub stores it under "Variables" or "Secrets".

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The **publishable** key. Same project as your other apps = same credentials. Public by design. |
| `NEXT_PUBLIC_CARTMATCH_DATA_MODE` | `MOCK` (fixtures, labelled) or `LIVE` (real adapters only — today that means no prices at all). |
| `NEXT_PUBLIC_BASE_PATH` | Only for `<user>.github.io/<repo>/`. Leave unset on a custom domain. |

### Edge Function secrets (never in the bundle)

Read only by `supabase/functions/**`, which runs on Supabase. Set with
`supabase secrets set`:

| Secret | Purpose |
|---|---|
| `CARTMATCH_ALLOWED_ORIGINS` | CORS allowlist, e.g. `https://pricecheck.imetrobert.com`. **Required** in production, or the browser is told only localhost may call. Arbitrary origins are never reflected. |
| `CARTMATCH_GEMINI_API_KEY` | Optional. Falls back to a project-wide `GEMINI_API_KEY` if absent. |
| `CARTMATCH_GEMINI_MODEL` | Optional. Default `gemini-2.5-flash`. |
| `CARTMATCH_GEMINI_THINKING_BUDGET` | Optional. Default `0` — recognition is extraction, not reasoning, and the shopper is waiting. |

**Supabase secrets and function names are scoped to the whole project, not to
an app.** If this project is shared, that cuts both ways: an existing
`GEMINI_API_KEY` is reused for free, but a generic name like `GEMINI_MODEL`
set by another app would otherwise reach in and change which model reads your
cart. So everything CartMatch *owns* is prefixed, the function is deployed as
`cartmatch-vision` rather than `vision`, and only the shared API key is
inherited — deliberately, with a prefixed override available.

### Using your existing Supabase project

Run both SQL files in the SQL editor, in order:

1. `supabase/schema.sql` — three tables (`cartmatch_price_observations`,
   `cartmatch_audit_records`, `cartmatch_validations`), prefixed so they sit
   safely beside your existing tables. Rows keep the whole domain object in a
   `payload jsonb` column with hot fields promoted, so adding a TypeScript
   field needs no migration.
2. `supabase/policies.sql` — **required.** Adds `user_id` and the RLS policies
   that let a browser session write as itself. Without it every write fails:
   RLS is on with no policies, which permits nothing but the secret key, and
   there is no server here to hold one.

By default each person sees only their own runs; `policies.sql` ends with a
commented-out block for shared visibility. Inserts stay per-user either way —
nobody can write a row as someone else.

Without Supabase configured, persistence is simply skipped. Writes are
best-effort and log rather than throw, because a failed audit write must not
cost a shopper their comparison at the till.

There is also a `cartmatch_retailer_reliability` view that turns your
"Verify This Match" feedback into measured accuracy per retailer — the intended
future input to `priceReliability`.

### Commands

```bash
npm run dev        # dev server
npm run build      # static export into out/
npm run test       # vitest (76 tests)
npm run typecheck  # tsc --noEmit
npm run verify     # typecheck + test + build
```

---

## Architecture

Three places code runs, and the split is not arbitrary — it follows what each
one is allowed to hold:

| Runs in | Contains | Why there |
|---|---|---|
| Browser (GitHub Pages) | UI, matching, savings arithmetic, freshness, eligibility, the pipeline | Pure logic. Publishing it costs nothing; it has no secret to leak. |
| Supabase Edge Function | The Gemini call | It holds the API key. That is the entire reason it exists. |
| Postgres | Audit trail, price observations, validations | RLS is the only enforcement a static site can rely on. |

```
src/                      → published to Pages, world-readable
  app/                    screens (static export, no API routes)
  components/             UI (proof sheet, mock banner, auth guard, primitives)
  config/                 retailers, policies, thresholds, env
  fixtures/               product identities + clearly-marked mock prices
  lib/                    money (integer cents), region, prefs, auth/, store/
  services/
    vision/               request/response shaping + mock, strict JSON schema
    products/             normalization, canonical identity
    matching/             scoring ladder + candidate ranking
    retailers/            adapter interface, registry, live scaffold, mock
    pricing/              freshness
    policies/             the eligibility gauntlet
    pipeline/             orchestration
  types/                  domain types
tests/                    vitest suites

supabase/                 → runs on Supabase, never published
  functions/vision/       holds GEMINI_API_KEY; verifies the JWT first
  schema.sql              tables
  policies.sql            RLS — required for this deployment

.github/workflows/        → build, test, leak-check, publish to Pages
```

There are no API routes and no middleware: `output: "export"` cannot run them,
and leaving them in place would ship dead code that looks like a protection.

Three rules shape the layout:

- **AI does interpretation; code does everything else.** Gemini reads photos.
  Arithmetic, thresholds, timestamps, freshness, filtering, sorting and
  eligibility are plain deterministic code. `savings = current - competitor` is
  never delegated to a model.
- **No type can hold a price without its provenance.** `PriceObservation`
  requires `sourceType` and `observedAt`; there is no shortcut constructor.
- **Nothing in `src/` is trusted.** It is published. Every check that matters
  is repeated in the Edge Function or in Postgres.

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
Photos go to the Edge Function, are forwarded to Gemini, and are never written
to a database or a disk — no code path persists an image. No account beyond the
Supabase login, no payment data, no precise location, no advertising
identifiers.

---

## Known limitations

1. **No working retailer integration** — the headline item. See the top. On
   this architecture it can never run in the browser either: retailers do not
   permit cross-origin requests, so it has to become a second Edge Function.
2. **Gemini path unexercised** — the request shape follows the documented REST
   contract, but no call has been made with a valid key, and the Edge Function
   has never been deployed.
3. **Supabase paths unexercised** — persistence, RLS, and the sign-in
   credential exchange are all written against the documented contracts but
   have never run against a real project. Run DEPLOY.md's checks after
   deploying; the Edge Function `401` check is the one that matters.
4. **The site itself is public.** Pages cannot require a login to serve a file,
   so anyone with the URL loads the app shell and can read the whole bundle.
   What they cannot do is spend your Gemini quota or read your rows. If that
   trade is unacceptable, this is the wrong host.
5. **Access depends on the platform access model being deployed.** If
   `public.has_app_access` is missing, the app cannot tell "no grant" from
   "cannot ask" — it reports the second honestly rather than guessing, but
   nobody gets in until it exists.
6. **All retailer policies `UNKNOWN`**, so `POTENTIAL_PRICE_MATCH` is
   unreachable by design.
7. **No GTINs in fixtures.** Inventing barcode numbers would let a fabricated
   identifier reach a Level-1 "exact UPC match". Populate them from real scans.
8. **UI is English only.** The language preference persists but nothing is
   translated. Note this is separate from *matching*, which is bilingual.
9. **Per-retailer rejections are not individually audited.** When an item
   produces at least one displayable row, competitors rejected by the matcher
   do not each get an audit row. Item-level failures are recorded.
10. **Store-level pricing is unproven.** Without a confirmed store context, a
   price is labelled a Montreal-area online price, never a shelf guarantee.

## Not a guarantee

CartMatch is a price-match *assistance* tool. Whether a retailer honours a
price match is the retailer's decision under its own policy. The app
distinguishes "verified competitor price" from "guaranteed price match" and
never claims the latter.
