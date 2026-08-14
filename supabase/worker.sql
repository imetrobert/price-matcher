-- ===========================================================================
-- CartMatch: the page queue, so a flyer finishes without the tab staying open.
--
-- Idempotent. Run after supabase/flyers.sql.
-- ===========================================================================
--
-- WHY
-- ---------------------------------------------------------------------------
-- Reading a seventeen-page flyer takes upwards of half an hour, nearly all of
-- it waiting out an API quota. Until now the browser drove that loop, so the
-- tab had to stay open — and on an iPhone Safari suspends background tabs, so
-- even an open tab stalls when the screen locks.
--
-- The work splits at a natural seam. The browser does the part only it can do
-- — render the PDF, which never leaves the device — uploads the page images,
-- and writes a row here per page. That takes about two minutes. Everything
-- after is a scheduled function working through this table.
--
-- A quota that resets tomorrow morning is then simply picked up by the next
-- tick, rather than needing somebody to notice and re-run.
--
-- WHAT MAKES THIS SAFE TO LEAVE ALONE
-- ---------------------------------------------------------------------------
-- Every row carries the user it belongs to, and the worker writes offers with
-- that id — so RLS still governs who can read them afterwards, even though the
-- worker itself runs with service credentials because no user session exists
-- at three in the morning.
--
-- `attempts` is the stop. A page that has failed too many times is left alone
-- rather than retried forever: a wrong model name or a corrupt image fails
-- identically however often it is asked, and a queue that never drains is a
-- quota spent on nothing.
-- ===========================================================================

create table if not exists public.cartmatch_flyer_pages (
  id text primary key,
  flyer_id text not null references public.cartmatch_flyers(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,

  page_number integer not null check (page_number > 0),
  -- Where the extraction-sized image sits while it waits to be read. Deleted
  -- once the page is done: it is several times the size of the proof image and
  -- has no use after the offers are out.
  storage_path text not null,

  status text not null default 'PENDING'
    check (status in ('PENDING', 'READING', 'DONE', 'FAILED')),
  attempts integer not null default 0,
  last_error text,
  -- Which model actually answered. Different pages of one flyer can be read by
  -- different models when the first choice is busy, and knowing which is what
  -- makes a bad batch traceable.
  model text,

  offers_found integer,
  created_at timestamptz not null default now(),
  -- Set when a worker takes the page, so a second worker does not take it too.
  claimed_at timestamptz,
  read_at timestamptz
);

create unique index if not exists cartmatch_flyer_pages_unique
  on public.cartmatch_flyer_pages (flyer_id, page_number);

-- The worker's query: oldest pending first, so a flyer finishes before the
-- next one starts and a half-read flyer does not sit behind a fresh one.
create index if not exists cartmatch_flyer_pages_queue
  on public.cartmatch_flyer_pages (status, created_at)
  where status in ('PENDING', 'READING');

alter table public.cartmatch_flyer_pages enable row level security;

drop policy if exists "cartmatch_flyer_pages select (cartmatch)" on public.cartmatch_flyer_pages;
create policy "cartmatch_flyer_pages select (cartmatch)"
  on public.cartmatch_flyer_pages
  for select to authenticated
  using (
    public.has_app_access('cartmatch')
    and (public.app_role('cartmatch') = 'app_admin' or user_id = auth.uid())
  );

drop policy if exists "cartmatch_flyer_pages insert (cartmatch)" on public.cartmatch_flyer_pages;
create policy "cartmatch_flyer_pages insert (cartmatch)"
  on public.cartmatch_flyer_pages
  for insert to authenticated
  with check (public.has_app_access('cartmatch') and user_id = auth.uid());

drop policy if exists "cartmatch_flyer_pages delete (cartmatch)" on public.cartmatch_flyer_pages;
create policy "cartmatch_flyer_pages delete (cartmatch)"
  on public.cartmatch_flyer_pages
  for delete to authenticated
  using (public.has_app_access('cartmatch') and user_id = auth.uid());

-- No update policy for `authenticated` on purpose. Status is the worker's to
-- set, and a browser marking its own pages DONE would let a page be recorded
-- as read without anything having read it.

-- ---------------------------------------------------------------------------
-- Recovering a page a worker took and never finished
-- ---------------------------------------------------------------------------
-- A function timing out mid-page leaves the row READING forever. Ten minutes
-- is far longer than a page takes and far shorter than a person waits.
create or replace function public.cartmatch_release_stale_pages()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  released integer;
begin
  update public.cartmatch_flyer_pages
     set status = 'PENDING', claimed_at = null
   where status = 'READING'
     and claimed_at < now() - interval '10 minutes';
  get diagnostics released = row_count;
  return released;
end;
$$;

-- ---------------------------------------------------------------------------
-- Scheduling
-- ---------------------------------------------------------------------------
-- Needs pg_cron and pg_net, both available on the free plan:
--
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--
-- Then, replacing <ref> with your project ref and <worker-key> with the value
-- you set as CARTMATCH_WORKER_KEY in Edge Function secrets:
--
--   select cron.schedule(
--     'cartmatch-flyer-worker',
--     '* * * * *',
--     $job$
--     select net.http_post(
--       url := 'https://<ref>.supabase.co/functions/v1/cartmatch-flyer-worker',
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         'x-cartmatch-worker-key', '<worker-key>'
--       ),
--       body := '{}'::jsonb
--     );
--     $job$
--   );
--
-- Every minute, because the worker reads a couple of pages per tick and then
-- returns. Long-running work in a scheduled function is how a function gets
-- killed halfway through and leaves rows claimed; short ticks recover
-- naturally.
--
-- To stop it:   select cron.unschedule('cartmatch-flyer-worker');
-- To watch it:  select * from cron.job_run_details order by start_time desc limit 20;

-- ---------------------------------------------------------------------------
-- Check it worked
-- ---------------------------------------------------------------------------
--   select status, count(*) from public.cartmatch_flyer_pages group by 1;
--   select * from public.cartmatch_flyer_pages
--     where status = 'FAILED' order by created_at desc limit 10;

-- ---------------------------------------------------------------------------
-- Keeping the flyer's page tally current
-- ---------------------------------------------------------------------------
-- The home screen answers "do I have this week's prices?" from pages_read
-- against page_count. The worker finishes pages one at a time, so something
-- has to keep that number honest without the browser being involved.
--
-- SECURITY DEFINER because the worker calls it with service credentials on
-- behalf of a user who is not signed in. It touches nothing but the counter,
-- and derives it rather than accepting it — a caller cannot claim a flyer is
-- fully read.
create or replace function public.cartmatch_recount_flyer(flyer text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  done integer;
begin
  select count(*) into done
    from public.cartmatch_flyer_pages
   where flyer_id = flyer and status = 'DONE';

  update public.cartmatch_flyers
     set pages_read = done
   where id = flyer;

  return done;
end;
$$;
