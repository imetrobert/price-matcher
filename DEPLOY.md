# Deploying CartMatch to pricecheck.imetrobert.com

GitHub Pages (static site) + Supabase (auth, data, and the Gemini call).
No third-party hosting account.

**None of this has been executed.** I have no access to your DNS, your GitHub
Pages settings, or your Supabase project. This is a runbook for you to run.

---

## How the pieces fit, and where the security is

GitHub Pages serves files. It cannot run a server, so the app is a static
bundle — and since the repository is **public**, that bundle is readable by
anyone. That is fine, because it contains nothing worth stealing:

| Piece | Where it runs | Holds secrets? |
|---|---|---|
| UI, matching engine, savings maths, freshness rules | Your browser | no — pure logic |
| Sign-in | Supabase Auth, in the browser | publishable key only, public by design |
| Gemini cart recognition | Supabase **Edge Function** | yes — the key never leaves Supabase |
| Audit trail, price observations | Supabase tables | protected by Row Level Security |

**The client-side sign-in screen is not a security control.** Anyone can read
the bundle and skip it. What actually protects things:

- The **Edge Function** verifies your JWT before spending a Gemini call.
- **Row Level Security** decides which rows your session may read or write,
  enforced by Postgres regardless of what the browser sends.

Design accordingly: never assume the UI is hiding something.

---

## 1. Database (once)

In the Supabase SQL Editor, run **both** files from this repo, in order:

1. `supabase/schema.sql` — creates the three `cartmatch_` tables.
2. `supabase/policies.sql` — **required for this deployment.** Adds a `user_id`
   column and the RLS policies that let your browser write as yourself.

Without step 2 every write fails: the tables have RLS on with no policies,
which permits nothing but the secret key — and there is no server here to hold
one. Symptom is an empty `/admin` and RLS errors in the browser console.

By default each person sees only their own runs. `policies.sql` ends with a
commented-out block if you would rather everyone admitted sees everything.

## 2. Edge Function (once)

This is what holds your Gemini key.

```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>

supabase functions deploy cartmatch-vision --no-verify-jwt

supabase secrets set CARTMATCH_ALLOWED_EMAILS=you@yourdomain.com
supabase secrets set CARTMATCH_ALLOWED_ORIGINS=https://pricecheck.imetrobert.com
```

Or deploy from the dashboard: **Edge Functions → Deploy a new function → Via
Editor**, name it `cartmatch-vision`, paste
`supabase/functions/cartmatch-vision/index.ts`, and **turn "Verify JWT" off** —
that gate rejects the browser's CORS preflight, and the function runs a
stricter check of its own.

**Two things to know if this project is shared with your other apps:**

*Function names are project-wide.* `cartmatch-vision`, not `vision`, because
deploying over an existing function replaces it and `vision` is exactly what
another app would call its own.

*Secrets are project-wide too.* An existing `GEMINI_API_KEY` is picked up
automatically — no need to add one. If you would rather CartMatch used its own
key, so revoking it doesn't disturb the other app, set
`CARTMATCH_GEMINI_API_KEY` and it wins. The model and thinking-budget settings
are read **only** under `CARTMATCH_`-prefixed names, so another app's
`GEMINI_MODEL` can never change which model reads your cart.

`CARTMATCH_ALLOWED_EMAILS` must be set **here as well as** in the build
variables below. The build copy decides what the UI shows; **this copy decides
what is actually permitted.** If they disagree, someone is told they have
access and then gets a 403 on every scan.

## 3. Build variables

**Settings → Secrets and variables → Actions.**

Under **Variables** (these are published in the bundle — that is expected):

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project>.supabase.co` |
| `NEXT_PUBLIC_CARTMATCH_ALLOWED_EMAILS` | your email, comma-separated for more |
| `NEXT_PUBLIC_CARTMATCH_DATA_MODE` | `MOCK` |
| `PAGES_CUSTOM_DOMAIN` | `pricecheck.imetrobert.com` |

Under **Secrets**:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your **publishable** key (`sb_publishable_…`) |

> The publishable key is stored as a "secret" only to keep it out of the
> workflow file's plain text. It is inlined into the published bundle and is
> **designed to be public** — it is powerless without a session, because RLS
> evaluates every request it makes.
>
> ⚠️ Your **secret** key (`sb_secret_…`, formerly `service_role`) must never
> appear in any of these. It bypasses RLS entirely. It belongs only in Supabase
> Edge Function secrets, and this app no longer uses it at all.
>
> Leave `NEXT_PUBLIC_CARTMATCH_DATA_MODE` on `MOCK`. `LIVE` reports every
> retailer as unavailable, because no retailer adapter exists (see README).

The workflow refuses to publish if anything matching a secret-key pattern
appears in the build output — a last check before it goes to the internet.

## 4. Turn on Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

Not "Deploy from a branch". The workflow in `.github/workflows/deploy.yml`
publishes the built output, and it only runs on pushes to `main`.

**The code is currently on `claude/prompt-length-limits-71ze3z`; `main` has
only the README.** Merge that branch to `main` or nothing will build.

## 5. Point the subdomain at Pages

At your DNS provider for `imetrobert.com`:

| Type | Name | Value |
|---|---|---|
| `CNAME` | `pricecheck` | `imetrobert.github.io` |

Most registrars want just `pricecheck` in the Name field, not the full domain.
Note the value is your **user** subdomain, not the repository.

Then **Settings → Pages → Custom domain** → `pricecheck.imetrobert.com`, and
tick **Enforce HTTPS** once the certificate issues (usually minutes).

**On Cloudflare:** set the record to **DNS only** (grey cloud) until the
certificate is issued, or the challenge fails.

```bash
dig +short pricecheck.imetrobert.com
```

## 6. Tell Supabase the domain

**Authentication → URL Configuration:**

- Site URL: `https://pricecheck.imetrobert.com`
- Redirect URLs: add `https://pricecheck.imetrobert.com/**`

Not required for password sign-in, which is a direct token exchange and never
consults this list. Set it so password-reset emails and any OAuth you add later
land on the right origin.

## 7. Verify

```bash
# Site is up
curl -s -o /dev/null -w "%{http_code}\n" https://pricecheck.imetrobert.com/
# 200 — and yes, the page is public. That is expected; see the top.

# No secret key material in the published bundle
curl -s https://pricecheck.imetrobert.com/_next/static/chunks/*.js 2>/dev/null \
  | grep -cE 'sb_secret_[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}'
# 0

# The Edge Function refuses an unauthenticated caller — THIS is the real gate
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://<project>.supabase.co/functions/v1/cartmatch-vision \
  -H 'Content-Type: application/json' -d '{"images":[]}'
# 401
```

That last check is the one that matters. If it returns anything other than
`401`, stop and fix it before using the app: your Gemini quota is reachable by
anyone.

Then on your phone: open the site, sign in, and confirm the header reads
"Signed in as …" with no orange **Open to everyone** banner.

## What works, and what does not

Behind sign-in: the full flow (photo → confirm → compare → proof → Checkout
Mode), `/test`, and `/admin`.

Every price will carry the purple **MOCK DATA** banner. No retailer
integration exists — and on this architecture it never can run in the browser,
because retailers do not permit cross-origin requests. It has to become a
second Edge Function; `src/services/retailers/liveAdapter.ts` explains what
that involves.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Blank page, 404 on `/_next/...` | `.nojekyll` missing — Jekyll strips underscore paths. The workflow creates it; check the build log. |
| Assets 404 under `imetrobert.github.io/price-matcher/` | You are on the project URL, not the custom domain. Either use the custom domain or set the `NEXT_PUBLIC_BASE_PATH` variable to `/price-matcher`. |
| Sign-in works, "Access not enabled for this account" | Your address is not in `NEXT_PUBLIC_CARTMATCH_ALLOWED_EMAILS`. Add it and re-run the workflow (build-time value — a redeploy is required). |
| Scans fail with 403 from the Edge Function | `CARTMATCH_ALLOWED_EMAILS` in the **Supabase secrets** disagrees with the build variable. |
| Scans fail with CORS errors | `CARTMATCH_ALLOWED_ORIGINS` does not include your domain. |
| `/admin` empty, RLS errors in console | `supabase/policies.sql` not applied. |
| Orange "Open to everyone" banner | No allowlist set — anyone on the Supabase project can sign in. |
| Changed a variable, nothing happened | `NEXT_PUBLIC_*` are inlined at build time. Re-run the workflow. |
