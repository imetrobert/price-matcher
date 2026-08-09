-- ---------------------------------------------------------------------------
-- CartMatch schema for an existing Supabase project.
--
-- Apply once:  psql "$SUPABASE_DB_URL" -f supabase/schema.sql
-- or paste into the Supabase SQL editor.
--
-- Design notes
--   * Tables are prefixed `cartmatch_` so they sit safely beside whatever else
--     already lives in your project.
--   * Each row keeps the whole domain object in `payload jsonb`, with the
--     frequently-filtered fields promoted to real columns. Adding a field to a
--     TypeScript type therefore needs no migration.
--   * RLS is ON with no policies: only the service-role key (used server-side
--     by CartMatch) can read or write. The browser never touches these tables.
-- ---------------------------------------------------------------------------

create table if not exists public.cartmatch_price_observations (
  id                    text primary key,
  created_at            timestamptz not null default now(),
  retailer_id           text not null,
  canonical_product_id  text not null,
  price_cents           integer not null,
  is_mock               boolean not null default false,
  payload               jsonb not null
);

create index if not exists cartmatch_obs_product_idx
  on public.cartmatch_price_observations (canonical_product_id, created_at desc);
create index if not exists cartmatch_obs_retailer_idx
  on public.cartmatch_price_observations (retailer_id, created_at desc);

-- Audit trail: why every displayed (or suppressed) result was decided.
create table if not exists public.cartmatch_audit_records (
  id                      text primary key,
  created_at              timestamptz not null default now(),
  run_id                  text not null,
  canonical_product_id    text not null,
  current_retailer_id     text not null,
  competitor_retailer_id  text,
  savings_cents           integer,
  eligibility             text not null,
  is_mock                 boolean not null default false,
  payload                 jsonb not null
);

create index if not exists cartmatch_audit_run_idx
  on public.cartmatch_audit_records (run_id);
create index if not exists cartmatch_audit_created_idx
  on public.cartmatch_audit_records (created_at desc);

-- "Verify This Match": what actually happened at the till.
create table if not exists public.cartmatch_validations (
  id                      text primary key,
  created_at              timestamptz not null default now(),
  opportunity_id          text,
  retailer_id             text not null,
  competitor_retailer_id  text not null,
  price_matched           boolean,
  request_accepted        boolean,
  payload                 jsonb not null
);

create index if not exists cartmatch_validations_competitor_idx
  on public.cartmatch_validations (competitor_retailer_id, created_at desc);

-- Lock everything down. No policies == service-role-only access.
alter table public.cartmatch_price_observations enable row level security;
alter table public.cartmatch_audit_records      enable row level security;
alter table public.cartmatch_validations        enable row level security;

-- Measured retailer reliability, straight from real-world feedback.
-- This is the query that should eventually drive `priceReliability`
-- in src/config/retailers.ts — replacing assumptions with evidence.
create or replace view public.cartmatch_retailer_reliability as
select
  competitor_retailer_id                                as retailer_id,
  count(*)                                              as reports,
  count(*) filter (where price_matched)                 as price_confirmed,
  count(*) filter (where request_accepted)              as match_accepted,
  round(
    100.0 * count(*) filter (where price_matched) / nullif(count(*), 0),
    1
  )                                                     as price_accuracy_pct
from public.cartmatch_validations
group by competitor_retailer_id;
