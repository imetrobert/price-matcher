# Brief for an AI assistant working on CartMatch

**If you are an AI reading this: this file is the whole briefing. Read it, then
read only the one file the problem is actually in.** The repository is public,
so you can fetch any file directly rather than asking for it to be pasted:

```
https://raw.githubusercontent.com/imetrobert/price-matcher/main/<path>
```

The operator is working from a phone with a limited token allowance. Fetching
costs them nothing; pasting a 1,100-line file costs them a large fraction of a
day's budget. Fetch, don't ask.

---

## What this is

A price-comparison app for Quebec grocery flyers. Somebody imports the week's
flyer PDFs; a model reads the prices off the rendered pages; the app compares
what is advertised where. It runs at pricecheck.imetrobert.com.

- **Next.js 15 App Router, `output: "export"`** — a fully static site. There is
  no server, no API route, no middleware. Anything server-side is a Supabase
  Edge Function.
- **GitHub Pages** serves it. A push to `main` deploys in ~2 minutes.
- **Supabase** holds Postgres (RLS on every table), Storage (private bucket of
  flyer page images), and Deno Edge Functions.
- **Gemini** reads the pages, called only from Edge Functions — never from the
  browser, because the key lives server-side.
- A **pg_cron job** ticks every minute and drives the reading queue.

---

## Rules that must never be broken

These are not style preferences. Breaking one produces a wrong price in
somebody's hand at a checkout.

1. **Never invent a price, a product URL, a UPC, or a retailer policy.** If the
   system cannot establish something, the answer is "Unable to verify".
   Accuracy beats coverage, always.
2. **Never present a similar product as an exact match.**
3. **Money is integer cents.** No floating-point arithmetic on currency. Never
   ask a model to compute a saving — that is `current - competitor`, in code.
4. **No secrets in frontend code.** Anything `NEXT_PUBLIC_*` is public. The CI
   fails the build if a service-role key or `AIza…` key appears in the bundle.
5. **Never let mock data render as real price data.**
6. **An empty result and a failed query are different answers** and must never
   render the same. This codebase has been bitten by that three times; see the
   `loadCurrentOffersResult` / `loadAllFlyersResult` pattern in `storage.ts`.
7. **Every read of a growing table must slice, count server-side, or carry a
   `// bounded:` comment.** `tests/noSilentTruncation.test.ts` enforces this and
   will fail the build. PostgREST truncates at 1000 rows in silence.

---

## Where things are

| Path | What it holds |
|---|---|
| `RUNBOOK.md` | **Read this first for any operational symptom.** Diagnostic SQL, every failure seen so far, how to revert. |
| `src/services/flyers/storage.ts` | Every database read and write. 1,100 lines — fetch it, don't ask for it. |
| `src/services/flyers/compare.ts` | Which offers are comparable; the deals-screen summary. |
| `src/services/flyers/cartMatch.ts` | Cart vs flyers: not-in-flyers / best-here / cheaper-elsewhere. |
| `src/services/flyers/batch.ts` | The import run: render PDF, queue pages, save. |
| `src/services/matching/` | Product name matching, including English/French. |
| `src/app/page.tsx` | Home card — "do I have this week's prices". |
| `src/app/deals/page.tsx` | The comparison screen. |
| `src/app/flyers/page.tsx` | Import screen. 1,300 lines. |
| `src/config/retailers.ts` | The banner registry. |
| `supabase/functions/cartmatch-flyer-worker/` | The queue worker (Deno). |
| `supabase/functions/cartmatch-vision/` | Reads a cart photo. |
| `supabase/functions/_shared/` | Prompt, model chain, budget, quota parsing — compiled by both Deno and Next. |
| `supabase/*.sql` | Six files, all of which must be run. Listed in `DEPLOY.md`. |
| `tests/` | 448 tests, run by CI before every deploy. |

---

## How a fix reaches the site

The operator edits files **through the GitHub web UI on a phone** — pencil
icon, commit to `main`. So:

- **Give a small, exact edit.** Name the file, quote the lines to replace, give
  the replacement. A whole-file rewrite is unusable on a phone and burns the
  allowance.
- **One file per fix wherever possible.**
- Do not propose `npm install`, a new dependency, a new build step, or a
  refactor spanning files. None of that can be run or reviewed from a phone.

CI runs on every push to `main`, in this order, and **any failure stops the
deploy**: typecheck → 448 tests → required-env check → build → secret scan.
That is the real safety net. A wrong edit fails the build; it does not reach a
shopper. Tell the operator to check the Actions tab if the site does not change
within ~3 minutes.

**Reverting** is in `RUNBOOK.md` — GitHub's "Revert" button on the commit, no
tools needed.

---

## Things that are deliberately the way they are

Do not "fix" these without being asked:

- **No retailer is scraped for live prices.** Every one was measured and either
  refuses server-side requests or omits prices from the HTML. Flyer PDFs are
  imported by hand on purpose. Do not propose scraping, and do not propose
  bypassing bot protection.
- **Every retailer's price-match policy is `UNKNOWN`** with no published
  source. The app therefore never claims a match is guaranteed.
- **Offers are candidates until a person confirms them** (`confirmedAt`).
- **`CARTMATCH_PAGES_PER_REQUEST` is unset on purpose** (= 1 page per request).
  Batching exists but has never run against real flyers.
- **Comments in this codebase are long and explain *why*.** Match that. Do not
  strip them to save space.

---

## What has never been tested against real data

Say so if a question touches these, rather than assuming they work: page
batching, tile-splitting for "A ou B" flyer tiles, the request-budget hold,
unbranded-produce matching, and the bounding boxes that circle a product on a
flyer page.

---

## How to answer

State plainly when you do not know or cannot verify something — the operator
has to trust the answer without being able to check the code. If a claim needs
data from the database, give the SQL rather than guessing at what it holds.
