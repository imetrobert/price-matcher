"use client";

/**
 * The main flow: photo -> confirm -> results.
 *
 * Kept as one client component with an explicit `step` so the confirmed cart
 * survives between stages without a round trip or a store. Recognition and
 * comparison are separate requests, so the user sees products to confirm while
 * nothing is being priced yet.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ProofSheet } from "@/components/ProofSheet";
import { MockBanner, Money, Notice, PageHeader, Spinner } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { formatCents, tryParsePriceToCents } from "@/lib/money";
import { DEFAULT_PREFS, loadPrefs, saveLastResult } from "@/lib/prefs";
import { stateLabel } from "@/services/policies/eligibility";
import type {
  DetectedProduct,
  PipelineResult,
  SavingsOpportunity,
  UserPreferences,
} from "@/types";

type Step = "capture" | "confirm" | "results";

interface EditableItem extends DetectedProduct {
  include: boolean;
  manualPrice: string;
}

export default function ScanPage() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);
  const [step, setStep] = useState<Step>("capture");
  const [images, setImages] = useState<{ base64: string; mimeType: string; preview: string }[]>([]);
  const [items, setItems] = useState<EditableItem[]>([]);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visionNote, setVisionNote] = useState<string | null>(null);
  const [proof, setProof] = useState<SavingsOpportunity | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const p = loadPrefs();
    setPrefs(p);
    if (!p.postalCode || !p.currentRetailerId) router.replace("/setup");
  }, [router]);

  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const next: { base64: string; mimeType: string; preview: string }[] = [];
    for (const file of Array.from(files).slice(0, 4)) {
      const base64 = await fileToBase64(file);
      next.push({
        base64,
        mimeType: file.type || "image/jpeg",
        preview: URL.createObjectURL(file),
      });
    }
    setImages((prev) => [...prev, ...next].slice(0, 4));
  }, []);

  async function recognize() {
    if (images.length === 0) {
      setError("Take at least one photo of your cart first.");
      return;
    }
    setBusy("Reading your cart…");
    setError(null);
    try {
      const res = await fetch("/api/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: images.map((i) => ({ base64: i.base64, mimeType: i.mimeType })),
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "Recognition failed.");
        return;
      }
      const detected = data.products as DetectedProduct[];
      if (detected.length === 0) {
        setError("No products detected. Try a closer or better-lit photo.");
        return;
      }
      setVisionNote(data.note ?? null);
      setItems(
        detected.map((d) => ({ ...d, include: true, manualPrice: "" })),
      );
      setStep("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recognition failed.");
    } finally {
      setBusy(null);
    }
  }

  async function compare() {
    const chosen = items.filter((i) => i.include);
    if (chosen.length === 0) {
      setError("Keep at least one product to compare.");
      return;
    }
    setBusy("Checking competitor prices…");
    setError(null);
    try {
      const res = await fetch("/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          retailerId: prefs.currentRetailerId,
          storeId: prefs.currentStoreId,
          postalCode: prefs.postalCode,
          thresholdCents: prefs.minSavingsCents,
          items: chosen.map((i) => ({
            brand: i.brand,
            productName: i.productName,
            variant: i.variant,
            fatPercentage: i.fatPercentage,
            size: i.size,
            packageQuantity: i.packageQuantity,
            visibleUpc: i.visibleUpc,
            manualCurrentPriceCents: tryParsePriceToCents(i.manualPrice),
          })),
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "Comparison failed.");
        return;
      }
      setResult(data.result as PipelineResult);
      saveLastResult(data.result);
      setStep("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Comparison failed.");
    } finally {
      setBusy(null);
    }
  }

  const needsPrice = items.some((i) => i.include && i.manualPrice.trim() === "");

  return (
    <main>
      <PageHeader
        title={
          step === "capture"
            ? "Scan your cart"
            : step === "confirm"
              ? "Confirm products"
              : "Your cart"
        }
        subtitle={
          prefs.currentRetailerId
            ? `Shopping at ${RETAILERS[prefs.currentRetailerId].displayName} · ${prefs.postalCode}`
            : undefined
        }
        backHref="/"
      />

      <MockBanner
        visible={Boolean(result?.containsMockData) || Boolean(items[0]?.isMock)}
        dataMode={result?.dataMode}
      />

      {error ? (
        <div className="mb-4">
          <Notice tone="error" title="Something went wrong">
            {error}
          </Notice>
        </div>
      ) : null}

      {busy ? (
        <div className="card mb-4">
          <Spinner label={busy} />
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {step === "capture" ? (
        <section>
          <div className="card mb-4">
            <p className="text-sm text-muted">
              One clear photo is usually enough. A second angle helps when items
              are stacked.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
            <button
              type="button"
              className="btn-primary mt-3"
              onClick={() => fileRef.current?.click()}
            >
              {images.length === 0 ? "Take a photo of your cart" : "Add another photo"}
            </button>
          </div>

          {images.length > 0 ? (
            <div className="mb-4 grid grid-cols-2 gap-2">
              {images.map((img, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={img.preview}
                  alt={`Cart photo ${i + 1}`}
                  className="h-32 w-full rounded-xl border border-line object-cover"
                />
              ))}
            </div>
          ) : null}

          <button
            type="button"
            className="btn-primary"
            disabled={images.length === 0 || busy !== null}
            onClick={recognize}
          >
            Identify products
          </button>
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {step === "confirm" ? (
        <section>
          {visionNote ? (
            <p className="mb-3 text-xs text-muted">{visionNote}</p>
          ) : null}

          <div className="space-y-3">
            {items.map((item, index) => (
              <ConfirmCard
                key={item.id}
                item={item}
                onChange={(patch) =>
                  setItems((prev) =>
                    prev.map((it, i) => (i === index ? { ...it, ...patch } : it)),
                  )
                }
              />
            ))}
          </div>

          {needsPrice ? (
            <div className="mt-4">
              <Notice tone="warn" title="Shelf prices help a lot">
                CartMatch cannot independently verify what this store charges, so
                without the shelf price it cannot calculate a saving. Type the
                price on the tag for the items you care about.
              </Notice>
            </div>
          ) : null}

          <button
            type="button"
            className="btn-primary mt-4"
            disabled={busy !== null}
            onClick={compare}
          >
            Find price matches
          </button>
          <button
            type="button"
            className="btn-secondary mt-2"
            onClick={() => setStep("capture")}
          >
            Back to photos
          </button>
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {step === "results" && result ? (
        <ResultsView
          result={result}
          onProof={setProof}
          onRescan={() => {
            setStep("capture");
            setResult(null);
          }}
        />
      ) : null}

      {proof ? (
        <ProofSheet opportunity={proof} onClose={() => setProof(null)} />
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------

function ConfirmCard({
  item,
  onChange,
}: {
  item: EditableItem;
  onChange: (patch: Partial<EditableItem>) => void;
}) {
  const uncertain = item.confidence < 0.9;
  return (
    <div className={`card ${item.include ? "" : "opacity-50"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold leading-tight">
            <span className={uncertain ? "text-warn" : "text-good"}>
              {uncertain ? "?" : "✓"}
            </span>{" "}
            {[item.brand, item.productName].filter(Boolean).join(" ")}
          </p>
          <p className="text-sm text-muted">
            {[item.variant, item.size, item.fatPercentage ? `${item.fatPercentage}%` : null]
              .filter(Boolean)
              .join(" · ") || "Details unread"}
          </p>
          <p className="mt-1 text-xs text-muted">
            Confidence {(item.confidence * 100).toFixed(0)}%
            {item.notes ? ` · ${item.notes}` : ""}
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 text-sm font-semibold text-muted underline"
          onClick={() => onChange({ include: !item.include })}
        >
          {item.include ? "Remove" : "Add back"}
        </button>
      </div>

      {item.include ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Field
            label="Brand"
            value={item.brand ?? ""}
            onChange={(v) => onChange({ brand: v || null })}
          />
          <Field
            label="Product"
            value={item.productName ?? ""}
            onChange={(v) => onChange({ productName: v || null })}
          />
          <Field
            label="Variant"
            value={item.variant ?? ""}
            onChange={(v) => onChange({ variant: v || null })}
          />
          <Field
            label="Size"
            value={item.size ?? ""}
            onChange={(v) => onChange({ size: v || null })}
            placeholder="650 g"
          />
          <Field
            label="Qty in cart"
            value={String(item.packageQuantity ?? 1)}
            onChange={(v) =>
              onChange({ packageQuantity: Number.parseInt(v, 10) || 1 })
            }
            inputMode="numeric"
          />
          <Field
            label="Shelf price here"
            value={item.manualPrice}
            onChange={(v) => onChange({ manualPrice: v })}
            placeholder="7.49"
            inputMode="decimal"
          />
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "decimal";
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-muted">{label}</span>
      <input
        className="field !min-h-[44px] text-sm"
        value={value}
        placeholder={placeholder}
        inputMode={inputMode ?? "text"}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------

function ResultsView({
  result,
  onProof,
  onRescan,
}: {
  result: PipelineResult;
  onProof: (o: SavingsOpportunity) => void;
  onRescan: () => void;
}) {
  const checkoutReady = result.opportunities.filter((o) => o.checkoutReady);

  return (
    <section>
      <div className="card mb-4">
        <p className="text-2xl font-extrabold">
          {result.qualifyingCount} price match
          {result.qualifyingCount === 1 ? "" : "es"} found
        </p>
        <p className="text-lg font-bold text-good">
          Potential savings: <Money cents={result.totalSavingsCents} />
        </p>
        <p className="mt-1 text-xs text-muted">
          Threshold {formatCents(result.thresholdCents)} · {checkoutReady.length}{" "}
          checkout-ready
        </p>
      </div>

      {result.opportunities.length === 0 ? (
        <Notice tone="warn" title="Nothing cleared the bar">
          No competitor price was both cheaper by at least{" "}
          {formatCents(result.thresholdCents)} and verifiable as the same
          product. That is the app working as intended — it will not show a
          match it cannot stand behind.
        </Notice>
      ) : (
        <div className="space-y-3">
          {result.opportunities.map((o) => (
            <OpportunityCard key={o.id} o={o} onProof={() => onProof(o)} />
          ))}
        </div>
      )}

      {result.unverified.length > 0 ? (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">
            Could not verify ({result.unverified.length})
          </h2>
          <div className="card space-y-3 text-sm">
            {result.unverified.map((u, i) => (
              <div key={i}>
                <p className="font-semibold">
                  {u.canonical
                    ? [u.canonical.brand, u.canonical.name].filter(Boolean).join(" ")
                    : "Unknown item"}
                </p>
                <p className="text-muted">{u.reason}</p>
                <p className="text-xs text-muted">{u.detail}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="mt-6 space-y-2">
        {checkoutReady.length > 0 ? (
          <Link href="/checkout" className="btn-primary">
            Enter Checkout Mode ({checkoutReady.length})
          </Link>
        ) : (
          <Notice tone="warn" title="Checkout Mode unavailable">
            Checkout Mode only shows results with a verified price and a direct
            product link. None of these results qualify.
          </Notice>
        )}
        <button type="button" className="btn-secondary" onClick={onRescan}>
          Scan again
        </button>
      </div>
    </section>
  );
}

function OpportunityCard({
  o,
  onProof,
}: {
  o: SavingsOpportunity;
  onProof: () => void;
}) {
  const current = RETAILERS[o.currentStore.retailerId];
  const competitor = RETAILERS[o.competitor.retailerId];
  return (
    <article className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold leading-tight">
            {o.canonical.brand} {o.canonical.name}
          </p>
          <p className="text-sm text-muted">
            {[o.canonical.variant, o.canonical.size?.raw].filter(Boolean).join(", ")}
          </p>
        </div>
        <p className="shrink-0 text-xl font-extrabold text-good">
          <Money cents={o.savingsCents} />
        </p>
      </div>

      <div className="mt-3 flex items-center gap-4 text-sm">
        <span>
          {current.displayName} <Money cents={o.currentStore.price} className="font-bold" />
        </span>
        <span aria-hidden>→</span>
        <span className="text-brand">
          {competitor.displayName}{" "}
          <Money cents={o.competitor.price} className="font-bold" />
        </span>
      </div>

      <p className="mt-2">
        <span className={o.isMock ? "pill-mock" : o.checkoutReady ? "pill-good" : "pill-warn"}>
          {stateLabel(o.state, o.isMock)}
        </span>
      </p>

      <button type="button" className="btn-secondary mt-3" onClick={onProof}>
        View proof
      </button>
    </article>
  );
}

// ---------------------------------------------------------------------------

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? "");
      resolve(s.includes(",") ? s.slice(s.indexOf(",") + 1) : s);
    };
    reader.onerror = () => reject(new Error("Could not read the photo."));
    reader.readAsDataURL(file);
  });
}
