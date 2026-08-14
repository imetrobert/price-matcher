"use client";

/**
 * Checking a stored reading against the page it came from.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS
 * ---------------------------------------------------------------------------
 * Every offer in this app is a candidate: a model read a number off artwork
 * and nothing corroborated it. Every screen says so — "not yet confirmed
 * against the page, check it before showing anyone" — and until now there was
 * no way to do the checking those warnings asked for. A warning nobody can act
 * on is one people learn to read past, which is worse than no warning.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT ASK YOU TO CHECK EVERYTHING
 * ---------------------------------------------------------------------------
 * A week is around nine hundred offers. Nobody is going to check nine hundred
 * of anything, and a screen that asks them to is a screen that gets closed.
 *
 * So it queues only the offers that are load-bearing: the ones taking part in
 * a price gap this week, biggest gap first. Those are the numbers somebody
 * will actually act on — the ones that send a person to another shop, or get
 * read aloud at a till — and they are a handful, not hundreds. An offer no
 * comparison depends on can stay unconfirmed forever without costing anybody
 * anything.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AuthGuard } from "@/components/AuthGuard";
import { Notice, PageHeader, Spinner } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { formatCents, tryParsePriceToCents } from "@/lib/money";
import { DEFAULT_PREFS, loadPrefs } from "@/lib/prefs";
import { findPriceGaps } from "@/services/flyers/compare";
import {
  confirmOffer,
  correctOfferPrice,
  flyerPageUrl,
  loadCurrentOffers,
  rejectOffer,
  type StoredOffer,
} from "@/services/flyers/storage";
import { describeBasis } from "@/types/flyer";

export default function ConfirmPage() {
  return (
    <AuthGuard>
      <ConfirmQueue />
    </AuthGuard>
  );
}

function ConfirmQueue() {
  const [loading, setLoading] = useState(true);
  const [queue, setQueue] = useState<StoredOffer[]>([]);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const offers = await loadCurrentOffers();
    const gaps = findPriceGaps(offers, loadPrefs().minSavingsCents ?? DEFAULT_PREFS.minSavingsCents);

    // Both sides of every gap, biggest first, unchecked only. Both sides
    // matter: a saving is a subtraction, and a wrong number on the dearer side
    // invents a gap just as effectively as a wrong one on the cheaper.
    const seen = new Set<string>();
    const next: StoredOffer[] = [];
    for (const gap of gaps) {
      for (const offer of [gap.cheapest, gap.dearest]) {
        if (seen.has(offer.id)) continue;
        seen.add(offer.id);
        if (offer.confirmedAt === null) next.push(offer);
      }
    }

    setQueue(next);
    setIndex(0);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = queue[index];

  const advance = () => {
    setDone((d) => d + 1);
    setIndex((i) => i + 1);
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-[900px]">
        <PageHeader title="Check the prices" backHref="/" />
        <section className="card">
          <Spinner label="Finding the offers worth checking…" />
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[900px]">
      <PageHeader
        title="Check the prices"
        subtitle="Only the offers a comparison depends on — not every offer in the flyer."
        backHref="/"
      />

      {current ? (
        <>
          <p className="mb-3 text-sm text-muted">
            {index + 1} of {queue.length} worth checking
            {done > 0 ? ` · ${done} done` : ""}
          </p>
          <OfferCheck offer={current} onDone={advance} />
        </>
      ) : (
        <Notice
          tone="info"
          title={
            done > 0
              ? `${done} checked`
              : "Nothing needs checking"
          }
        >
          {done > 0
            ? "Those offers now say a person looked at the page. The rest of this week's offers are still model readings — they are only worth checking if a comparison starts to depend on one."
            : "Every offer taking part in a price gap this week has already been checked against its page, or there are no gaps yet."}
          <span className="mt-3 block">
            <Link href="/deals" className="btn-secondary">
              Back to what is cheaper
            </Link>
          </span>
        </Notice>
      )}
    </main>
  );
}

/**
 * One reading, beside the page it came from.
 *
 * The page image is the whole point: a verdict passed without looking is worse
 * than no verdict, because it puts "a person checked this" on a number nobody
 * checked. So the image loads first and the buttons sit underneath it.
 */
function OfferCheck({
  offer,
  onDone,
}: {
  offer: StoredOffer;
  onDone: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [imageState, setImageState] = useState<"loading" | "ready" | "missing">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let live = true;
    setImageState("loading");
    flyerPageUrl(offer.flyerId, offer.flyerPage)
      .then((found) => {
        if (!live) return;
        setUrl(found);
        setImageState(found ? "ready" : "missing");
      })
      .catch(() => live && setImageState("missing"));
    return () => {
      live = false;
    };
  }, [offer.flyerId, offer.flyerPage]);

  const act = async (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onDone();
  };

  return (
    <section className="card">
      <p className="font-bold leading-tight">{offer.advertisedText}</p>
      <p className="text-xs text-muted">
        {offer.brand ? `${offer.brand} · ` : ""}
        {offer.size ?? "size not printed"} · {describeBasis(offer.basis)}
      </p>

      <p className="mt-3 text-3xl font-extrabold">{formatCents(offer.price)}</p>
      <p className="text-sm text-muted">
        {RETAILERS[offer.retailerId]?.displayName ?? offer.retailerId}, page{" "}
        {offer.flyerPage}
      </p>

      {offer.conditionText ? (
        <p className="mt-1 text-sm text-warn">{offer.conditionText}</p>
      ) : null}

      {imageState === "loading" ? (
        <p className="mt-3 text-sm text-muted">Loading the page…</p>
      ) : imageState === "missing" || !url ? (
        <p className="mt-3 rounded-md bg-warn/10 p-2 text-sm text-warn">
          No page image was kept for this flyer, so there is nothing here to
          check against. Compare it with your own copy of page {offer.flyerPage}{" "}
          before confirming.
        </p>
      ) : (
        <a href={url} target="_blank" rel="noreferrer" className="mt-3 block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={`Flyer page ${offer.flyerPage}`}
            className="w-full rounded-xl border border-line"
          />
          <span className="mt-1 block text-center text-xs text-muted">
            Tap to open full size and pinch to zoom.
          </span>
        </a>
      )}

      {error ? (
        <p className="mt-3 rounded-md bg-bad/10 p-2 text-sm text-bad">{error}</p>
      ) : null}

      {fixing ? (
        <div className="mt-4">
          <label className="mb-1 block text-sm font-semibold" htmlFor="price">
            What does the page actually say?
          </label>
          <input
            id="price"
            className="field"
            inputMode="decimal"
            placeholder="4.99"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          {/*
            The price and nothing else. Editing the wording would change what
            this offer matches against, which is a different act from fixing a
            misread number and would quietly move the offer onto another
            product.
          */}
          <p className="mt-1 text-xs text-muted">
            Only the price. If the product wording itself is wrong, mark it
            wrong instead — a corrected price on the wrong product is still the
            wrong offer.
          </p>
          <button
            type="button"
            className="btn-primary mt-3"
            disabled={busy}
            onClick={() => {
              const cents = tryParsePriceToCents(typed);
              if (cents === null) {
                setError("That is not a price this app can read.");
                return;
              }
              void act(() => correctOfferPrice(offer.id, cents));
            }}
          >
            Save {tryParsePriceToCents(typed) !== null ? formatCents(tryParsePriceToCents(typed)!) : "the price"}
          </button>
          <button
            type="button"
            className="btn-ghost mt-2"
            onClick={() => setFixing(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void act(() => confirmOffer(offer.id))}
          >
            The page says {formatCents(offer.price)} — correct
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => {
              setTyped("");
              setFixing(true);
            }}
          >
            The price is different
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void act(() => rejectOffer(offer.id))}
          >
            This is wrong — drop it
          </button>
        </div>
      )}
    </section>
  );
}
