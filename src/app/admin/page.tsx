"use client";

/**
 * Developer / debug view (spec §49) plus the "Verify This Match" feedback
 * loop (spec §55). Desktop-friendly table; not part of the shopper flow.
 */

import { useCallback, useEffect, useState } from "react";

import { Notice, PageHeader } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { formatCents } from "@/lib/money";
import { loadLastResult } from "@/lib/prefs";
import type { AuditRecord, PipelineResult, PriceObservation } from "@/types";

interface AuditPayload {
  audit: AuditRecord[];
  observations: PriceObservation[];
  validation: Record<
    string,
    { total: number; priceMatched: number; accepted: number }
  >;
}

export default function AdminPage() {
  const [data, setData] = useState<AuditPayload | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [lastRun, setLastRun] = useState<PipelineResult | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetch("/api/admin/audit?limit=200")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null));
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
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
          <p className="mb-2 font-bold">
            Measured retailer reliability (from your feedback)
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
    const res = await fetch("/api/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        opportunityId,
        retailerId,
        competitorRetailerId,
        ...answers,
        notes,
      }),
    });
    const data = await res.json();
    if (data.ok) onSaved(data.id);
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
