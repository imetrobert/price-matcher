"use client";

/**
 * What is cheaper where, this week.
 *
 * ---------------------------------------------------------------------------
 * NO PHOTOGRAPH, NO GUESSING
 * ---------------------------------------------------------------------------
 * Every price on this screen was printed in a flyer the shopper loaded, and
 * every comparison is between two prices for the same product in the same
 * unit. Nothing here is inferred from a picture of a trolley, and nothing is
 * calculated by a model — the arithmetic is `calculateSavingsCents`, in
 * integer cents.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL NOT SAY
 * ---------------------------------------------------------------------------
 * That a store will match a price. Every retailer policy in this app is
 * UNKNOWN with no published source (see config/policies.ts), so this screen
 * says where a thing is cheaper and where that was advertised, and stops
 * there. Whether a cashier honours it is between the shopper and the shop.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AuthGuard } from "@/components/AuthGuard";
import { Notice, PageHeader, Spinner } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { formatCents } from "@/lib/money";
import { DEFAULT_PREFS, loadPrefs } from "@/lib/prefs";
import {
  findPriceGaps,
  summariseComparison,
  type ComparisonSummary,
  type PriceGap,
} from "@/services/flyers/compare";
import { loadCurrentOffers, type StoredOffer } from "@/services/flyers/storage";
import { citationLine } from "@/services/flyers/citation";
import { describeBasis } from "@/types/flyer";

export default function DealsPage() {
  return (
    <AuthGuard>
      <Deals />
    </AuthGuard>
  );
}

function Deals() {
  const [loading, setLoading] = useState(true);
  const [offers, setOffers] = useState<StoredOffer[]>([]);
  const [gaps, setGaps] = useState<PriceGap[]>([]);
  const [summary, setSummary] = useState<ComparisonSummary | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_PREFS.minSavingsCents);

  const refresh = useCallback(async (minSaving: number) => {
    setLoading(true);
    const loaded = await loadCurrentOffers();
    const found = findPriceGaps(loaded, minSaving);
    setOffers(loaded);
    setGaps(found);
    setSummary(summariseComparison(loaded, found));
    setLoading(false);
  }, []);

  useEffect(() => {
    const prefs = loadPrefs();
    setThreshold(prefs.minSavingsCents);
    void refresh(prefs.minSavingsCents);
  }, [refresh]);

  return (
    <main className="mx-auto max-w-[900px]">
      <PageHeader
        title="Cheaper elsewhere this week"
        subtitle="Every price here was printed in a flyer you loaded."
        backHref="/"
      />

      {loading ? (
        <section className="card mb-4">
          <Spinner label="Comparing this week's flyers…" />
        </section>
      ) : null}

      {!loading && offers.length === 0 ? (
        <div className="mb-4">
          <Notice tone="warn" title="No flyers loaded for this week">
            Nothing has been stored for a flyer running today. Import this
            week&rsquo;s flyers and this fills in.
          </Notice>
          <Link href="/flyers" className="btn-primary mt-3">
            Import flyers
          </Link>
        </div>
      ) : null}

      {!loading && summary && offers.length > 0 ? (
        <section className="card mb-4 text-sm">
          {/*
            Said above the results, because the results are only as good as the
            input: "nothing found" means something quite different with two
            flyers loaded than with five.
          */}
          <p className="mb-2 font-bold">
            {summary.gaps} price gap{summary.gaps === 1 ? "" : "s"} across{" "}
            {summary.retailers.length} store
            {summary.retailers.length === 1 ? "" : "s"}
          </p>
          <p className="mb-2 text-xs text-muted">
            {summary.retailers
              .map((r) => RETAILERS[r]?.displayName ?? r)
              .join(", ")}
          </p>
          <Row
            label="Offers compared"
            value={String(summary.offersConsidered)}
          />
          <Row
            label="Set aside as conditional"
            value={String(summary.offersSkippedConditional)}
          />
          <p className="mt-2 text-xs text-muted">
            Conditional offers — multi-buys, loyalty-card prices, quantity
            limits — are never compared. The advertised number is not what you
            pay unless you satisfy something this app cannot check.
          </p>

          <label className="mt-3 block text-xs text-muted" htmlFor="threshold">
            Only show gaps of at least
          </label>
          <select
            id="threshold"
            className="field mt-1"
            value={threshold}
            onChange={(e) => {
              const next = Number(e.target.value);
              setThreshold(next);
              void refresh(next);
            }}
          >
            {[25, 50, 100, 200, 500].map((cents) => (
              <option key={cents} value={cents}>
                {formatCents(cents)}
              </option>
            ))}
          </select>
        </section>
      ) : null}

      {!loading && offers.length > 0 && gaps.length === 0 ? (
        <Notice tone="info" title="No gaps worth crossing the street for">
          Every product found in more than one flyer this week is within{" "}
          {formatCents(threshold)}. That is a real answer, not a failure — most
          weeks most staples are priced alike.
        </Notice>
      ) : null}

      <div className="space-y-3">
        {gaps.map((gap) => (
          <GapCard key={gap.cheapest.id} gap={gap} />
        ))}
      </div>

      {!loading && offers.length > 0 ? (
        <div className="mt-5">
          <Notice tone="info" title="Where this stops">
            This says where something is cheaper and where that was advertised.
            It does not say a store will match it — no retailer policy in this
            app has a published source, so that claim is not one it makes.
          </Notice>
        </div>
      ) : null}
    </main>
  );
}

function GapCard({ gap }: { gap: PriceGap }) {
  const cheapest = gap.cheapest;
  return (
    <section className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold">{gap.label}</p>
          <p className="text-xs text-muted">
            {gap.brand ? `${gap.brand} · ` : ""}
            {gap.size ?? "size not printed"} · {describeBasis(gap.basis)}
          </p>
        </div>
        <p className="shrink-0 text-right">
          <span className="block text-lg font-extrabold text-good">
            {formatCents(gap.savingCents)}
          </span>
          <span className="text-xs text-muted">cheaper</span>
        </p>
      </div>

      <div className="mt-3 space-y-1 text-sm">
        {gap.offers.map((offer, i) => (
          <p
            key={offer.id}
            className={`flex justify-between gap-3 ${
              i === 0 ? "font-bold text-good" : "text-muted"
            }`}
          >
            <span>{RETAILERS[offer.retailerId]?.displayName ?? offer.retailerId}</span>
            <span>
              {formatCents(offer.price)} · p.{offer.flyerPage}
            </span>
          </p>
        ))}
      </div>

      {/*
        The citation, verbatim, on the cheapest offer — because that is the one
        somebody will take to a till, and the page number is what makes it
        checkable whether or not a picture was kept.
      */}
      <p className="mt-3 rounded-lg bg-surface px-2 py-1 text-xs">
        {citationLine({
          retailerId: cheapest.retailerId,
          flyerPage: cheapest.flyerPage,
          validFrom: cheapest.validFrom,
          validTo: cheapest.validTo,
          hasPageImage: true,
        })}
      </p>

      {cheapest.confirmedAt === null ? (
        <p className="mt-1 text-xs text-warn">
          Not yet confirmed against the page — check it before showing anyone.
        </p>
      ) : null}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex justify-between gap-3 border-b border-line py-1 last:border-0">
      <span className="text-muted">{label}</span>
      <span className="text-right font-semibold">{value}</span>
    </p>
  );
}
