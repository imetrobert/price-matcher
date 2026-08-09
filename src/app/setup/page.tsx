"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Notice, PageHeader } from "@/components/ui";
import { enabledRetailers } from "@/config/retailers";
import { SAVINGS } from "@/config/thresholds";
import { formatCents, tryParsePriceToCents } from "@/lib/money";
import { isInSupportedRegion, normalizePostalCode } from "@/lib/region";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "@/lib/prefs";
import type { RetailerId, UserPreferences } from "@/types";

export default function SetupPage() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);
  const [postalInput, setPostalInput] = useState("");
  const [customThreshold, setCustomThreshold] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = loadPrefs();
    setPrefs(p);
    setPostalInput(p.postalCode);
  }, []);

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
        subtitle="Stored on this device only. No account, no tracking."
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
        <p className="mt-2 text-xs text-muted">
          Used to keep comparisons inside the Montreal market. It is the only
          location detail CartMatch keeps.
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
