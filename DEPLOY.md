# Deploying CartMatch to pricecheck.imetrobert.com

**None of this has been executed.** I have no access to your DNS registrar,
your hosting account, or your Supabase project, so the steps below are a
runbook for you to run, not a record of something that happened. Where a step
can fail in a way that silently leaves the app unprotected, that is called out.

Total time: about 15 minutes, most of it waiting for DNS.

---

## Before you start

You need:

- The **project URL** and **anon key** from Supabase → Project Settings → API.
  Use the *same project as your other apps* — that is what makes the login the
  same email and password.
- The **service role key** from the same page (for the audit tables).
- A **Gemini API key**, if you want real photo recognition.
- Access to DNS for `imetrobert.com`.

---

## 1. Apply the database schema

Once, against your existing project:

```bash
psql "$SUPABASE_DB_URL" -f supabase/schema.sql
```

Or paste `supabase/schema.sql` into the Supabase SQL editor. It creates three
`cartmatch_`-prefixed tables with RLS enabled and no policies, so only the
service role can touch them.

## 2. Confirm you have a user account

CartMatch has **no sign-up form** — a public sign-up on a personal tool invites
strangers in. If you already sign in to another app on this project, that
account works here as-is; skip ahead.

Otherwise: Supabase dashboard → Authentication → Users → **Add user** →
"Auto Confirm User" so no confirmation email is needed.

## 3. Deploy

### Vercel (recommended — zero config for Next.js)

```bash
npm i -g vercel
vercel link
vercel --prod
```

### Anything else

The app is a standard Next.js 15 server (it needs Node, not a static export —
middleware and route handlers run per request):

```bash
npm ci && npm run build && npm start   # listens on $PORT, default 3000
```

Put it behind TLS. The `Strict-Transport-Security` header is already set.

## 4. Set environment variables

In Vercel: Project → Settings → Environment Variables (Production). Elsewhere,
whatever your host uses. **The app will refuse to serve without the first
three** — see step 6.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / public key |
| `CARTMATCH_REQUIRE_AUTH` | `true` |
| `SUPABASE_URL` | same as `NEXT_PUBLIC_SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key |
| `GEMINI_API_KEY` | your Gemini key (omit to stay on mock vision) |
| `CARTMATCH_DATA_MODE` | `MOCK` until a retailer adapter actually works |

> ⚠️ **`SUPABASE_SERVICE_ROLE_KEY` must never be given a `NEXT_PUBLIC_` prefix.**
> The anon key is designed to ship to the browser and is powerless on its own —
> every request it makes is checked against Row Level Security. The service
> role key bypasses RLS entirely. Prefixing it would publish a key that can
> read and write your whole database to anyone who opens devtools.

> **Leave `CARTMATCH_DATA_MODE=MOCK`.** No retailer integration exists yet (see
> the README). `LIVE` will simply report every retailer as unavailable — which
> is correct behaviour, just not useful. Switch it when an adapter works.

## 5. Point the subdomain at it

### Vercel

1. Project → Settings → Domains → add `pricecheck.imetrobert.com`.
2. Vercel shows the record to create. It is normally:

   | Type | Name | Value |
   |---|---|---|
   | `CNAME` | `pricecheck` | `cname.vercel-dns.com` |

3. Add that record at your DNS provider for `imetrobert.com`.
4. Wait for propagation (usually minutes; up to an hour). Vercel issues the
   TLS certificate automatically once the record resolves.

**If `imetrobert.com` is behind Cloudflare**, set the record to **DNS only**
(grey cloud) until the certificate is issued, or the ACME challenge fails.
You can turn the proxy back on afterwards.

Check it:

```bash
dig +short pricecheck.imetrobert.com
curl -sI https://pricecheck.imetrobert.com | head -3
```

### Another host

Point `pricecheck` at whatever your host gives you — `CNAME` to their hostname,
or an `A` record to a static IP. Do not skip TLS: the login posts a password.

## 6. Tell Supabase about the domain

Supabase dashboard → Authentication → URL Configuration:

- **Site URL**: `https://pricecheck.imetrobert.com`
- **Redirect URLs**: add `https://pricecheck.imetrobert.com/**`

**This is not required for the login to work.** CartMatch signs in with
`signInWithPassword`, which is a direct token exchange with no redirect, so the
allow-list is not consulted. Set it anyway, because it *is* consulted the
moment you use a password-reset email, a magic link, or an OAuth provider — and
a reset link that lands on the wrong origin is a confusing thing to debug later.

If sign-in succeeds and then bounces back to `/login`, the cause is the session
cookie, not this setting. See Troubleshooting.

## 7. Verify it is actually protected

Run these against the live domain. **All four must pass** before you treat the
deployment as done.

```bash
# 1. Signed out, the app must redirect to the login page — not render.
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://pricecheck.imetrobert.com/
#    expect: 307 https://pricecheck.imetrobert.com/login?next=%2F

# 2. The API must be protected too, not just the pages.
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://pricecheck.imetrobert.com/api/pipeline \
  -H 'Content-Type: application/json' -d '{}'
#    expect: 307   (NOT 200, and NOT 400)

# 3. The public health endpoint must reveal nothing but auth status.
curl -s https://pricecheck.imetrobert.com/api/health
#    expect exactly: {"ok":true,"auth":{"configured":true,"required":true,"email":null}}

# 4. The login page must load.
curl -s -o /dev/null -w "%{http_code}\n" https://pricecheck.imetrobert.com/login
#    expect: 200
```

If check 1 returns `200`, the environment variables did not take effect —
**the instance is open to anyone with the URL.** Fix before sharing it.

If any check returns `503`, `CARTMATCH_REQUIRE_AUTH=true` is set but the
Supabase keys are missing. That is the app failing closed on purpose.

Then open it on your phone, sign in, and confirm the home screen shows
"Signed in as …" rather than the red **Unprotected instance** banner.

---

## What you get, and what you don't

Working behind the login: the full flow (photo → confirm → compare → proof →
Checkout Mode), the manual test harness at `/test`, and the debug view at
`/admin`.

Not working, because no retailer integration exists: real prices. Every figure
will carry the purple **MOCK DATA** banner. That is the app telling the truth,
not a deployment fault. See the README for what has to happen to change it.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Login succeeds, immediately back at `/login` | The session cookie is not surviving the round trip. Almost always the site is being served over plain HTTP (Supabase sets `Secure` cookies, which browsers drop on HTTP), or you reached it on a different host than the one in the address bar when you signed in — e.g. `www.` vs bare, or the `*.vercel.app` URL vs the custom domain. Confirm `https://` and one consistent hostname. It is **not** the redirect-URL setting in step 6; password sign-in never consults it. |
| `503` on every path | `CARTMATCH_REQUIRE_AUTH=true` with no Supabase keys. |
| Red "Unprotected instance" banner in production | `NEXT_PUBLIC_*` vars missing. Anyone with the URL can use it — fix immediately. |
| "Invalid login credentials" | Wrong password, or the user exists in a *different* Supabase project than the one these keys point at. |
| Certificate never issues | Cloudflare proxy on during issuance — set the record to DNS-only. |
| Audit trail empty at `/admin` | Schema not applied, or the service role key is wrong. Signed in, `/api/health` reports `storage.reachable`. |
