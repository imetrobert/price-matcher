"use client";

/**
 * What is cheaper where, this week.
 *
 * ---------------------------------------------------------------------------
 * NO PHOTOGRAPH, NO GUESSING
 * ---------------------------------------------------------------------------
 * Every price on this screen was printed in a flyer the shopper loaded, and
 * every comparison is between two prices for the same product in the same
 * unit. Nothing here is inferred from a picture of a cart, and nothing is
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
import { FlyerPageProof } from "@/components/FlyerPageProof";
import { Notice, PageHeader, Spinner } from "@/components/ui";
import { ActiveFlyerPeriod } from "@/components/ActiveFlyerPeriod";
import { RETAILERS } from "@/config/retailers";
import { formatCents } from "@/lib/money";
import { DEFAULT_PREFS, loadPrefs } from "@/lib/prefs";
import {
  findPriceGaps,
  summarizeComparison,
  type ComparisonSummary,
  type PriceGap,
} from "@/services/flyers/compare";
import {
  loadCurrentFlyers,
  loadCurrentOffersResult,
  type StoredOffer,
} from "@/services/flyers/storage";
import { citationLine } from "@/services/flyers/citation";
import { conditionLabel, describeBasis } from "@/types/flyer";

/** A date as a shopper reads it. Noon UTC so it never slips back a day. */
function day(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

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
  // Why the offers could not be read, when they could not. Distinct from
  // "there are none": a broken query must never be reported as an empty week.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_PREFS.minSavingsCents);
  // Off by default. A card price is a price somebody may not be able to pay,
  // and the safe reading has to be the one nobody had to choose.
  const [includeConditional, setIncludeConditional] = useState(false);

  const refresh = useCallback(
    async (minSaving: number, withConditional: boolean) => {
      setLoading(true);
      // The flyers running TODAY, not every flyer ever held: this list is what
      // the sources are built from, and last month's flyer is not a source.
      const [result, flyers] = await Promise.all([
        loadCurrentOffersResult(),
        loadCurrentFlyers(),
      ]);
      const loaded = result.ok ? result.offers : [];
      setLoadError(result.ok ? null : result.error);
      const found = findPriceGaps(loaded, minSaving, withConditional);
      setOffers(loaded);
      setGaps(found);
      setSummary(summarizeComparison(loaded, found, flyers));
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    const prefs = loadPrefs();
    setThreshold(prefs.minSavingsCents);
    void refresh(prefs.minSavingsCents, false);
  }, [refresh]);

  return (
    <main className="mx-auto max-w-[900px]">
      <PageHeader
        title="Cheaper elsewhere this week"
        subtitle="Every price here was printed in a flyer you loaded."
        backHref="/"
      />

      <ActiveFlyerPeriod />

      {loading ? (
        <section className="card mb-4">
          <Spinner label="Comparing this week's flyers…" />
        </section>
      ) : null}

      {/*
        A failure and an empty week are different answers and get different
        words. "No flyers loaded" printed over a broken query is a lie the
        shopper would act on by re-importing flyers they already have.
      */}
      {!loading && loadError ? (
        <div className="mb-4">
          <Notice tone="warn" title="Could not read this week's offers">
            {loadError} Nothing below is a complete comparison. Reload the page;
            if it keeps happening, the flyers screen shows what is stored.
          </Notice>
        </div>
      ) : null}

      {!loading && !loadError && summary && summary.sources.length === 0 ? (
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

      {!loading && summary && summary.sources.length > 0 ? (
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
          {/*
            The scope of the answer, stated before the answer.

            This screen compares what THIS WEEK'S FLYERS ADVERTISE — not what
            the shops sell. A product nobody put in a flyer cannot appear here
            however different its price is between two stores, and a flyer that
            was not loaded is a store that does not exist as far as these
            numbers go. "3 gaps across 4 stores" gave no way to tell any of
            that apart from a complete survey.
          */}
          <p className="mb-3 text-xs text-muted">
            Only products advertised in the flyers below are compared. Anything
            not in a flyer this week — and any store whose flyer you have not
            loaded — is not in these numbers.
          </p>

          <div className="mb-3 space-y-1">
            {summary.sources.map((source) => (
              <p
                key={`${source.retailerId}-${source.validFrom}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-line py-1 text-xs last:border-0"
              >
                <span className="font-semibold">
                  {RETAILERS[source.retailerId]?.displayName ?? source.retailerId}
                </span>
                <span className="text-muted">
                  {day(source.validFrom)} – {day(source.validTo)}
                </span>
                <span className={source.offers === 0 ? "text-warn" : "text-muted"}>
                  {source.offers} offers
                  {source.pageCount !== null && source.pagesRead !== null
                    ? ` · ${source.pagesRead}/${source.pageCount} pages`
                    : ""}
                </span>
              </p>
            ))}
          </div>

          {/*
            A store held for this week that put nothing into the comparison.
            It used to be invisible — no row at all — which read exactly like a
            store nobody had loaded. Said plainly, because the shopper is the
            only one who can tell which of the three reasons it is.
          */}
          {summary.sources.some((s) => s.offers === 0) ? (
            <p className="mb-3 rounded-md bg-warn/10 p-2 text-xs text-warn">
              {summary.sources
                .filter((s) => s.offers === 0)
                .map((s) => RETAILERS[s.retailerId]?.displayName ?? s.retailerId)
                .join(", ")}{" "}
              {summary.sources.filter((s) => s.offers === 0).length === 1
                ? "is loaded but has no prices in this comparison"
                : "are loaded but have no prices in this comparison"}
              . Either the pages have not been read yet, the reading failed, or
              the file held no prices. The flyers screen says which.
            </p>
          ) : null}

          {summary.incomplete ? (
            <p className="mb-3 rounded-md bg-warn/10 p-2 text-xs text-warn">
              Some pages have not been read yet. Offers on them are missing
              from this comparison, not absent from the flyer.
            </p>
          ) : null}

          <Row
            label="Offers compared"
            value={String(
              includeConditional
                ? summary.offersConsidered + summary.offersConditionalUsable
                : summary.offersConsidered,
            )}
          />
          <Row
            label={includeConditional ? "Left out (multi-buy)" : "Set aside as conditional"}
            value={String(
              includeConditional
                ? summary.offersNeverComparable
                : summary.offersSkippedConditional,
            )}
          />

          {/*
            The opt-in, and the line it does not cross.

            A card price and a quantity limit advertise a price for ONE of the
            item; whether you can pay it is a condition you can read. A
            multi-buy does not — "2 for $5" is the price of two, and set beside
            "$3.99 each" it reads a dollar cheaper when it is a dollar dearer
            per item. Halving it to $2.50 quotes a number no flyer printed. So
            that group stays out whatever this is set to.
          */}
          <label className="mt-3 flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={includeConditional}
              onChange={(e) => {
                setIncludeConditional(e.target.checked);
                void refresh(threshold, e.target.checked);
              }}
            />
            <span>
              <span className="font-semibold">
                Include loyalty-card and limited-quantity prices
              </span>
              <span className="block text-muted">
                {summary.offersConditionalUsable} more offers. Their price is
                for one item, but you only pay it with the card, or up to the
                limit — each one shows its condition. Multi-buys and
                with-purchase offers ({summary.offersNeverComparable}) stay out
                either way: their number is the price of something else.
              </span>
            </span>
          </label>

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
              void refresh(next, includeConditional);
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

      {!loading && gaps.some((g) => g.cheapest.confirmedAt === null) ? (
        <div className="mt-5">
          <Notice tone="warn" title="These are model readings, not checked prices">
            A price here was read off flyer artwork and nothing has corroborated
            it. Checking one takes a few seconds — the page is right there.
            <span className="mt-3 block">
              <Link href="/confirm" className="btn-primary">
                Check the prices behind these gaps
              </Link>
            </span>
          </Notice>
        </div>
      ) : null}

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
        {/*
          The condition beside the number it qualifies, verbatim. A card price
          shown without "avec carte Scène+" is the exact way a saving
          evaporates at checkout, and this list is where somebody reads the
          number they intend to act on.
        */}
        {gap.offers
          .filter((o) => o.condition !== "UNIT_PRICE")
          .map((offer) => (
            <p key={`${offer.id}-cond`} className="text-xs text-warn">
              {RETAILERS[offer.retailerId]?.displayName ?? offer.retailerId}:{" "}
              {offer.conditionText ?? conditionLabel(offer.condition)}
            </p>
          ))}
      </div>

      {/*
        The citation, verbatim, on the cheapest offer — because that is the one
        somebody will take to checkout, and the page number is what makes it
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

      {/*
        The page itself, on demand.

        A citation names the page; this shows it, with the tile marked when the
        reading recorded where it was. Behind a toggle because a deals list can
        be twenty cards long and each picture is a signed request — the page a
        person actually intends to use is the one worth fetching.
      */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-semibold text-brand">
          Show the flyer page
        </summary>
        <FlyerPageProof
          flyerId={cheapest.flyerId}
          page={cheapest.flyerPage}
          box={cheapest.box}
        />
      </details>

      {gap.hasConditional ? (
        <p className="mt-2 rounded-md bg-warn/10 p-2 text-xs text-warn">
          A price here depends on a condition — a card, or a quantity limit.
          You pay it only if that applies to you.
        </p>
      ) : null}

      {cheapest.confirmedAt === null ? (
        <p className="mt-1 text-xs text-warn">
          Not yet confirmed against the page — check it before showing anyone.
        </p>
      ) : (
        <p className="mt-1 text-xs text-good">
          Checked against the page by you.
        </p>
      )}
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
