-- ---------------------------------------------------------------------------
-- CartMatch RLS policies — REQUIRED for the GitHub Pages deployment.
--
-- Apply AFTER schema.sql. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE EXISTS NOW AND DID NOT BEFORE
-- ---------------------------------------------------------------------------
-- The first version of CartMatch wrote to these tables from a server using the
-- Supabase SECRET (service-role) key, which bypasses RLS. RLS was therefore
-- enabled with NO policies: nothing but that key could touch the data.
--
-- On GitHub Pages there is no server. The secret key can never go in a static
-- bundle — it bypasses every protection you have, and this repository is
-- public. So the browser writes with the ordinary authenticated session
-- instead, and Postgres decides what is allowed.
--
-- That is a STRONGER arrangement, not a weaker one. Before, any code holding
-- the secret key could write anything. Now the database itself enforces that
-- a row can only be written as yourself, whatever the client sends.
--
-- ---------------------------------------------------------------------------
-- WHAT THESE POLICIES GRANT
-- ---------------------------------------------------------------------------
--   * Only the `authenticated` role. Anonymous visitors get nothing, even
--     though they can load the site — which they can, because it is a public
--     static page. This is the line that actually protects your data.
--   * INSERT only where user_id = auth.uid(). A signed-in person cannot forge
--     a row as someone else; `with check` is evaluated by Postgres after the
--     client's values are applied.
--   * SELECT only your own rows. Note this CHANGES the /admin view: each
--     person now sees their own runs rather than everyone's. If you would
--     rather everyone admitted sees everything, swap the SELECT policies for
--     the shared variant at the bottom of this file — deliberately, not by
--     accident.
--   * No UPDATE and no DELETE. The audit trail is append-only, which is the
--     point of an audit trail. Delete from the SQL editor if you need to.
-- ---------------------------------------------------------------------------

-- 1. Add the owner column the policies key on. ------------------------------
alter table public.cartmatch_price_observations
  add column if not exists user_id uuid default auth.uid();
alter table public.cartmatch_audit_records
  add column if not exists user_id uuid default auth.uid();
alter table public.cartmatch_validations
  add column if not exists user_id uuid default auth.uid();

create index if not exists cartmatch_obs_user_idx
  on public.cartmatch_price_observations (user_id, created_at desc);
create index if not exists cartmatch_audit_user_idx
  on public.cartmatch_audit_records (user_id, created_at desc);
create index if not exists cartmatch_validations_user_idx
  on public.cartmatch_validations (user_id, created_at desc);

-- 2. Drop any earlier version of these policies so the file is re-runnable. --
drop policy if exists cartmatch_obs_insert_own   on public.cartmatch_price_observations;
drop policy if exists cartmatch_obs_select_own   on public.cartmatch_price_observations;
drop policy if exists cartmatch_audit_insert_own on public.cartmatch_audit_records;
drop policy if exists cartmatch_audit_select_own on public.cartmatch_audit_records;
drop policy if exists cartmatch_val_insert_own   on public.cartmatch_validations;
drop policy if exists cartmatch_val_select_own   on public.cartmatch_validations;

-- 3. Price observations ------------------------------------------------------
create policy cartmatch_obs_insert_own
  on public.cartmatch_price_observations
  for insert to authenticated
  with check (user_id = auth.uid());

create policy cartmatch_obs_select_own
  on public.cartmatch_price_observations
  for select to authenticated
  using (user_id = auth.uid());

-- 4. Audit records -----------------------------------------------------------
create policy cartmatch_audit_insert_own
  on public.cartmatch_audit_records
  for insert to authenticated
  with check (user_id = auth.uid());

create policy cartmatch_audit_select_own
  on public.cartmatch_audit_records
  for select to authenticated
  using (user_id = auth.uid());

-- 5. Validation reports ------------------------------------------------------
create policy cartmatch_val_insert_own
  on public.cartmatch_validations
  for insert to authenticated
  with check (user_id = auth.uid());

create policy cartmatch_val_select_own
  on public.cartmatch_validations
  for select to authenticated
  using (user_id = auth.uid());

-- 6. The reliability view must not leak across users. ------------------------
-- security_invoker makes the view run with the CALLER's permissions, so the
-- RLS policies above apply to it. Without this, a view owned by a privileged
-- role would happily return everyone's rows to anyone who selected from it.
create or replace view public.cartmatch_retailer_reliability
with (security_invoker = true) as
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

-- ---------------------------------------------------------------------------
-- OPTIONAL: shared visibility instead of per-user.
--
-- Run this ONLY if you want every admitted user to see everyone's runs — which
-- is how the app behaved before this file existed. It is a real change: the
-- audit trail contains every product scanned, every price, and the postal code
-- of each run.
--
--   drop policy if exists cartmatch_obs_select_own   on public.cartmatch_price_observations;
--   drop policy if exists cartmatch_audit_select_own on public.cartmatch_audit_records;
--   drop policy if exists cartmatch_val_select_own   on public.cartmatch_validations;
--
--   create policy cartmatch_obs_select_all   on public.cartmatch_price_observations
--     for select to authenticated using (true);
--   create policy cartmatch_audit_select_all on public.cartmatch_audit_records
--     for select to authenticated using (true);
--   create policy cartmatch_val_select_all   on public.cartmatch_validations
--     for select to authenticated using (true);
--
-- Inserts stay per-user either way: nobody can write a row as someone else.
-- ---------------------------------------------------------------------------
