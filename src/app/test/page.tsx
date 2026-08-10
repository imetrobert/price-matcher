"use client";

/**
 * Manual product test harness (spec §37).
 *
 * Runs the whole data pipeline — IDENTIFY, MATCH, SEARCH, VERIFY, COMPARE —
 * against a typed-in product, so the plumbing can be tested without taking a
 * photograph. Fixtures preload the hard cases with one tap.
 */

import { useEffect, useState } from "react";

import { AuthGuard } from "@/components/AuthGuard";
import { ProofSheet } from "@/components/ProofSheet";
import { MockBanner, Money, Notice, PageHeader, Spinner } from "@/components/ui";
import { enabledRetailers, RETAILERS } from "@/config/retailers";
import { PRODUCT_FIXTURES } from "@/fixtures/products";
import { formatCents, tryParsePriceToCents } from "@/lib/money";
import { DEFAULT_PREFS, loadPrefs } from "@/lib/prefs";
import { stateLabel } from "@/services/policies/eligibility";
import { buildCanonicalProduct } from "@/services/products/normalize";
import { runPipeline } from "@/services/pipeline/run";
import type { PipelineResult, RetailerId, SavingsOpportunity } from "@/types";

export default function TestPage() {
  return (
    <AuthGuard>
      <TestHarness />
    </AuthGuard>
  );
}

function TestHarness() {
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [brand, setBrand] = useState("Oikos");
  const [name, setName] = useState("Greek Yogurt");
  const [variant, setVariant] = useState("Vanilla");
  const [size, setSize] = useState("650 g");
  const [fat, setFat] = useState("0");
  const [upc, setUpc] = useState("");
  const [price, setPrice] = useState("7.49");
  const [retailer, setRetailer] = useState<RetailerId>("maxi");
  const [postal, setPostal] = useState("H4A 1A1");
  const [threshold, setThreshold] = useState("0.50");
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proof, setProof] = useState<SavingsOpportunity | null>(null);

  useEffect(() => {
    const p = loadPrefs();
    setPrefs(p);
    if (p.postalCode) setPostal(p.postalCode);
    if (p.currentRetailerId) setRetailer(p.currentRetailerId);
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const pipelineResult = await runPipeline({
        storeContext: {
          retailerId: retailer,
          storeId: prefs.currentStoreId,
          storeName: null,
          postalCode: postal,
          capturedAt: new Date().toISOString(),
        },
        thresholdCents: tryParsePriceToCents(threshold) ?? 50,
        items: [
          {
            canonical: buildCanonicalProduct({
              brand,
              name,
              variant: variant || null,
              fatPercentage: fat || null,
              size: size || null,
              gtin: upc || null,
              identitySource: upc ? "VISIBLE_BARCODE" : "USER_ENTERED",
            }),
            manualCurrentPriceCents: tryParsePriceToCents(price),
          },
        ],
      });
      setResult(pipelineResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pipeline failed.");
    } finally {
      setBusy(false);
    }
  }

  function loadFixture(key: string) {
    const f = PRODUCT_FIXTURES.find((x) => x.key === key);
    if (!f) return;
    setBrand(f.brand);
    setName(f.name);
    setVariant(f.variant ?? "");
    setSize(f.size ?? "");
    setFat(f.fatPercentage ?? "");
    setUpc("");
  }

  return (
    <main>
      <PageHeader
        title="Manual product test"
        subtitle="Run the pipeline without a photo."
        backHref="/"
      />

      <MockBanner visible={Boolean(result?.containsMockData)} dataMode={result?.dataMode} />

      <section className="card mb-4">
        <p className="label">Load a fixture</p>
        <select
          className="field"
          onChange={(e) => loadFixture(e.target.value)}
          defaultValue=""
        >
          <option value="" disabled>
            Choose a test product…
          </option>
          {PRODUCT_FIXTURES.map((f) => (
            <option key={f.key} value={f.key}>
              {f.brand} {f.name} — {f.variant ?? "no variant"} {f.size ?? ""}
            </option>
          ))}
        </select>
      </section>

      <section className="card mb-4 grid grid-cols-2 gap-2">
        <T label="Brand" value={brand} onChange={setBrand} />
        <T label="Product" value={name} onChange={setName} />
        <T label="Variant" value={variant} onChange={setVariant} />
        <T label="Size" value={size} onChange={setSize} />
        <T label="Fat %" value={fat} onChange={setFat} />
        <T label="UPC (optional)" value={upc} onChange={setUpc} inputMode="numeric" />
        <T label="Shelf price" value={price} onChange={setPrice} inputMode="decimal" />
        <T label="Threshold" value={threshold} onChange={setThreshold} inputMode="decimal" />
        <T label="Postal code" value={postal} onChange={setPostal} />
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted">
            Current retailer
          </span>
          <select
            className="field !min-h-[44px] text-sm"
            value={retailer}
            onChange={(e) => setRetailer(e.target.value as RetailerId)}
          >
            {enabledRetailers().map((r) => (
              <option key={r.id} value={r.id}>
                {r.displayName}
              </option>
            ))}
          </select>
        </label>
      </section>

      <button type="button" className="btn-primary" onClick={run} disabled={busy}>
        Run IDENTIFY → MATCH → SEARCH → VERIFY → COMPARE
      </button>

      {busy ? (
        <div className="card mt-4">
          <Spinner label="Running pipeline…" />
        </div>
      ) : null}

      {error ? (
        <div className="mt-4">
          <Notice tone="error" title="Pipeline error">
            {error}
          </Notice>
        </div>
      ) : null}

      {result ? (
        <section className="mt-6">
          <div className="card mb-3">
            <p className="font-bold">
              {result.qualifyingCount} qualifying · total{" "}
              <Money cents={result.totalSavingsCents} />
            </p>
            <p className="text-xs text-muted">
              run {result.runId} · mode {result.dataMode} · threshold{" "}
              {formatCents(result.thresholdCents)}
            </p>
          </div>

          {result.opportunities.map((o) => (
            <article key={o.id} className="card mb-3">
              <p className="font-bold">
                {RETAILERS[o.competitor.retailerId].displayName} —{" "}
                <Money cents={o.competitor.price} /> (save{" "}
                <Money cents={o.savingsCents} />)
              </p>
              <p className="mt-1">
                <span className={o.isMock ? "pill-mock" : o.checkoutReady ? "pill-good" : "pill-warn"}>
                  {stateLabel(o.state, o.isMock)}
                </span>
              </p>
              <p className="mt-2 text-xs text-muted">
                {o.match.level} · score {o.match.score} · {o.competitorFreshness}
              </p>
              <button
                type="button"
                className="btn-secondary mt-2"
                onClick={() => setProof(o)}
              >
                View proof
              </button>
            </article>
          ))}

          {result.unverified.length > 0 ? (
            <div className="card">
              <p className="mb-2 text-sm font-bold uppercase text-muted">
                Unverified
              </p>
              {result.unverified.map((u, i) => (
                <p key={i} className="mb-2 text-sm">
                  <span className="font-semibold">{u.reason}</span>
                  <span className="block text-xs text-muted">{u.detail}</span>
                </p>
              ))}
            </div>
          ) : null}

          <details className="card mt-3">
            <summary className="cursor-pointer text-sm font-bold">
              Adapter health
            </summary>
            {result.adapterHealth.map((a) => (
              <p key={a.retailerId} className="mt-2 text-xs">
                <span className="font-semibold">{a.retailerId}</span> — {a.status}
                <span className="block text-muted">{a.reason}</span>
              </p>
            ))}
          </details>
        </section>
      ) : null}

      {proof ? <ProofSheet opportunity={proof} onClose={() => setProof(null)} /> : null}
    </main>
  );
}

function T({
  label,
  value,
  onChange,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputMode?: "text" | "numeric" | "decimal";
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-muted">{label}</span>
      <input
        className="field !min-h-[44px] text-sm"
        value={value}
        inputMode={inputMode ?? "text"}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
