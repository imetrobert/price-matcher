-- ---------------------------------------------------------------------------
-- CartMatch user preferences — one row per person, synced across devices.
--
-- Apply after schema.sql and policies.sql. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Preferences used to live only in localStorage, which is per-origin and
-- per-device: signing in on a laptop meant typing the postal code again, and
-- testing on the github.io URL before the custom domain meant typing it twice
-- on the same phone. A postal code is close to static, so being asked for it
-- repeatedly is the app failing at something it should remember.
--
-- ---------------------------------------------------------------------------
-- WHAT IS AND IS NOT STORED
-- ---------------------------------------------------------------------------
-- Postal code only. The "Locate me" button reads GPS coordinates, sends them
-- to the cartmatch-location Edge Function to derive a postal code, and the
-- coordinates are discarded — never returned to the browser's storage, never
-- written here, never logged. A stored latitude and longitude is location
-- history; a postal code is a neighbourhood, and it is all the app needs to
-- decide which stores are nearby.
--
-- The consequence to be honest about: a postal code stored server-side is
-- readable by anyone holding app_admin on 'cartmatch'. That is one person
-- today. Before granting app_admin to anyone else, know that it includes this.
-- ---------------------------------------------------------------------------

create table if not exists public.cartmatch_user_prefs (
  -- Also the primary key: one row per person, so an upsert cannot fork.
  user_id           uuid primary key default auth.uid()
                    references auth.users(id) on delete cascade,
  postal_code       text,
  language          text    not null default 'en',
  min_savings_cents integer not null default 50,
  updated_at        timestamptz not null default now(),

  -- Cheap guards. The app validates too, but the app is public code running on
  -- someone else's device and the database is not.
  constraint cartmatch_prefs_language_ck
    check (language in ('en', 'fr')),
  constraint cartmatch_prefs_savings_ck
    check (min_savings_cents >= 0 and min_savings_cents <= 100000),
  constraint cartmatch_prefs_postal_ck
    check (postal_code is null
           or postal_code ~ '^[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9]$')
);

-- The one cascade in this schema, and it is the safe direction: deleting an
-- account removes that account's own preferences. It cannot reach another
-- user's row, because the row IS the user. Do not add cascades between the
-- cartmatch_ tables themselves — there, one person's delete could destroy
-- someone else's history.

-- updated_at belongs to the database, not the client -------------------------
-- The default only applies on INSERT, so without this an UPDATE would leave a
-- stale timestamp. The app could set it on every write, and did at first — but
-- then the value reflects a phone's clock, which may be wrong, and is supplied
-- by code that anyone holding the publishable key can call. A timestamp worth
-- having is one the database wrote.
--
-- No `set search_path` here: this is an ordinary invoker-rights trigger, which
-- runs as the calling user and is not subject to the definer-function hijack
-- that setting exists to prevent.
create or replace function public.cartmatch_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cartmatch_user_prefs_touch on public.cartmatch_user_prefs;
create trigger cartmatch_user_prefs_touch
  before update on public.cartmatch_user_prefs
  for each row execute function public.cartmatch_touch_updated_at();

alter table public.cartmatch_user_prefs enable row level security;

drop policy if exists "cartmatch_user_prefs select (cartmatch)" on public.cartmatch_user_prefs;
drop policy if exists "cartmatch_user_prefs insert (cartmatch)" on public.cartmatch_user_prefs;
drop policy if exists "cartmatch_user_prefs update (cartmatch)" on public.cartmatch_user_prefs;

-- Reads are NOT widened for app_admin, unlike the audit tables.
--
-- There, an admin needs to see what happened in order to support the app. Here
-- there is nothing to support: preferences are settings, not evidence, and the
-- only thing an admin would gain is other people's postal codes. Narrower is
-- correct when wider buys nothing.
create policy "cartmatch_user_prefs select (cartmatch)"
  on public.cartmatch_user_prefs
  for select to authenticated
  using (public.has_app_access('cartmatch') and user_id = auth.uid());

create policy "cartmatch_user_prefs insert (cartmatch)"
  on public.cartmatch_user_prefs
  for insert to authenticated
  with check (public.has_app_access('cartmatch') and user_id = auth.uid());

-- UPDATE exists here and deliberately nowhere else in this schema. Preferences
-- are current state and are meant to change; the audit tables are an append-only
-- record and are not. Both `using` and `with check` are required: `using`
-- decides which rows you may update, `with check` decides what they may become.
-- Omitting the second would let a row be updated into someone else's ownership.
create policy "cartmatch_user_prefs update (cartmatch)"
  on public.cartmatch_user_prefs
  for update to authenticated
  using      (public.has_app_access('cartmatch') and user_id = auth.uid())
  with check (public.has_app_access('cartmatch') and user_id = auth.uid());

-- No DELETE policy. Clearing a preference is an UPDATE to null; there is no
-- reason for the app to remove the row, and the account cascade handles the
-- only case that genuinely needs it.

-- Verification -------------------------------------------------------------
-- select policyname, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public' and tablename = 'cartmatch_user_prefs';
--
-- Expect three rows, every expression mentioning has_app_access.
