"use client";

/**
 * Developer / debug view (spec §49) plus the "Verify This Match" feedback
 * loop (spec §55). Desktop-friendly table; not part of the shopper flow.
 */

import { useCallback, useEffect, useState } from "react";

import { AuthGuard } from "@/components/AuthGuard";
import { Notice, PageHeader } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { formatCents } from "@/lib/money";
import { loadLastResult } from "@/lib/prefs";
import { activeBackend, recentAudit, recentObservations, saveValidation, validationSummary } from "@/lib/store";
import { visionProviderName, env, edgeFunctionUrl } from "@/config/env";
import { authConfigured } from "@/lib/auth/config";
import { APP_NAME, checkAppAccess } from "@/lib/auth/access";
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
} from "@/types";

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
      <AdminView />
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
