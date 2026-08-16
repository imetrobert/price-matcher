-- ---------------------------------------------------------------------------
-- CartMatch product corrections — what people fixed, so the next scan is right.
--
-- Apply after schema.sql and policies.sql. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- A cart photograph gets a product roughly right and one field wrong, and it
-- gets the SAME field wrong every week: the same tub is photographed at the
-- same angle in the same shop, so the size is unreadable every time and gets
-- typed in every time. The model does not remember, so a person is asked to
-- correct an identical mistake indefinitely.
--
-- This is that memory. When somebody fixes a reading, the fix is stored against
-- the reading it corrected. Next time the model produces that same reading,
-- the correction is applied before anybody is asked anything.
--
-- ---------------------------------------------------------------------------
-- WHY IT IS SHARED, AND WHAT THAT MEANS
-- ---------------------------------------------------------------------------
-- Everybody with access to this app reads everybody's corrections. That is the
-- point: the second person to photograph a tub of Oikos benefits from the
-- first person's typing, and the app gets better as it is used rather than
-- staying exactly as good as the day it was written.
--
-- The honest consequence: a correction is visible to every member. It holds
-- product names, brands, variants and sizes — what somebody typed about a
-- GROCERY ITEM, not about themselves. No prices, no carts, no photographs, no
-- times, no places. Somebody's shopping is not derivable from "Oikos Pink
-- Lemonade is 650 g". `user_id` records who wrote a row so it can be corrected
-- or removed later; it is never shown next to the product.
--
-- ---------------------------------------------------------------------------
-- HOW DISAGREEMENT IS SETTLED
-- ---------------------------------------------------------------------------
-- Each person holds one row per reading, so two people who disagree produce
-- two rows rather than overwriting each other. The app prefers your own
-- correction; failing that, the value the most people wrote; failing that, the
-- most recent. Nobody can edit anybody else's row, which is enforced by the
-- policy below rather than by convention.
--
-- ---------------------------------------------------------------------------
-- WHY A CORRECTION IS NOT A FACT
-- ---------------------------------------------------------------------------
-- It is one person's reading of one package on one day. Packs get resized,
-- people mistype, and a shared table means somebody else's mistake can reach
-- your screen. So a correction is applied with its provenance attached and the
-- app says where the value came from — it never silently becomes something the
-- camera claims to have read.
-- ---------------------------------------------------------------------------

create table if not exists public.cartmatch_product_corrections (
  -- Fingerprint and author together, so each person holds exactly one row per
  -- reading: correcting the same thing twice updates your row instead of
  -- forking into rival answers, and nobody's row is ever the same row as
  -- somebody else's.
  id             text primary key,

  -- What the model said, normalised. The lookup key: the app computes this
  -- from a fresh reading and asks whether anybody has fixed it before.
  fingerprint    text not null,

  -- What it should have said. Null means "no correction offered for this
  -- field", which is different from an empty string.
  brand          text,
  product_name   text,
  variant        text,
  size           text,

  -- Who typed it, for accountability and for preferring your own corrections
  -- over a stranger's. Never displayed beside the product.
  user_id        uuid not null default auth.uid()
                 references auth.users(id) on delete cascade,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Cheap guards. The app validates too, but the app is public code running on
  -- somebody else's device and the database is not.
  constraint cartmatch_corrections_fingerprint_ck
    check (length(fingerprint) between 1 and 200),
  constraint cartmatch_corrections_brand_ck
    check (brand is null or length(brand) <= 100),
  constraint cartmatch_corrections_name_ck
    check (product_name is null or length(product_name) <= 200),
  constraint cartmatch_corrections_variant_ck
    check (variant is null or length(variant) <= 100),
  constraint cartmatch_corrections_size_ck
    check (size is null or length(size) <= 60),
  -- A row correcting nothing is noise that would still be read, ranked and
  -- applied as an empty answer.
  constraint cartmatch_corrections_not_empty_ck
    check (brand is not null or product_name is not null
           or variant is not null or size is not null)
);

-- The lookup this table exists to serve. Every scan does one query per
-- detected product, so it runs several times a second during a scan.
create index if not exists cartmatch_corrections_fingerprint_idx
  on public.cartmatch_product_corrections (fingerprint);

-- updated_at belongs to the database, not to a phone's clock.
drop trigger if exists cartmatch_corrections_touch
  on public.cartmatch_product_corrections;
create trigger cartmatch_corrections_touch
  before update on public.cartmatch_product_corrections
  for each row execute function public.cartmatch_touch_updated_at();

alter table public.cartmatch_product_corrections enable row level security;

drop policy if exists "cartmatch_corrections select (cartmatch)"
  on public.cartmatch_product_corrections;
drop policy if exists "cartmatch_corrections insert (cartmatch)"
  on public.cartmatch_product_corrections;
drop policy if exists "cartmatch_corrections update (cartmatch)"
  on public.cartmatch_product_corrections;
drop policy if exists "cartmatch_corrections delete (cartmatch)"
  on public.cartmatch_product_corrections;

-- Anyone with access to the app reads all of them. This is the one table in
-- the schema where that is intended rather than tolerated — shared learning is
-- the feature, and a correction is a statement about a grocery product.
create policy "cartmatch_corrections select (cartmatch)"
  on public.cartmatch_product_corrections
  for select using (public.has_app_access('cartmatch'));

create policy "cartmatch_corrections insert (cartmatch)"
  on public.cartmatch_product_corrections
  for insert with check (
    public.has_app_access('cartmatch') and user_id = auth.uid()
  );

-- Your own rows only.
--
-- An earlier draft let any member update any row, with a comment claiming the
-- corrected values "stay owned". They would not have: a policy's WITH CHECK
-- sees the new row and cannot compare it against the old one, so there was
-- nothing stopping one member rewriting what every other member's scan
-- produces. Agreement is counted by how many people independently wrote the
-- same value, which needs no cross-user writes at all.
create policy "cartmatch_corrections update (cartmatch)"
  on public.cartmatch_product_corrections
  for update using (
    public.has_app_access('cartmatch') and user_id = auth.uid()
  )
  with check (
    public.has_app_access('cartmatch') and user_id = auth.uid()
  );

-- Deleting is limited to your own, and to admins clearing out a bad one.
create policy "cartmatch_corrections delete (cartmatch)"
  on public.cartmatch_product_corrections
  for delete using (
    public.has_app_access('cartmatch')
    and (user_id = auth.uid() or public.app_role('cartmatch') = 'app_admin')
  );
