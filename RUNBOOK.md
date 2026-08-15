# CartMatch runbook

What to do when something is wrong, written for somebody with a phone, the
Supabase SQL editor, and no help.

Every entry is: **what you see** → **what to run** → **what it means**.

---

## First, the one query that answers "is anything wrong at all"

```sql
select id, status_code, created, left(content, 250) as body
from net._http_response order by id desc limit 3;
```

The worker runs every minute and its reply lands here.

| What you see | Meaning |
|---|---|
| `200` + `"note":"Queue empty."` | Healthy. Nothing waiting to read. |
| `200` + `"processed":3` | Healthy and working. |
| `200` + `"note":"Today's model allowance…"` | Out of quota for the day. Resumes at midnight Pacific. Nothing to do. |
| `401` | The cron job's key and `CARTMATCH_WORKER_KEY` disagree. Fix below. |
| `500` **with a JSON body** | Real error, and the body names it. |
| `500` with bare `Internal Server Error` | The function failed to start. Go to the logs — see below. |
| `status_code` is **null** | pg_net gave up waiting. The cron job is missing `timeout_milliseconds`. Fix below. |

---

## Where the real errors live

**Supabase → Edge Functions → `cartmatch-flyer-worker` → Logs.**

This is the only place a startup failure is explained. A bare
`Internal Server Error` in `net._http_response` means the function never
booted, so it could not report anything about itself — the log will name the
module and the line. One evening was spent guessing at this before anybody
looked. Look first.

---

## Symptoms and fixes

### The home card spins forever and the count never moves

```sql
select status, count(*) as pages, max(attempts) as tries,
       left(max(last_error), 200) as reason
from public.cartmatch_flyer_pages group by status order by status;
```

- Rows in **PENDING** with a recent `last_error` → the reason is in that
  column, and the home card should be showing it. Quota reasons resolve
  themselves overnight.
- Rows in **READING** older than ten minutes → a worker died mid-page. The
  next tick releases them automatically; if not,
  `select public.cartmatch_release_stale_pages();`
- Rows in **FAILED** → they ran out of attempts. Use the button on the home
  card, or `update public.cartmatch_flyer_pages set status='PENDING',
  attempts=0, last_error=null where status='FAILED';`
- **No rows at all** but the card says pages are missing → the upload did not
  queue them. Re-import that flyer.

### Nothing is being read and the reply says 401

The cron job and the Edge Function secret hold different keys. They must match.

```sql
select command from cron.job where jobname = 'cartmatch-flyer-worker';
```

Compare the `x-cartmatch-worker-key` value against
**Edge Functions → Secrets → `CARTMATCH_WORKER_KEY`**. Change whichever is
wrong; changing the cron job means re-running `cron.schedule` (see below).

### `net._http_response` rows have null status and null content

The cron job is missing its timeout, so pg_net stops waiting after five
seconds while a real tick takes minutes. The work still happens — you just
cannot see it. Re-schedule with the timeout:

```sql
select cron.unschedule('cartmatch-flyer-worker');

select cron.schedule(
  'cartmatch-flyer-worker',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://<ref>.supabase.co/functions/v1/cartmatch-flyer-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cartmatch-worker-key', '<worker-key>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $job$
);
```

### Reading stops with "quota for the DAY"

Expected on the free tier. Each full flash model allows 20 requests a day and
each Lite model 500; the worker walks the whole chain before giving up. The
allowance resets at **midnight Pacific**. Queued pages keep their attempts and
are read when it does — nothing is lost by waiting.

If it happens every week, the fix is fewer requests rather than more quota:
set `CARTMATCH_PAGES_PER_REQUEST` to `3` in Edge Function secrets, which sends
three pages per request and cuts a week from about seventy requests to
twenty-four. Do that when you can watch the result — compare the per-page
offer counts against previous weeks and set it back to `1` if they drop.

### A scan fails but flyers read fine, or the reverse

They share one model chain but different code. The scan is
`cartmatch-vision`; the worker is `cartmatch-flyer-worker`. Check the failing
one's logs specifically — a difference between them has been the cause more
than once.

### A flyer page does not appear when checking a price

The page picture was not stored. Three reasons, and the screen now names the
PDF to open instead of leaving you to guess which file it was.

- **Pictures were turned off** for that import ("Keep a picture of each page").
- **The upload failed.** It used to fail silently; it is now counted and
  reported at the end of an import, so you will see it happen rather than
  discover it a week later.
- **The flyer expired** and its pictures were purged three days after.

The offers and the page numbers are unaffected either way — a citation still
names the flyer, the page and the dates. To get pictures back for a current
flyer, re-import it.

```sql
select f.retailer_id, f.page_count, f.source_filename
from public.cartmatch_flyers f
where f.valid_to >= current_date order by f.retailer_id;
```

### The wrong PDF was imported

Not every file a store publishes is a price list — a recipe booklet, a
pharmacy insert, last week's file picked by mistake. Each imports happily and
then feeds comparisons, because nothing downstream can tell that the prices
came from the wrong document. Re-importing does not help: a different file
gets a different flyer id and the wrong one stays.

Open **Import this week's flyers**, find it under "Flyers you already hold",
and press the **×**. It asks once, naming how many offers and pages will go,
and removes the offers, the queued pages and the pictures together.

A tell that a flyer is the wrong document: a page count far from the others.
A weekly circular runs sixteen or seventeen pages; seven is usually a booklet.

### A flyer says "already loaded" and was not read

Expected. A store and week already held and read in full is skipped rather
than read twice — handing over the same file again is usually not noticing it
was already done, and doing it anyway spends the day's allowance to arrive
back where you started.

To read it again anyway — correcting a flyer that was read from the wrong PDF,
or read badly — tick **"Read again if already loaded"** on the import screen
before starting. A half-read flyer is never skipped: those are exactly the
ones worth handing over again.

### An offer's price is wrong

Open **`/confirm`** from the deals screen. It queues the offers a comparison
actually depends on, shows each beside its flyer page, and offers three
verdicts: correct, different price, or wrong. "Wrong" removes it from every
comparison permanently without deleting the record.

---

## Turning risky things off

All of these are Edge Function secrets. Changing one takes effect on the next
invocation; no deploy needed.

| Secret | Set it to | Effect |
|---|---|---|
| `CARTMATCH_PAGES_PER_REQUEST` | `3` | Three pages per request — cuts a week from ~70 requests to ~24. **Unproven.** Default is `1`, the path that read 51 pages successfully. |
| `CARTMATCH_GEMINI_MODEL` | a single model id | Pins one model instead of walking the chain. Leave unset for the seven-model default. |
| `CARTMATCH_WORKER_KEY` | a new value | Rotates the worker's key. **Must** be changed in the cron job at the same time. |

To stop the worker entirely: `select cron.unschedule('cartmatch-flyer-worker');`
To start it again: the `cron.schedule` block above.

---

## Weekly routine

1. Thursday, new flyers land. Download each store's PDF.
2. Open the app → **Import additional flyers** → select them all at once.
3. **Keep the tab open for the first couple of minutes.** An overlay says so,
   with a progress bar. The PDFs are being read on this device and have not
   been sent yet, so closing during that loses the render and the files need
   handing over again. The browser will also ask before you leave.
4. When the uploads land, the overlay says so — "you can close this tab now" —
   and offers the home screen. It does not simply disappear, so there is
   nothing to watch for and nothing to guess.
5. The home card shows progress and says when it is done, with the dates the
   flyers cover and how many days are left.
6. Before shopping: **Compare flyer savings**, or scan the cart in the shop.

Storage looks after itself: page pictures are deleted three days after a flyer
expires, and the purge runs whenever the import screen is opened.

---

## What has never been tested against real data

Written down so it is not mistaken for proven:

- **Batching** (three pages per request). Every page so far was read singly,
  because they had all used an attempt before batching shipped. It is now OFF
  by default for that reason: turn it on with
  `CARTMATCH_PAGES_PER_REQUEST=3` when somebody can check the result.
- **Splitting a tile that advertises two products** ("A ou B"). The instruction
  is in the prompt; no import has run under it.
- **The request budget.** Requires `supabase/budget.sql`; the reservation has
  never actually held anything back.
- **Unbranded produce matching.** New, and unit-tested, but no real cart has
  been scanned against it.
- **The highlight box.** Offers read from now on may record where their tile
  sits on the page, and the screens draw a rectangle round it. No import has
  run under that instruction, so no stored offer has a box yet — every page
  will simply appear without a highlight until the next import. If a box is
  ever drawn in the wrong place, the reading is what is wrong, not the
  drawing: mark that offer wrong on `/confirm`.

If a Thursday import goes wrong in a way this runbook does not cover, the
fastest recovery is to clear `CARTMATCH_PAGES_PER_REQUEST` (the default of 1
is the safe one), drop the `cartmatch_api_usage` table, and re-import. That
returns the system to the configuration that read 867 offers successfully.
