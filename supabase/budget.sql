-- ===========================================================================
-- CartMatch: counting the requests this app sends, so it can stop before the
-- door is shut in somebody's face.
--
-- Idempotent. Run after supabase/flyers.sql and supabase/worker.sql.
-- ===========================================================================
--
-- WHY
-- ---------------------------------------------------------------------------
-- Everything built so far handles a quota AFTER it is hit: walk the model
-- chain, do not burn a page's attempts, requeue, report the ceiling. Nothing
-- anticipates.
--
-- That was survivable while the worker and the scan drew on different lists.
-- They now share one chain, so a Thursday import walking down from 3.7-flash
-- can spend every full model's twenty before a shopper standing in a shop asks
-- for one photograph. The import can wait an hour; the shopper cannot.
--
-- So the worker holds back a few requests on each model and the scan does not.
-- The reservation is the whole point: an interactive request that fails is a
-- person stuck at a shelf, and a scheduled one that waits is nothing at all.
--
-- ---------------------------------------------------------------------------
-- THE DAY BOUNDARY IS PACIFIC, NOT LOCAL, NOT UTC
-- ---------------------------------------------------------------------------
-- Google's free-tier daily counters reset at midnight Pacific. A counter that
-- rolled over at midnight in Montreal would clear itself three hours early and
-- cheerfully report headroom that does not exist — which is worse than no
-- counter, because it would be believed.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS NUMBER IS AND IS NOT
-- ---------------------------------------------------------------------------
-- It counts what THIS APP sent. Google counts everything the project sent, and
-- the key belongs to a project that may serve other things. So this is a FLOOR
-- on usage, never the truth: if it says twelve, at least twelve were spent.
-- Treating it as exact is how a budget becomes a false reassurance.
-- ===========================================================================

create table if not exists public.cartmatch_api_usage (
  -- Pacific, to match where Google's counter turns over.
  day date not null default (now() at time zone 'America/Los_Angeles')::date,
  model text not null,
  requests integer not null default 0,
  primary key (day, model)
);

alter table public.cartmatch_api_usage enable row level security;

-- Readable by anybody with app access, because the quota is not one person's
-- property: it belongs to the API key, and every user of this deployment is
-- spending the same allowance.
drop policy if exists "cartmatch_api_usage select (cartmatch)" on public.cartmatch_api_usage;
create policy "cartmatch_api_usage select (cartmatch)"
  on public.cartmatch_api_usage
  for select to authenticated
  using (public.has_app_access('cartmatch'));

-- No insert or update policy. The counter is only ever moved by the function
-- below, which is SECURITY DEFINER: a client that could write it directly
-- could also write it back down, and a budget somebody can quietly reset is
-- not a budget.

-- ---------------------------------------------------------------------------
-- Recording one request
-- ---------------------------------------------------------------------------
-- Called after the request is sent, not before. A request that was refused
-- still counted against the quota at Google's end — a 429 is a request — so
-- counting on the way out rather than on success keeps this number honest in
-- the one situation it exists for.
create or replace function public.cartmatch_note_request(model_name text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  total integer;
begin
  insert into public.cartmatch_api_usage (day, model, requests)
  values ((now() at time zone 'America/Los_Angeles')::date, model_name, 1)
  on conflict (day, model)
    do update set requests = public.cartmatch_api_usage.requests + 1
  returning requests into total;
  return total;
end;
$$;

grant execute on function public.cartmatch_note_request(text) to authenticated;

-- ---------------------------------------------------------------------------
-- What has been spent today
-- ---------------------------------------------------------------------------
create or replace function public.cartmatch_requests_today()
returns table (model text, requests integer)
language sql
security definer
set search_path = public, pg_temp
as $$
  select u.model, u.requests
    from public.cartmatch_api_usage u
   where u.day = (now() at time zone 'America/Los_Angeles')::date;
$$;

grant execute on function public.cartmatch_requests_today() to authenticated;

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
-- One row per model per day is a few hundred rows a year and is worth keeping:
-- it is the only record of what this app actually spends. Trim it at two years
-- if you ever want to.
--
--   delete from public.cartmatch_api_usage where day < current_date - 730;

-- ---------------------------------------------------------------------------
-- Check it worked
-- ---------------------------------------------------------------------------
--   select * from public.cartmatch_requests_today();
--   select day, model, requests from public.cartmatch_api_usage order by day desc, requests desc limit 20;
