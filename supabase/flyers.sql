-- ===========================================================================
-- CartMatch: stored flyers, their offers, and the pages that prove them.
--
-- Idempotent. Safe to run again after an edit.
--
-- ALREADY RAN AN EARLIER VERSION? This adds regular_basis, which the first cut
-- did not have. Run this once, then re-run the whole file:
--
--   alter table public.cartmatch_flyer_offers
--     add column if not exists regular_basis text;
--   alter table public.cartmatch_flyer_offers
--     drop constraint if exists cartmatch_flyer_offers_regular_price_cents_check;
-- ===========================================================================
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- A flyer offer is only useful at a till if the page can be shown. Until now
-- the import read prices and threw the pages away, because holding five
-- flyers' worth of full-size images kills a phone tab and nothing survived a
-- reload anyway. Storing them is what turns "IGA has it for $4.99" into "IGA,
-- page 7, valid until the 19th — here is the page".
--
-- TWO DATASETS, DIFFERENT RULES
-- ---------------------------------------------------------------------------
-- The offers are kept for six months, as history. The PAGES are kept only
-- while the flyer runs, plus a few days' grace. That asymmetry is deliberate:
-- a page image is evidence for a claim that expires, and keeping last April's
-- artwork serves nobody while costing real storage.
--
-- An expired offer is not a stale price — it is not a price at all, and
-- `classifyFreshness` already returns EXPIRED for it. The six-month history is
-- for looking back, never for comparing against a cart.
--
-- ACCESS MODEL
-- ---------------------------------------------------------------------------
-- Matches supabase/policies.sql exactly: this Supabase project is shared with
-- five other apps, so membership of the project is NOT permission to use
-- CartMatch. Every policy asks public.has_app_access('cartmatch') first, and
-- then narrows to the row's owner.
--
-- Reads widen for app_admin. Writes never widen: an admin may look at a
-- support case, and may not write a price into somebody else's account.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The flyer: one imported document
-- ---------------------------------------------------------------------------
create table if not exists public.cartmatch_flyers (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  retailer_id text not null,

  -- Required, both of them. An offer with no end date cannot back a claim at a
  -- till, because "still valid?" is the first thing asked — so a flyer that
  -- cannot answer it has no business producing offers.
  valid_from date not null,
  valid_to date not null,

  page_count integer not null check (page_count > 0),
  pages_read integer not null default 0,
  -- The filename as uploaded. Kept so a person can tell two imports apart when
  -- the dates and retailer are identical.
  source_filename text,
  -- Where the run dates came from: a retailer's own filename, or a model
  -- reading the cover. Different confidence, recorded rather than forgotten.
  validity_source text not null default 'UNKNOWN'
    check (validity_source in ('FILENAME', 'COVER', 'MANUAL', 'UNKNOWN')),
  created_at timestamptz not null default now(),

  constraint cartmatch_flyers_window check (valid_to >= valid_from)
);

-- One flyer per retailer per week per person. A re-import corrects rather than
-- duplicating, and a duplicate offer is a second chance to show a stale price
-- after the first has been fixed.
create unique index if not exists cartmatch_flyers_unique_week
  on public.cartmatch_flyers (user_id, retailer_id, valid_from);

create index if not exists cartmatch_flyers_current
  on public.cartmatch_flyers (user_id, valid_to);

-- ---------------------------------------------------------------------------
-- 2. The offers read off it
-- ---------------------------------------------------------------------------
create table if not exists public.cartmatch_flyer_offers (
  id text primary key,
  flyer_id text not null references public.cartmatch_flyers(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,

  -- The product as the FLYER describes it, verbatim and untranslated, so the
  -- matcher works from what was printed and a person comparing the app against
  -- the paper sees the same words.
  advertised_text text not null,
  brand text,
  size text,
  -- The retailer's own article number where the flyer prints one. Exact within
  -- that retailer; meaningless at any other.
  retailer_sku text,

  -- Integer cents. Never a float: 7.49 * 100 is 748.9999999999999.
  price_cents integer not null check (price_cents >= 0),
  currency text not null default 'CAD' check (currency = 'CAD'),
  regular_price_cents integer,
  -- What the REGULAR price is per. Not always what the sale price is per: IGA
  -- prints "$6.49 /lb ... Reg. 30,99$/kg" on one tile, and reading both as the
  -- same unit advertises a saving four times the real one.
  regular_basis text
    check (regular_basis in ('PER_ITEM','PER_LB','PER_KG','PER_100G','PER_100ML')),
  -- The sanity check only applies within a unit. Across units it says nothing:
  -- 30.99 per kg is genuinely not "above" 6.49 per lb as a number, and it is
  -- the higher price.
  constraint cartmatch_offer_regular_above_sale check (
    regular_price_cents is null
    or regular_basis is distinct from basis
    or regular_price_cents > price_cents
  ),

  -- What the price is the price OF. A price per pound is not a price per
  -- package, and subtracting one from the other invents a saving.
  basis text not null
    check (basis in ('PER_ITEM', 'PER_LB', 'PER_KG', 'PER_100G', 'PER_100ML')),

  condition text not null
    check (condition in ('UNIT_PRICE','MULTI_BUY','LOYALTY_ONLY','LIMIT_APPLIES','WITH_PURCHASE')),
  condition_text text,

  flyer_page integer not null check (flyer_page > 0),

  -- Every official flyer PDF measured is artwork, so nothing in it can be
  -- corroborated against the file's own text. An offer is a CANDIDATE until a
  -- person has looked at the page and agreed, and only a confirmed offer may
  -- be put in front of a cashier.
  confirmed_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists cartmatch_flyer_offers_by_flyer
  on public.cartmatch_flyer_offers (flyer_id);

create index if not exists cartmatch_flyer_offers_lookup
  on public.cartmatch_flyer_offers (user_id, advertised_text);

-- ---------------------------------------------------------------------------
-- 3. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.cartmatch_flyers enable row level security;
alter table public.cartmatch_flyer_offers enable row level security;

drop policy if exists "cartmatch_flyers select (cartmatch)" on public.cartmatch_flyers;
create policy "cartmatch_flyers select (cartmatch)"
  on public.cartmatch_flyers
  for select to authenticated
  using (
    public.has_app_access('cartmatch')
    and (public.app_role('cartmatch') = 'app_admin' or user_id = auth.uid())
  );

drop policy if exists "cartmatch_flyers insert (cartmatch)" on public.cartmatch_flyers;
create policy "cartmatch_flyers insert (cartmatch)"
  on public.cartmatch_flyers
  for insert to authenticated
  with check (public.has_app_access('cartmatch') and user_id = auth.uid());

drop policy if exists "cartmatch_flyers update (cartmatch)" on public.cartmatch_flyers;
create policy "cartmatch_flyers update (cartmatch)"
  on public.cartmatch_flyers
  for update to authenticated
  using (public.has_app_access('cartmatch') and user_id = auth.uid())
  with check (public.has_app_access('cartmatch') and user_id = auth.uid());

drop policy if exists "cartmatch_flyers delete (cartmatch)" on public.cartmatch_flyers;
create policy "cartmatch_flyers delete (cartmatch)"
  on public.cartmatch_flyers
  for delete to authenticated
  using (public.has_app_access('cartmatch') and user_id = auth.uid());

drop policy if exists "cartmatch_flyer_offers select (cartmatch)" on public.cartmatch_flyer_offers;
create policy "cartmatch_flyer_offers select (cartmatch)"
  on public.cartmatch_flyer_offers
  for select to authenticated
  using (
    public.has_app_access('cartmatch')
    and (public.app_role('cartmatch') = 'app_admin' or user_id = auth.uid())
  );

drop policy if exists "cartmatch_flyer_offers insert (cartmatch)" on public.cartmatch_flyer_offers;
create policy "cartmatch_flyer_offers insert (cartmatch)"
  on public.cartmatch_flyer_offers
  for insert to authenticated
  with check (public.has_app_access('cartmatch') and user_id = auth.uid());

drop policy if exists "cartmatch_flyer_offers update (cartmatch)" on public.cartmatch_flyer_offers;
create policy "cartmatch_flyer_offers update (cartmatch)"
  on public.cartmatch_flyer_offers
  for update to authenticated
  using (public.has_app_access('cartmatch') and user_id = auth.uid())
  with check (public.has_app_access('cartmatch') and user_id = auth.uid());

drop policy if exists "cartmatch_flyer_offers delete (cartmatch)" on public.cartmatch_flyer_offers;
create policy "cartmatch_flyer_offers delete (cartmatch)"
  on public.cartmatch_flyer_offers
  for delete to authenticated
  using (public.has_app_access('cartmatch') and user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. The page images
-- ---------------------------------------------------------------------------
-- PRIVATE, deliberately. These are pages of a copyrighted flyer held for one
-- shopper's own use; a public bucket would publish them to anyone who guessed
-- a path. Reading goes through a signed URL that expires.
insert into storage.buckets (id, name, public)
values ('cartmatch-flyers', 'cartmatch-flyers', false)
on conflict (id) do nothing;

-- Paths are  <user_id>/<flyer_id>/p<N>.jpg
-- The first segment IS the ownership check: storage.foldername()[1] must be
-- the caller's own id, so one person's pages are unreachable to another even
-- with a guessed path.
drop policy if exists "cartmatch flyer pages read" on storage.objects;
create policy "cartmatch flyer pages read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'cartmatch-flyers'
    and public.has_app_access('cartmatch')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "cartmatch flyer pages write" on storage.objects;
create policy "cartmatch flyer pages write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'cartmatch-flyers'
    and public.has_app_access('cartmatch')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "cartmatch flyer pages replace" on storage.objects;
create policy "cartmatch flyer pages replace"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'cartmatch-flyers'
    and public.has_app_access('cartmatch')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "cartmatch flyer pages delete" on storage.objects;
create policy "cartmatch flyer pages delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'cartmatch-flyers'
    and public.has_app_access('cartmatch')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- 5. Retention
-- ---------------------------------------------------------------------------
-- Offers older than six months are deleted; the flyers they belong to go with
-- them. Page images are removed separately by the app once a flyer's window
-- has closed, because Postgres cannot delete from object storage.
--
-- Run from the SQL editor, or schedule with pg_cron if it is enabled:
--   select cron.schedule('cartmatch-purge', '0 4 * * *',
--                        $$select public.cartmatch_purge_old_flyers()$$);
create or replace function public.cartmatch_purge_old_flyers()
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  -- SECURITY INVOKER on purpose: this runs as whoever calls it, so RLS still
  -- applies and nobody purges another account's data by calling it.
  delete from public.cartmatch_flyers
  where valid_to < (current_date - interval '6 months')
  returning 1 into removed;

  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Check it worked
-- ---------------------------------------------------------------------------
-- Expect two tables, eight policies, one bucket, four storage policies.
--
--   select tablename, policyname from pg_policies
--   where tablename like 'cartmatch_flyer%' order by 1, 2;
--
--   select id, public from storage.buckets where id = 'cartmatch-flyers';
--
--   select policyname from pg_policies
--   where tablename = 'objects' and policyname like 'cartmatch flyer%';
