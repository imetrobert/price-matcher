"use client";

/**
 * Price-proof sheet (spec §22).
 *
 * Shown BEFORE the retailer page opens, so the shopper — and the cashier
 * looking over their shoulder — sees exactly what is being claimed and on what
 * evidence, rather than a raw web page with no context.
 */

import { RETAILERS } from "@/config/retailers";
import { formatDate } from "@/services/pricing/freshness";
import { Check, Money } from "@/components/ui";
import type { SavingsOpportunity } from "@/types";

export function ProofSheet({
  opportunity,
  onClose,
}: {
  opportunity: SavingsOpportunity;
  onClose: () => void;
}) {
  const o = opportunity;
  const current = RETAILERS[o.currentStore.retailerId];
  const competitor = RETAILERS[o.competitor.retailerId];
  const url = o.competitor.productUrl;
  const isMockUrl = Boolean(url && url.includes(".invalid"));

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Price proof"
      onClick={onClose}
    >
      <div
        className="max-h-[92dvh] w-full max-w-[560px] overflow-y-auto rounded-t-3xl bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-line" />

        {o.isMock ? (
          <p className="mb-3 rounded-xl bg-mock/10 px-3 py-2 text-sm font-extrabold uppercase text-mock">
            Mock data — not a real price
          </p>
        ) : null}

        <h2 className="text-xl font-extrabold leading-tight">
          {o.canonical.brand} {o.canonical.name}
        </h2>
        <p className="text-sm text-muted">
          {[o.canonical.variant, o.canonical.size?.raw]
            .filter(Boolean)
            .join(", ")}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-line p-3">
            <p className="text-xs font-semibold uppercase text-muted">
              {current.displayName}
            </p>
            <p className="text-2xl font-extrabold">
              <Money cents={o.currentStore.price} />
            </p>
            <p className="mt-1 text-[11px] text-muted">
              {o.currentStore.sourceType === "USER_ENTERED"
                ? "Shelf price you entered"
                : "Current store"}
            </p>
          </div>
          <div className="rounded-xl border border-brand/30 bg-brand/5 p-3">
            <p className="text-xs font-semibold uppercase text-brand">
              {competitor.displayName}
            </p>
            <p className="text-2xl font-extrabold text-brand">
              <Money cents={o.competitor.price} />
            </p>
            <p className="mt-1 text-[11px] text-muted">Competitor</p>
          </div>
        </div>

        <p className="mt-3 text-center text-lg font-extrabold text-good">
          You save <Money cents={o.savingsCents} />
        </p>

        <ul className="mt-4 space-y-2">
          {o.proofPoints.map((p) => (
            <li key={p.label} className="flex gap-2 text-sm">
              <Check passed={p.passed} />
              <span>
                <span className="font-semibold">{p.label}</span>
                <span className="block text-muted">{p.detail}</span>
              </span>
            </li>
          ))}
        </ul>

        <dl className="mt-4 space-y-1 border-t border-line pt-3 text-xs text-muted">
          <Row label="Observed">
            {o.competitor.observedAt
              ? formatDate(o.competitor.observedAt)
              : "unknown"}
          </Row>
          {o.competitor.validity?.endsAt ? (
            <Row label="Valid until">
              {formatDate(o.competitor.validity.endsAt)}
            </Row>
          ) : null}
          <Row label="Availability">{o.competitor.availability}</Row>
          <Row label="Match">
            {o.match.level} · score {o.match.score}/100
          </Row>
          {o.canonical.gtin ? (
            <Row label="GTIN">{o.canonical.gtin}</Row>
          ) : null}
          <Row label="Source">{o.competitor.sourceType}</Row>
          {url ? (
            <Row label="URL">
              <span className="break-all">{url}</span>
            </Row>
          ) : null}
        </dl>

        {url && !isMockUrl ? (
          <a
            className="btn-primary mt-4"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
          >
            View {competitor.displayName} price
          </a>
        ) : (
          <div className="mt-4 rounded-xl border border-warn/30 bg-warn/5 p-3 text-sm text-warn">
            {isMockUrl
              ? "This is a mock URL and cannot be opened. Real product links appear only with live retailer data."
              : "No verified product URL for this result, so it cannot be shown as checkout proof."}
          </div>
        )}

        <p className="mt-3 text-[11px] leading-snug text-muted">
          Prices and price-match eligibility are determined by the retailer.
          Verify the current price before requesting a match. CartMatch does not
          guarantee that any retailer will honour a price match.
        </p>

        <button className="btn-secondary mt-3" onClick={onClose} type="button">
          Close
        </button>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 font-semibold">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
