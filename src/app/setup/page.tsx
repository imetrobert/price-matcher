"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Notice, PageHeader } from "@/components/ui";
import { enabledRetailers } from "@/config/retailers";
import { SAVINGS } from "@/config/thresholds";
import { formatCents, tryParsePriceToCents } from "@/lib/money";
import { isInSupportedRegion, normalizePostalCode } from "@/lib/region";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "@/lib/prefs";
import { pushRemotePrefs, reconcilePrefs } from "@/lib/prefsSync";
import {
  formatDistance,
  locatePostalCode,
  nearbyStores,
  type NearbyStore,
} from "@/services/location";
import { supabaseConfigured } from "@/config/env";
import type { RetailerId, UserPreferences } from "@/types";

/**
 * Was "Stored on this device only. No account, no tracking." — which stopped
 * being true the moment settings began syncing to the account.
 *
 * A privacy claim that has quietly gone stale is worse than none: it is the one
 * line on the page a reader is entitled to take at face value. If preferences
 * ever stop syncing, or start carrying more than a postal code, this string
 * changes in the same commit.
 */
const SETTINGS_SUBTITLE =
  "Saved to your account and to this device. Postal code only — never coordinates.";

export default function SetupPage() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);
  const [postalInput, setPostalInput] = useState("");
  const [customThreshold, setCustomThreshold] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState<string | null>(null);

  const [stores, setStores] = useState<NearbyStore[] | null>(null);
  const [storesAttribution, setStoresAttribution] = useState<string | null>(null);
  const [storesBusy, setStoresBusy] = useState(false);
  const [storesNote, setStoresNote] = useState<string | null>(null);

  useEffect(() => {
    // Render whatever is on the device immediately, then let the account copy
    // fill in a blank postal code. Never block the screen on the network.
    const local = loadPrefs();
    setPrefs(local);
    setPostalInput(local.postalCode);

    let cancelled = false;
    reconcilePrefs().then((p) => {
      if (cancelled) return;
      setPrefs(p);
      // Only overwrite the field if the user has not started typing into it.
      setPostalInput((current) => (current === "" ? p.postalCode : current));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function useMyLocation() {
    setLocating(true);
    setError(null);
    setLocateNote(null);
    const result = await locatePostalCode();
    setLocating(false);
    if (!result.ok) {
      setLocateNote(result.error);
      return;
    }
    setPostalInput(result.data);
    setLocateNote(`Found ${result.data}. Check it looks right before saving.`);
  }

  async function findStores() {
    const normalized = normalizePostalCode(postalInput);
    if (!normalized) {
      setStoresNote("Enter or locate a postal code first.");
      return;
    }
    setStoresBusy(true);
    setStoresNote(null);
    const result = await nearbyStores(normalized);
    setStoresBusy(false);
    if (!result.ok) {
      setStores(null);
      setStoresNote(result.error);
      return;
    }
    setStores(result.data.stores);
    setStoresAttribution(result.data.attribution);
    if (result.data.stores.length === 0) {
      setStoresNote(
        `No supermarkets are mapped within 5 km of ${normalized}. Type the store name instead.`,
      );
    }
  }

  /**
   * Picking a store fills the free-text field with something a cashier would
   * recognise, and selects the banner when OpenStreetMap's brand matches one we
   * know. When it does not match, the banner is left alone rather than guessed:
   * a wrong banner silently changes which retailers are treated as competitors.
   */
  function chooseStore(store: NearbyStore) {
    const label = store.address ? `${store.name} — ${store.address}` : store.name;
    const haystack = `${store.brand ?? ""} ${store.name}`.toLowerCase();
    const matched = enabledRetailers().find((r) =>
      haystack.includes(r.displayName.toLowerCase()),
    );
    setPrefs((p) => ({
      ...p,
      currentStoreId: label,
      currentRetailerId: matched ? (matched.id as RetailerId) : p.currentRetailerId,
    }));
    setStoresNote(
      matched
        ? null
        : `Selected. OpenStreetMap does not say which banner "${store.name}" belongs to — choose it above.`,
    );
  }

  function save() {
    const normalized = normalizePostalCode(postalInput);
    if (!normalized) {
      setError("Enter a valid Canadian postal code, for example H4A 1A1.");
      return;
    }
    if (!isInSupportedRegion(normalized)) {
      setError(
        `${normalized} is outside the Montreal region. This MVP only covers Montreal-area pricing, so results would not be meaningful.`,
      );
      return;
    }
    if (!prefs.currentRetailerId) {
      setError("Choose the store you are shopping at.");
      return;
    }
    const next = { ...prefs, postalCode: normalized };
    savePrefs(next);
    // Fire-and-forget: the device is already saved, and navigation must not
    // wait on Supabase.
    void pushRemotePrefs(next);
    router.push("/");
  }

  function applyCustomThreshold() {
    const cents = tryParsePriceToCents(customThreshold);
    if (cents === null || cents < 0) {
      setError("Enter a savings amount like 0.75");
      return;
    }
    setError(null);
    setPrefs({ ...prefs, minSavingsCents: cents });
    setCustomThreshold("");
  }

  return (
    <main>
      <PageHeader
        title="Settings"
        subtitle={SETTINGS_SUBTITLE}
        backHref="/"
      />

      <section className="card mb-4">
        <label className="label" htmlFor="postal">
          Postal code
        </label>
        <input
          id="postal"
          className="field"
          inputMode="text"
          autoComplete="postal-code"
          placeholder="H4A 1A1"
          value={postalInput}
          onChange={(e) => setPostalInput(e.target.value)}
        />
        {supabaseConfigured() ? (
          <button
            type="button"
            onClick={useMyLocation}
            disabled={locating}
            className="mt-2 min-h-[48px] w-full rounded-xl border border-line bg-surface px-3 text-base font-semibold text-ink disabled:opacity-60"
          >
            {locating ? "Locating…" : "📍 Use my location"}
          </button>
        ) : null}

        {locateNote ? (
          <p className="mt-2 rounded-xl bg-warn/5 px-3 py-2 text-sm text-warn">
            {locateNote}
          </p>
        ) : null}

        <p className="mt-2 text-xs text-muted">
          Saved to your account, so it is already filled in on any device you
          sign in on. Used to keep comparisons inside the Montreal market, and
          it is the only location detail CartMatch keeps — locating you reads
          GPS once to work out the postal code, then discards the coordinates.
        </p>
      </section>

      <section className="card mb-4">
        <p className="label">Where are you shopping?</p>
        <div className="grid grid-cols-2 gap-2">
          {enabledRetailers().map((r) => {
            const selected = prefs.currentRetailerId === r.id;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() =>
                  setPrefs({ ...prefs, currentRetailerId: r.id as RetailerId })
                }
                className={`min-h-[52px] rounded-xl border px-3 text-base font-semibold transition ${
                  selected
                    ? "border-brand bg-brand text-white"
                    : "border-line bg-surface text-ink"
                }`}
              >
                {r.displayName}
              </button>
            );
          })}
        </div>

        <label className="label mt-4" htmlFor="storeId">
          Specific store (optional)
        </label>
        <input
          id="storeId"
          className="field"
          placeholder="Store number or name, if you know it"
          value={prefs.currentStoreId ?? ""}
          onChange={(e) =>
            setPrefs({ ...prefs, currentStoreId: e.target.value || null })
          }
        />

        {supabaseConfigured() ? (
          <button
            type="button"
            onClick={findStores}
            disabled={storesBusy}
            className="mt-2 min-h-[48px] w-full rounded-xl border border-line bg-surface px-3 text-base font-semibold text-ink disabled:opacity-60"
          >
            {storesBusy ? "Searching…" : "Find supermarkets near this postal code"}
          </button>
        ) : null}

        {storesNote ? (
          <p className="mt-2 rounded-xl bg-warn/5 px-3 py-2 text-sm text-warn">
            {storesNote}
          </p>
        ) : null}

        {stores && stores.length > 0 ? (
          <div className="mt-3 space-y-2">
            {stores.map((s) => {
              const label = s.address ? `${s.name} — ${s.address}` : s.name;
              const selected = prefs.currentStoreId === label;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => chooseStore(s)}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                    selected
                      ? "border-brand bg-brand/5"
                      : "border-line bg-surface"
                  }`}
                >
                  <span className="block text-base font-semibold">{s.name}</span>
                  <span className="block text-sm text-muted">
                    {s.address ?? "No address recorded"} ·{" "}
                    {formatDistance(s.distanceM)}
                  </span>
                </button>
              );
            })}
            <p className="text-xs text-muted">
              {storesAttribution}. Community-maintained, so a shop may have
              moved or closed — check it matches the one you are standing in,
              and type it yourself if the list is wrong.
            </p>
          </div>
        ) : null}

        <p className="mt-2 text-xs text-muted">
          Without a specific store, competitor prices are labelled
          &ldquo;Montreal-area online price&rdquo; rather than a guaranteed shelf
          price.
        </p>
      </section>

      <section className="card mb-4">
        <p className="label">Minimum savings to show a match</p>
        <div className="grid grid-cols-4 gap-2">
          {SAVINGS.presetsCents.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setPrefs({ ...prefs, minSavingsCents: c })}
              className={`min-h-[48px] rounded-xl border text-base font-semibold ${
                prefs.minSavingsCents === c
                  ? "border-brand bg-brand text-white"
                  : "border-line bg-surface"
              }`}
            >
              {formatCents(c)}
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            className="field"
            inputMode="decimal"
            placeholder={`Custom (now ${formatCents(prefs.minSavingsCents)})`}
            value={customThreshold}
            onChange={(e) => setCustomThreshold(e.target.value)}
          />
          <button
            type="button"
            className="btn-secondary !w-auto shrink-0 px-4"
            onClick={applyCustomThreshold}
          >
            Set
          </button>
        </div>
      </section>

      <section className="card mb-4">
        <p className="label">Language</p>
        <div className="grid grid-cols-2 gap-2">
          {(["en", "fr"] as const).map((lang) => (
            <button
              key={lang}
              type="button"
              onClick={() => setPrefs({ ...prefs, language: lang })}
              className={`min-h-[48px] rounded-xl border text-base font-semibold ${
                prefs.language === lang
                  ? "border-brand bg-brand text-white"
                  : "border-line bg-surface"
              }`}
            >
              {lang === "en" ? "English" : "Français"}
            </button>
          ))}
        </div>
        {prefs.language === "fr" ? (
          <p className="mt-2 text-xs text-warn">
            The preference is saved, but the interface is still English only.
            French strings are not translated yet.
          </p>
        ) : null}
      </section>

      {error ? (
        <div className="mb-4">
          <Notice tone="error" title="Check your settings">
            {error}
          </Notice>
        </div>
      ) : null}

      <button type="button" className="btn-primary" onClick={save}>
        Save
      </button>
    </main>
  );
}
