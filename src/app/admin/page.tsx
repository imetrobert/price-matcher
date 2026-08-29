"use client";

/**
 * Admin view — trimmed to two operational tools: Flipp coverage / manual
 * retry, and the Gemini model-availability checker. The audit trail,
 * validation-report tooling, retailer probe, and barcode lookup panel that
 * used to live here were removed on request, not merely hidden — along
 * with the state, effects, and imports that only existed to feed them.
 */

import { useCallback, useEffect, useState } from "react";

import { AdminOnly } from "@/components/AdminOnly";
import { AuthGuard } from "@/components/AuthGuard";
import { PageHeader } from "@/components/ui";
import { listGeminiModels } from "@/services/vision";
import {
  loadAllFlyersResult,
  loadFlippRetailersThisWeek,
  retryFlippRetailer,
  type StoredFlyer,
} from "@/services/flyers/storage";
import { flyerSourceSummary, sourceLabel } from "@/services/flyers/status";
import type { RetailerId } from "@/types";

export default function AdminPage() {
  return (
    <AuthGuard>
      <AdminOnly>
        <AdminView />
      </AdminOnly>
    </AuthGuard>
  );
}

function AdminView() {
  return (
    <main className="mx-auto max-w-[1100px]">
      <PageHeader
        title="Debug view"
        subtitle="Flipp coverage and Gemini model availability."
        backHref="/"
      />

      <FlippSourcesPanel />

      <GeminiModelsPanel />
    </main>
  );
}

/**
 * Per-retailer Flipp coverage, with a manual "Retry" button next to any
 * retailer showing nothing — admin-only, on purpose.
 *
 * This entire page is already wrapped in AdminOnly, but the real security
 * boundary is server-side regardless: the Edge Function's "retry" action
 * checks has_app_access itself before writing anything, using its own
 * service-role key that the browser never sees. Being on this page keeps an
 * unattended shopper from stumbling into a button that fires an extra
 * upstream request; it is not the only thing stopping misuse of it.
 */
function FlippSourcesPanel() {
  const [scanned, setScanned] = useState<StoredFlyer[] | null>(null);
  const [flipp, setFlipp] = useState<RetailerId[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [flyersResult, flippRetailers] = await Promise.all([
      loadAllFlyersResult(),
      loadFlippRetailersThisWeek(),
    ]);
    setScanned(flyersResult.ok ? flyersResult.flyers : []);
    setFlipp(flippRetailers);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (scanned === null) return null;

  const today = new Date().toISOString().slice(0, 10);
  const scannedRetailers = scanned
    .filter((f) => f.validFrom <= today && today <= f.validTo)
    .map((f) => f.retailerId);

  const summary = flyerSourceSummary(scannedRetailers, flipp);

  async function retry(retailerId: RetailerId) {
    setBusy(retailerId);
    setResult(null);
    const outcome = await retryFlippRetailer(retailerId);
    setBusy(null);
    if (!outcome.ok) {
      setResult(`${retailerId}: ${outcome.error}`);
      return;
    }
    setResult(
      outcome.note
        ? `${retailerId}: ${outcome.note}`
        : `${retailerId}: wrote ${outcome.written} offers across ${outcome.banners} banner(s).`,
    );
    await refresh();
  }

  return (
    <section className="card mb-4">
      <p className="mb-2 font-bold">Flipp coverage — manual retry</p>
      <div className="space-y-1">
        {summary.map(({ retailerId, displayName, source }) => (
          <div
            key={retailerId}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span>{displayName}</span>
            <div className="flex items-center gap-2">
              <span className={source === "NONE" ? "text-warn" : "text-muted"}>
                {sourceLabel(source)}
              </span>
              {source === "NONE" ? (
                <button
                  type="button"
                  onClick={() => retry(retailerId)}
                  disabled={busy === retailerId}
                  className="rounded-md border border-line px-2 py-1 text-xs font-semibold disabled:opacity-50"
                >
                  {busy === retailerId ? "Retrying…" : "Retry"}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {result ? <p className="mt-2 text-xs text-muted">{result}</p> : null}
    </section>
  );
}

/**
 * Which Gemini models this project's key may call.
 *
 * Here because a model id expires in a way nothing in the app can predict.
 * gemini-2.5-flash was the default, and a key issued after its retirement gets
 * "no longer available to new users" — accurate, and silent on the successor.
 * Guessing one costs a deploy per guess. This asks Google instead.
 */
function GeminiModelsPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ configured: string; models: string[] } | null>(
    null,
  );

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    const outcome = await listGeminiModels();
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setResult({ configured: outcome.configured, models: outcome.models });
  }

  // The Edge Function already filters and ranks these; this only guards against
  // an older deployment answering with the raw list.
  const usable =
    result?.models.filter(
      (m) => !/tts|embedding|aqa|imagen|veo|video|gemma|learnlm/i.test(m),
    ) ?? [];

  return (
    <section className="card mb-4 text-sm">
      <p className="mb-1 font-bold">Gemini models this key can use</p>
      <p className="mb-3 text-xs text-muted">
        Model ids get retired, and a key issued afterwards cannot call the old
        one at all. This asks Google which ones it will accept, so
        CARTMATCH_GEMINI_MODEL can be set to a name that works rather than one
        that looks plausible.
      </p>

      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="min-h-[44px] rounded-xl border border-line bg-surface px-3 text-sm font-semibold disabled:opacity-60"
      >
        {busy ? "Asking Gemini…" : "List models"}
      </button>

      {error ? (
        <p className="mt-3 rounded-xl bg-bad/5 px-3 py-2 text-sm text-bad">{error}</p>
      ) : null}

      {result ? (
        <div className="mt-3">
          <p className="mb-2">
            Currently configured: <span className="font-bold">{result.configured}</span>
            {result.models.includes(result.configured) ? (
              <span className="text-good"> — available</span>
            ) : (
              <span className="text-bad"> — NOT in the list below</span>
            )}
          </p>
          <p className="mb-1 text-xs text-muted">
            Models that could read a flyer page, best candidates first. Set
            CARTMATCH_GEMINI_MODEL to two or three of these, comma-separated —
            a busy model falls through to the next one in the same request.
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs text-muted">
            {usable.join("\n") || "(none returned)"}
          </pre>
          {usable.length > 1 ? (
            <p className="mt-2 break-all rounded-lg bg-surface px-2 py-1 text-xs">
              Suggested value: {usable.slice(0, 3).join(",")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
