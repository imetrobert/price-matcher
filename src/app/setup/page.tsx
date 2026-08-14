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
import { locatePostalCode } from "@/services/location";
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

        {/*
          The store picker and the nearby-supermarket lookup lived here.

          Both belonged to a design where prices came from retailer APIs and a
          branch number decided which shelf price applied. Prices now come from
          flyers, and a flyer is regional rather than per-branch: the Maxi
          circular for the week of the 13th is the same document in every Maxi
          in the region. Asking for a store number implied a precision the data
          does not have, and the note underneath promised a distinction —
          "Montreal-area online price" versus a guaranteed shelf price — that
          no longer describes anything this app does.

          The retailer above is still needed: it is what "am I already getting
          the best price" is measured against.
        */}
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
