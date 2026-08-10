-- ---------------------------------------------------------------------------
-- CartMatch schema for an existing Supabase project.
--
-- Apply once:  psql "$SUPABASE_DB_URL" -f supabase/schema.sql
-- or paste into the Supabase SQL editor.
--
-- ---------------------------------------------------------------------------
-- THIS FILE ALONE LEAVES THE APP NON-FUNCTIONAL, ON PURPOSE.
-- ---------------------------------------------------------------------------
-- It enables RLS and creates no policies, which permits nothing. You must also
-- run supabase/policies.sql, which applies the platform access model
-- (has_app_access('cartmatch') + per-user ownership). Until then every read
-- returns zero rows and every write is refused.
--
-- Design notes
--   * Tables are prefixed `cartmatch_` so they sit safely beside the other five
--     apps sharing this project.
--   * Each row keeps the whole domain object in `payload jsonb`, with the
--     frequently-filtered fields promoted to real columns. Adding a field to a
--     TypeScript type therefore needs no migration.
--   * No foreign keys between these tables, deliberately. They are linked by
--     loose text ids. If you ever add an FK, do NOT attach `on delete cascade`:
--     with per-user rows and an app_admin who can read across users, that is
--     the shape that lets one person's delete destroy another person's history.
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

-- Deny by default. policies.sql grants the app what it needs.
alter table public.cartmatch_price_observations enable row level security;
alter table public.cartmatch_audit_records      enable row level security;
alter table public.cartmatch_validations        enable row level security;

-- ---------------------------------------------------------------------------
-- NO VIEWS HERE, AND THAT IS THE POINT.
-- ---------------------------------------------------------------------------
-- An earlier version of this file created a `cartmatch_retailer_reliability`
-- view aggregating cartmatch_validations, without `security_invoker = true`.
-- A view defaults to running with its OWNER's rights, so it reads its base
-- table with RLS bypassed — and PostgREST publishes views at /rest/v1/<view>.
-- That is a full read of every user's rows for anyone holding the publishable
-- key, with no policy change for an audit to notice. The same mistake on a
-- sibling app on this project exposed every invoice.
--
-- It was also dead: nothing in src/ ever queried it.
--
-- If you add a view here, give it `with (security_invoker = true)` in the same
-- statement that creates it — never in a separate file that someone might not
-- run, because then whether the project is safe depends on the order two files
-- happened to be executed in. For anything that must aggregate ACROSS users,
-- see the note at the end of policies.sql: that is a SECURITY DEFINER function
-- with a pinned search_path, not a view.
