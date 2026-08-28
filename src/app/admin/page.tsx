"use client";

/**
 * Developer / debug view (spec §49) plus the "Verify This Match" feedback
 * loop (spec §55). Desktop-friendly table; not part of the shopper flow.
 */

import { useCallback, useEffect, useState } from "react";

import { AdminOnly } from "@/components/AdminOnly";
import { AuthGuard } from "@/components/AuthGuard";
import { Notice, PageHeader } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { formatCents } from "@/lib/money";
import { loadLastResult } from "@/lib/prefs";
import { activeBackend, recentAudit, recentObservations, saveValidation, validationSummary } from "@/lib/store";
import { visionProviderName, env, edgeFunctionUrl } from "@/config/env";
import { listGeminiModels } from "@/services/vision";
import { authConfigured } from "@/lib/auth/config";
import { APP_NAME, checkAppAccess } from "@/lib/auth/access";
import {
  loadAllFlyersResult,
  loadFlippRetailersThisWeek,
  retryFlippRetailer,
} from "@/services/flyers/storage";
import { flyerSourceSummary } from "@/services/flyers/status";
import {
  lookupBarcode,
  probeRetailerUrl,
  probeSucceeded,
  summariseProbe,
  type BarcodeLookup,
  type ProbeResult,
} from "@/services/retailers/probe";
import type {
  AuditRecord,
  MatchValidationReport,
  PipelineResult,
  PriceObservation,
  RetailerId,
} from "@/types";
import type { StoredFlyer } from "@/services/flyers/storage";

interface AuditPayload {
  audit: AuditRecord[];
  observations: PriceObservation[];
  validation: Record<
    string,
    { total: number; priceMatched: number; accepted: number }
  >;
}

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
  const [data, setData] = useState<AuditPayload | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [lastRun, setLastRun] = useState<PipelineResult | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([recentAudit(200), recentObservations(200), validationSummary()])
      .then(([audit, observations, validation]) =>
        setData({ audit, observations, validation }),
      )
      .catch(() => setData(null));
    checkAppAccess().then((access) =>
      setHealth({
        priceDataMode: env.dataMode,
        visionMode: env.visionMode,
        vision: visionProviderName(),
        storageBackend: activeBackend(),
        authConfigured: authConfigured(),
        // The project REF, not a credential — it is in the URL of every request
        // the browser already makes. Shown because "configured" cannot tell you
        // WHICH project, and deploying an Edge Function into the wrong project
        // of several is invisible from both ends: the dashboard reports
        // success, and the app keeps getting answers from the old one.
        supabaseProject: env.supabaseUrl
          ? (env.supabaseUrl.match(/https?:\/\/([^.]+)\./)?.[1] ?? env.supabaseUrl)
          : "not configured",
        retailerFunction: env.supabaseUrl
          ? edgeFunctionUrl("cartmatch-retailer")
          : "not configured",
        // Which app_access grant this session holds. `app_admin` is the reason
        // the rows below might not all be yours — worth seeing on this page.
        [`app_access(${APP_NAME})`]:
          access.status === "granted"
            ? `granted (${access.role})`
            : access.status,
      }),
    );
  }, []);

  useEffect(() => {
    refresh();
    setLastRun(loadLastResult<PipelineResult>());
  }, [refresh]);

  return (
    <main className="mx-auto max-w-[1100px]">
      <PageHeader
        title="Debug view"
        subtitle="Audit trail, price observations and real-world validation."
        backHref="/"
      />

      {health ? (
        <section className="card mb-4 text-sm">
          <p className="mb-2 font-bold">Configuration</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs text-muted">
            {JSON.stringify(health, null, 2)}
          </pre>
        </section>
      ) : null}

      <RetailerProbe />

      <FlippSourcesPanel />

      <GeminiModelsPanel />

      <BarcodeLookupPanel />

      {lastRun ? (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">
            Verify this match — record what actually happened
          </h2>
          {lastRun.opportunities.length === 0 ? (
            <Notice tone="info" title="No opportunities in the last run" />
          ) : (
            <div className="space-y-3">
              {lastRun.opportunities.map((o) => (
                <ValidationForm
                  key={o.id}
                  opportunityId={o.id}
                  retailerId={o.currentStore.retailerId}
                  competitorRetailerId={o.competitor.retailerId}
                  label={`${o.canonical.brand} ${o.canonical.name} — ${RETAILERS[o.competitor.retailerId].displayName}`}
                  onSaved={(id) => {
                    setSaved(id);
                    refresh();
                  }}
                />
              ))}
            </div>
          )}
          {saved ? (
            <p className="mt-2 text-sm text-good">Recorded ({saved}).</p>
          ) : null}
        </section>
      ) : null}

      {data && Object.keys(data.validation).length > 0 ? (
        <section className="card mb-6 text-sm">
          {/*
            Deliberately NOT called "measured reliability". Row Level Security
            returns only this account's own reports, so with three users on the
            project this is a personal tally of a handful of till outcomes.
            Labelling it as measured evidence would be the same fabrication the
            rest of the app refuses. Cross-user aggregation needs a definer
            function — see the end of supabase/policies.sql.
          */}
          <p className="mb-2 font-bold">Your own match reports</p>
          <p className="mb-2 text-xs text-muted">
            Only what you have recorded — not a measured reliability rating for
            these retailers.
          </p>
          <table className="w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1">Retailer</th>
                <th>Reports</th>
                <th>Price correct</th>
                <th>Match accepted</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.validation).map(([id, v]) => (
                <tr key={id} className="border-t border-line">
                  <td className="py-1 font-semibold">
                    {RETAILERS[id as keyof typeof RETAILERS]?.displayName ?? id}
                  </td>
                  <td>{v.total}</td>
                  <td>{v.priceMatched}</td>
                  <td>{v.accepted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">
          Audit trail ({data?.audit.length ?? 0})
        </h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1">Product</th>
                <th>Store</th>
                <th>Competitor</th>
                <th>Current</th>
                <th>Comp.</th>
                <th>Save</th>
                <th>Match</th>
                <th>Score</th>
                <th>GTIN</th>
                <th>Conf.</th>
                <th>Fresh</th>
                <th>Eligibility</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {(data?.audit ?? []).map((a) => (
                <tr key={a.id} className="border-t border-line align-top">
                  <td className="py-1 pr-2">{a.productLabel}</td>
                  <td>{a.currentRetailerId}</td>
                  <td>{a.competitorRetailerId ?? "—"}</td>
                  <td>{a.currentPriceCents !== null ? formatCents(a.currentPriceCents) : "—"}</td>
                  <td>{a.competitorPriceCents !== null ? formatCents(a.competitorPriceCents) : "—"}</td>
                  <td>{a.savingsCents !== null ? formatCents(a.savingsCents) : "—"}</td>
                  <td>{a.matchLevel}</td>
                  <td>{a.matchScore}</td>
                  <td>{a.gtin ?? "—"}</td>
                  <td>{a.priceConfidence.toFixed(2)}</td>
                  <td>{a.freshness ?? "—"}</td>
                  <td>
                    <span className={a.eligibility === "EXCLUDED" ? "pill-bad" : "pill-good"}>
                      {a.eligibility}
                    </span>
                    {a.isMock ? <span className="pill-mock ml-1">MOCK</span> : null}
                  </td>
                  <td className="max-w-[280px] pr-2 text-muted">{a.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data?.audit.length ?? 0) === 0 ? (
            <p className="p-2 text-sm text-muted">
              Nothing recorded yet. Run a comparison from Manual product test.
            </p>
          ) : null}
        </div>
      </section>

      <button type="button" className="btn-secondary" onClick={refresh}>
        Refresh
      </button>
    </main>
  );
}

function ValidationForm({
  opportunityId,
  retailerId,
  competitorRetailerId,
  label,
  onSaved,
}: {
  opportunityId: string;
  retailerId: string;
  competitorRetailerId: string;
  label: string;
  onSaved: (id: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, boolean | null>>({
    pageExisted: null,
    exactProductMatched: null,
    priceMatched: null,
    itemAvailable: null,
    cashierAcceptedPrice: null,
    priceMatchRequestAccepted: null,
  });
  const [notes, setNotes] = useState("");

  const questions: [string, string][] = [
    ["pageExisted", "Retailer page existed"],
    ["exactProductMatched", "Exact product matched"],
    ["priceMatched", "Price matched"],
    ["itemAvailable", "Item available"],
    ["cashierAcceptedPrice", "Cashier accepted price"],
    ["priceMatchRequestAccepted", "Price-match request accepted"],
  ];

  async function submit() {
    const id = `val-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await saveValidation({
      id,
      opportunityId,
      retailerId: retailerId as MatchValidationReport["retailerId"],
      competitorRetailerId:
        competitorRetailerId as MatchValidationReport["competitorRetailerId"],
      pageExisted: answers.pageExisted ?? null,
      exactProductMatched: answers.exactProductMatched ?? null,
      priceMatched: answers.priceMatched ?? null,
      itemAvailable: answers.itemAvailable ?? null,
      cashierAcceptedPrice: answers.cashierAcceptedPrice ?? null,
      priceMatchRequestAccepted: answers.priceMatchRequestAccepted ?? null,
      notes,
      recordedAt: new Date().toISOString(),
    });
    onSaved(id);
  }

  return (
    <div className="card text-sm">
      <p className="mb-2 font-semibold">{label}</p>
      <div className="space-y-1">
        {questions.map(([key, text]) => (
          <div key={key} className="flex items-center justify-between gap-2">
            <span className="text-muted">{text}</span>
            <div className="flex gap-1">
              {([true, false, null] as const).map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  onClick={() => setAnswers((a) => ({ ...a, [key]: v }))}
                  className={`rounded-lg border px-3 py-1 text-xs font-semibold ${
                    answers[key] === v
                      ? "border-brand bg-brand text-white"
                      : "border-line"
                  }`}
                >
                  {v === true ? "Yes" : v === false ? "No" : "—"}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <input
        className="field mt-2 !min-h-[40px] text-sm"
        placeholder="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button type="button" className="btn-secondary mt-2" onClick={submit}>
        Record outcome
      </button>
    </div>
  );
}

/**
 * Can a server actually fetch a retailer page?
 *
 * Every parser here was written against pages captured in a browser. A request
 * from a datacenter is a different situation, and this is the only thing in the
 * app that finds out. It lives on the debug page because it is a question about
 * the deployment, not about groceries.
 *
 * The URLs below are real product pages that were captured by hand, so a
 * success here means the exact page the parsers were built against came back
 * intact — not merely that something answered.
 */
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
                {source === "BOTH"
                  ? "Scanned + Flipp"
                  : source === "SCAN"
                    ? "Scanned"
                    : source === "FLIPP"
                      ? "Flipp only"
                      : "Nothing yet"}
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

function RetailerProbe() {
  const KNOWN = [
    {
      label: "Maxi — Oikos 650 g",
      url: "https://www.maxi.ca/en/greek-yogurt-plain-high-protein-0-m-f/p/21305945_EA",
    },
    {
      label: "IGA — Oikos 650 g",
      url: "https://www.iga.ca/products/oikos-fat-free-0--greek-yogurt-high-protein-plain-650-g",
    },
    {
      // Measurement only. A flyer item page is a different kind of target from
      // a product page: Flipp is a React app, so the interesting outcome is not
      // "403" but "200 with nothing in it" — which would mean server fetching
      // cannot work here at all, whatever the terms say.
      label: "Flipp — IGA flyer item",
      url: "https://flipp.com/en-ca/cote-saintluc-qc/item/1032309099-iga-quebec-weekly-eflyer?postal_code=H4V2L5",
    },
  ];

  /**
   * The four Montreal flyer viewers.
   *
   * A different question from the product probes above. These pages have no
   * schema.org Product block and never will — what decides whether a weekly
   * import is possible is whether the HTML carries the page images, so the
   * verdict for these is read off `flyerImages`, not off product data.
   */
  const FLYERS = [
    { label: "Maxi flyer", url: "https://www.maxi.ca/en/print-flyer" },
    { label: "IGA flyer", url: "https://www.iga.ca/flyer" },
    { label: "Walmart flyer", url: "https://www.walmart.ca/en/flyer" },
    { label: "Super C flyer", url: "https://www.superc.ca/en/flyer" },
    // The two that answer whether the weekly import can be found rather than
    // guessed. raddar is TC Transcontinental's platform and, going by the
    // storage account serving the Maxi and IGA files, already the source they
    // come from — so its own pages are the likeliest place a stable index of
    // those PDF URLs exists. Super C is here because its site, unlike Maxi's
    // and IGA's, answers a server request at all.
    {
      label: "raddar Montréal grocery",
      url: "https://raddar.ca/en/flyers/grocery/montréal-qc",
    },
    { label: "raddar PDF regions", url: "https://raddar.ca/en/flyers/regions/" },
  ];

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [find, setFind] = useState("");
  const [result, setResult] = useState<{ label: string; data: ProbeResult } | null>(
    null,
  );

  async function run(label: string, url: string) {
    setBusy(label);
    setError(null);
    setResult(null);
    const outcome = await probeRetailerUrl(url, find.trim());
    setBusy(null);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setResult({ label, data: outcome.result });
  }

  return (
    <section className="card mb-4 text-sm">
      <p className="mb-1 font-bold">Retailer fetch probe</p>
      <p className="mb-3 text-xs text-muted">
        Asks the Edge Function to fetch a real page and reports what came back.
        Answers the one question no parser can: whether a retailer serves a
        datacenter the same page it serves your phone.
      </p>

      <div className="flex flex-wrap gap-2">
        {KNOWN.map((k) => (
          <button
            key={k.url}
            type="button"
            disabled={busy !== null}
            onClick={() => run(k.label, k.url)}
            className="min-h-[44px] rounded-xl border border-line bg-surface px-3 text-sm font-semibold disabled:opacity-60"
          >
            {busy === k.label ? "Probing…" : k.label}
          </button>
        ))}
      </div>

      <p className="mb-2 mt-4 text-xs font-semibold text-muted">
        Weekly flyers — does the viewer page carry its page images?
      </p>
      <div className="flex flex-wrap gap-2">
        {FLYERS.map((f) => (
          <button
            key={f.url}
            type="button"
            disabled={busy !== null}
            onClick={() => run(f.label, f.url)}
            className="min-h-[44px] rounded-xl border border-line bg-surface px-3 text-sm font-semibold disabled:opacity-60"
          >
            {busy === f.label ? "Probing…" : f.label}
          </button>
        ))}
      </div>

      {/*
        Any URL, so a new target does not need a code change and a deploy to
        measure. The Edge Function still enforces the host allowlist — this
        field widens what can be ASKED, never what can be reached.
      */}
      <div className="mt-4 flex gap-2">
        <input
          className="field flex-1"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Any URL on an allowed host"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <button
          type="button"
          disabled={busy !== null || custom.trim() === ""}
          onClick={() => run("Custom URL", custom.trim())}
          className="min-h-[44px] rounded-xl border border-line bg-surface px-3 text-sm font-semibold disabled:opacity-60"
        >
          {busy === "Custom URL" ? "Probing…" : "Probe"}
        </button>
      </div>

      {/*
        Asks what surrounds a word in the fetched page. Every round of this
        investigation has cost a code change and two deploys to ask one more
        question about a body we had already downloaded.
      */}
      <input
        className="field mt-2 w-full"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Optional: find this text in the page (e.g. .jpg, flyer, publication)"
        value={find}
        onChange={(e) => setFind(e.target.value)}
      />

      {error ? (
        <p className="mt-3 rounded-xl bg-bad/5 px-3 py-2 text-sm text-bad">{error}</p>
      ) : null}

      {result ? (
        <div className="mt-3">
          <p
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${
              probeSucceeded(result.data)
                ? "bg-good/5 text-good"
                : "bg-warn/5 text-warn"
            }`}
          >
            {summariseProbe(result.data)}
          </p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs text-muted">
            {JSON.stringify(result.data, null, 2)}
          </pre>
        </div>
      ) : null}
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

/**
 * Barcode -> canonical identity, from Open Food Facts.
 *
 * This is the only route found to a GTIN. Neither Maxi nor IGA publishes one,
 * so every match between them currently rests on brand, name and size — good,
 * but inferred. A barcode is the product's identity rather than a description
 * of it, and it is what makes a Level 1 match possible.
 *
 * On the debug page rather than in the shopping flow because it is not wired
 * into matching yet: this proves the source works before anything depends on it.
 */
function BarcodeLookupPanel() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BarcodeLookup | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    const outcome = await lookupBarcode(code);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setResult(outcome.result);
  }

  return (
    <section className="card mb-4 text-sm">
      <p className="mb-1 font-bold">Barcode lookup (Open Food Facts)</p>
      <p className="mb-3 text-xs text-muted">
        Neither Maxi nor IGA publishes a barcode, so matches between them rest on
        brand, name and size. A GTIN is the product&rsquo;s identity rather than a
        description of it — this checks whether an open database can supply one.
      </p>

      <div className="flex gap-2">
        <input
          className="field flex-1"
          inputMode="numeric"
          placeholder="8, 12, 13 or 14 digits"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button
          type="button"
          onClick={run}
          disabled={busy || code.trim() === ""}
          className="min-h-[44px] shrink-0 rounded-xl border border-line bg-surface px-3 text-sm font-semibold disabled:opacity-60"
        >
          {busy ? "…" : "Look up"}
        </button>
      </div>

      {error ? (
        <p className="mt-3 rounded-xl bg-bad/5 px-3 py-2 text-sm text-bad">{error}</p>
      ) : null}

      {result ? (
        result.found ? (
          <div className="mt-3 rounded-xl bg-good/5 px-3 py-2">
            <p className="text-sm font-semibold text-good">
              Found — a real GTIN, which unlocks Level 1 matching.
            </p>
            <p className="mt-1 text-sm">
              {[result.brand, result.name, result.quantity]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="mt-1 text-xs text-muted">{result.attribution}</p>
          </div>
        ) : (
          <p className="mt-3 rounded-xl bg-warn/5 px-3 py-2 text-sm text-warn">
            Not in Open Food Facts. That is an ordinary outcome for a
            crowd-sourced database, not a failure — the product simply has not
            been added yet.
          </p>
        )
      ) : null}
    </section>
  );
}
