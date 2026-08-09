-- ---------------------------------------------------------------------------
-- CartMatch RLS — the "personal" shape from the platform access model.
--
-- Apply AFTER schema.sql.
--
-- ---------------------------------------------------------------------------
-- RE-RUNNING THIS FILE
-- ---------------------------------------------------------------------------
-- Safe, but only because every policy below is dropped by name first AND the
-- names match what this file creates. If the policies deployed on the project
-- were created under different names, dropping by name misses them and these
-- would be ADDED alongside — and Postgres OR-s permissive policies together, so
-- the effective grant would be the WIDER of the two. Check what is actually
-- live before running this on a project you did not set up:
--
--   select tablename, policyname, cmd, roles::text, qual, with_check
--   from pg_policies
--   where schemaname = 'public' and tablename like 'cartmatch%'
--   order by tablename, policyname;
--
-- Every expression must mention has_app_access. If one does not, this file is
-- not what is deployed.
--
-- ---------------------------------------------------------------------------
-- WHY has_app_access AND NOT "authenticated"
-- ---------------------------------------------------------------------------
-- This Supabase project is shared by six apps. Auth is per PROJECT, so every
-- account can sign in to every app, and `to authenticated` therefore means
-- "anyone with an account on any of the six" — it describes the session, not
-- entitlement to CartMatch.
--
-- An earlier version of this file used exactly that, plus user_id = auth.uid().
-- It looked like access control and was not: revoking someone's CartMatch grant
-- in public.app_access would have changed nothing here.
--
-- Entitlement lives in public.app_access and is read through
-- public.has_app_access('cartmatch') / public.app_role('cartmatch'), defined in
-- github.com/imetrobert/Supabase-platform- (migration/app_access_pattern.sql).
-- Granting or revoking is one INSERT or DELETE there and takes effect on the
-- next page load — no deploy, no rebuild.
--
-- ---------------------------------------------------------------------------
-- THE SHAPE, AND ITS ASYMMETRY
-- ---------------------------------------------------------------------------
--   read:  has_app_access('cartmatch')
--          and (app_role('cartmatch') = 'app_admin' or user_id = auth.uid())
--   write: has_app_access('cartmatch') and user_id = auth.uid()
--
-- Reads widen for an app_admin so someone supporting the app can see what
-- happened. Writes never widen: not even an admin can create a row belonging to
-- someone else. That asymmetry is deliberate — keep it.
--
-- No UPDATE and no DELETE policies, because the app performs neither (there is
-- no .update(), .delete() or .upsert() anywhere in src/). The audit trail is
-- append-only, which is the point of an audit trail. Do not add these verbs to
-- make something work without checking why that something wants them.
-- ---------------------------------------------------------------------------

-- 1. Owner column ------------------------------------------------------------
-- The default is a safety net, not the mechanism: src/lib/store/index.ts sets
-- user_id explicitly on every row. Both, deliberately — if the column default
-- were the only thing naming the owner, a table created without it would make
-- every insert fail the `with check` below, and those failures are swallowed as
-- console warnings by design (an audit write must never cost a shopper their
-- price check). The visible symptom would be an app that works and silently
-- stores nothing.
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

-- 2. Drop prior versions, including the pre-platform names. ------------------
drop policy if exists cartmatch_obs_insert_own   on public.cartmatch_price_observations;
drop policy if exists cartmatch_obs_select_own   on public.cartmatch_price_observations;
drop policy if exists cartmatch_audit_insert_own on public.cartmatch_audit_records;
drop policy if exists cartmatch_audit_select_own on public.cartmatch_audit_records;
drop policy if exists cartmatch_val_insert_own   on public.cartmatch_validations;
drop policy if exists cartmatch_val_select_own   on public.cartmatch_validations;

drop policy if exists cartmatch_obs_select   on public.cartmatch_price_observations;
drop policy if exists cartmatch_obs_insert   on public.cartmatch_price_observations;
drop policy if exists cartmatch_audit_select on public.cartmatch_audit_records;
drop policy if exists cartmatch_audit_insert on public.cartmatch_audit_records;
drop policy if exists cartmatch_val_select   on public.cartmatch_validations;
drop policy if exists cartmatch_val_insert   on public.cartmatch_validations;

-- 3. Price observations ------------------------------------------------------
create policy cartmatch_obs_select
  on public.cartmatch_price_observations
  for select to authenticated
  using (
    public.has_app_access('cartmatch')
    and (public.app_role('cartmatch') = 'app_admin' or user_id = auth.uid())
  );

create policy cartmatch_obs_insert
  on public.cartmatch_price_observations
  for insert to authenticated
  with check (public.has_app_access('cartmatch') and user_id = auth.uid());

-- 4. Audit records -----------------------------------------------------------
create policy cartmatch_audit_select
  on public.cartmatch_audit_records
  for select to authenticated
  using (
    public.has_app_access('cartmatch')
    and (public.app_role('cartmatch') = 'app_admin' or user_id = auth.uid())
  );

create policy cartmatch_audit_insert
  on public.cartmatch_audit_records
  for insert to authenticated
  with check (public.has_app_access('cartmatch') and user_id = auth.uid());

-- 5. Validation reports ------------------------------------------------------
create policy cartmatch_val_select
  on public.cartmatch_validations
  for select to authenticated
  using (
    public.has_app_access('cartmatch')
    and (public.app_role('cartmatch') = 'app_admin' or user_id = auth.uid())
  );

create policy cartmatch_val_insert
  on public.cartmatch_validations
  for insert to authenticated
  with check (public.has_app_access('cartmatch') and user_id = auth.uid());

-- 6. Remove the reliability view --------------------------------------------
-- It aggregated cartmatch_validations across all rows. Two problems, either of
-- which is enough on its own:
--
--   * It is a view over per-user rows. With security_invoker it returns only
--     the caller's own reports while being named "reliability", which invites
--     presenting one person's handful of till outcomes as measured evidence —
--     the precise fabrication this app exists to refuse. Without
--     security_invoker it reads the base table with the OWNER's rights and
--     leaks every user's rows to anyone holding the publishable key. There is
--     no version of this view that is both honest and safe.
--
--   * Nothing queried it. Zero references in src/. It was pure attack surface.
--
-- If cross-user reliability is wanted later, the shape is a SECURITY DEFINER
-- function with `set search_path = public, pg_temp`, gated on
-- has_app_access('cartmatch'), returning aggregates only — never raw rows, no
-- user_id, no payload — and refusing to report a retailer below a minimum
-- number of reports, because with three users a small aggregate identifies the
-- individual who filed it.
drop view if exists public.cartmatch_retailer_reliability;
