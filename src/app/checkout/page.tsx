"use client";

/**
 * Checkout Mode: one match at a time, big enough to hold up.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN IS FOR
 * ---------------------------------------------------------------------------
 * A person is at a till with somebody waiting behind them. They need the
 * competitor's name, the price, the page and the dates, in that order, without
 * scrolling or pinching. Everything else is in the way.
 *
 * ---------------------------------------------------------------------------
 * WHAT EARNS A PLACE HERE
 * ---------------------------------------------------------------------------
 * Not every result. A match reaches this screen only when all of these hold:
 *
 *   THE PRODUCTS AGREE. Brand, name, variant and size — the same threshold the
 *   deals screen uses, checked before any price is compared.
 *
 *   BOTH PRICES ARE PRINTED. Your own shop advertised it too, so the gap is a
 *   subtraction between two advertised numbers rather than between one number
 *   and a guess at a shelf price.
 *
 *   THE PRICE IS UNCONDITIONAL. A card price may be worth knowing on the
 *   results screen; at a till it is a saving that evaporates when the cashier
 *   asks a question this app cannot answer.
 *
 *   THERE IS A PAGE TO SHOW. A claim with no document behind it is exactly
 *   what a price-match desk declines.
 *
 * Anything short of that stays on the results screen with its reason attached.
 * It simply does not get shown to a cashier.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { FlyerPageProof } from "@/components/FlyerPageProof";
import { MockBanner, Money, Notice } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { loadLastResult } from "@/lib/prefs";
import { citationLine } from "@/services/flyers/citation";
import { itemLabel, type CartComparison, type CartLine } from "@/services/flyers/cartMatch";
import type { RetailerId } from "@/types";

interface StoredCart {
  comparison: CartComparison;
  currentRetailer: RetailerId;
  at: string;
}

export default function CheckoutPage() {
  const [cart, setCart] = useState<StoredCart | null>(null);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setCart(loadLastResult<StoredCart>());
    setLoaded(true);
  }, []);

  const ready = (cart?.comparison?.cheaperElsewhere ?? []).filter(showable);
  const current = ready[index];
  const age = cart ? scanAge(cart.at) : null;

  if (!loaded) return null;

  if (ready.length === 0) {
    return (
      <main>
        <Link href="/scan" className="mb-3 inline-block text-sm font-semibold text-brand">
          ← Back
        </Link>
        <Notice tone="warn" title="Nothing ready to show a cashier">
          Checkout Mode only shows a match where both shops advertised the same
          product, the cheaper price carries no condition, and there is a flyer
          page to show. Nothing in the last scan met all three.
        </Notice>
        <Link href="/scan" className="btn-primary mt-4">
          Scan again
        </Link>
      </main>
    );
  }

  return (
    <main className="flex min-h-[92dvh] flex-col">
      <MockBanner
        visible={Boolean(current?.item.isMock)}
        note="This product came from test fixtures, not from your photo. Do not show this screen to a cashier."
      />

      <div className="mb-4 flex items-center justify-between">
        <Link href="/scan" className="text-sm font-semibold text-brand">
          ← Exit
        </Link>
        <span className="text-sm text-muted">
          {index + 1} of {ready.length}
        </span>
      </div>

      {/*
        Said above the price, not below it. A cashier reading this screen is
        being asked to accept a number; if that number came out of a scan from
        two days ago, that is part of what they are accepting.
      */}
      {age !== null ? (
        <div className="mb-2 rounded-md bg-warn/10 p-2 text-center text-sm font-semibold text-warn">
          This cart was scanned {age}. Prices may have changed — scan again to
          be sure.
        </div>
      ) : null}

      {current ? (
        <CheckoutCard line={current} here={cart!.currentRetailer} />
      ) : null}

      <div className="mt-auto grid grid-cols-2 gap-3 pt-4">
        <button
          type="button"
          className="btn-secondary"
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={index >= ready.length - 1}
          onClick={() => setIndex((i) => Math.min(ready.length - 1, i + 1))}
        >
          Next
        </button>
      </div>
    </main>
  );
}

/**
 * The gate, in one place so it cannot drift from the prose above.
 *
 * `savingCents` being non-null carries "both shops advertised it": the
 * comparison sets it to null precisely when your own shop did not, and a gap
 * nobody can compute is not one to quote at a till.
 */
function showable(line: CartLine): boolean {
  return (
    line.savingCents !== null &&
    line.bestElsewhere !== null &&
    line.hereOffer !== null &&
    line.bestElsewhere.condition === "UNIT_PRICE" &&
    // The flyer must still be running. An expired advertisement is not a
    // price, and this screen exists to be held up in front of a cashier.
    isCurrent(line.bestElsewhere.validTo)
  );
}

/** Is that flyer still running today? Dates are ISO days, compared as text. */
function isCurrent(validTo: string): boolean {
  return validTo >= new Date().toISOString().slice(0, 10);
}

/**
 * How old the scan is, in words, or null when it was taken today.
 *
 * `at` was recorded from the beginning and never read. A cart from three days
 * ago rendered exactly like one from three minutes ago — at a till, in large
 * type, with a saving on it. The project's own rule is that a cached result is
 * never presented as current without identifying its age, and this screen was
 * the one place breaking it.
 */
function scanAge(at: string): string | null {
  const then = new Date(at);
  if (Number.isNaN(then.getTime())) return "at an unknown time";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) {
    return then.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)
      ? null
      : "yesterday";
  }
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function CheckoutCard({ line, here }: { line: CartLine; here: RetailerId }) {
  const best = line.bestElsewhere!;
  const mine = line.hereOffer!;
  const competitor = RETAILERS[best.retailerId]?.displayName ?? best.retailerId;
  const hereName = RETAILERS[here]?.displayName ?? here;

  return (
    <section className="card">
      <p className="text-xl font-extrabold leading-tight">{itemLabel(line.item)}</p>
      {best.size ? <p className="text-sm text-muted">{best.size}</p> : null}

      <div className="mt-4 grid grid-cols-2 gap-3 text-center">
        <div className="rounded-xl border border-line p-3">
          <p className="text-xs uppercase tracking-wide text-muted">{hereName}</p>
          <p className="text-2xl font-extrabold">
            <Money cents={mine.price} />
          </p>
          <p className="text-xs text-muted">page {mine.flyerPage}</p>
        </div>
        <div className="rounded-xl border border-good bg-good/5 p-3">
          <p className="text-xs uppercase tracking-wide text-good">{competitor}</p>
          <p className="text-2xl font-extrabold text-good">
            <Money cents={best.price} />
          </p>
          <p className="text-xs text-muted">page {best.flyerPage}</p>
        </div>
      </div>

      <p className="mt-3 text-center text-lg font-extrabold text-good">
        SAVE <Money cents={line.savingCents!} />
      </p>

      {/*
        The citation, verbatim and large. This is the sentence somebody reads
        aloud, and paraphrasing it at a desk is how a match gets declined.
      */}
      <p className="mt-4 rounded-lg bg-surface px-3 py-2 text-sm">
        {citationLine({
          retailerId: best.retailerId,
          flyerPage: best.flyerPage,
          validFrom: best.validFrom,
          validTo: best.validTo,
          hasPageImage: true,
        })}
      </p>

      {best.confirmedAt === null ? (
        <p className="mt-2 rounded-md bg-warn/10 p-2 text-sm text-warn">
          This price was read from the flyer by a model and has not been checked
          against the page by a person. Look at the page below before showing it
          to anyone.
        </p>
      ) : (
        <p className="mt-2 rounded-md bg-good/10 p-2 text-sm text-good">
          You checked this against the page.
        </p>
      )}

      <FlyerPageProof
        flyerId={best.flyerId}
        page={best.flyerPage}
        box={best.box}
      />

      {/*
        On every card, because it is the one thing this app cannot know and the
        one thing a shopper is most likely to assume it does.
      */}
      <p className="mt-3 text-xs text-muted">
        CartMatch does not know {hereName}&rsquo;s price-match policy — no
        retailer policy in this app has a published source. This shows what was
        advertised where; whether it is honoured is between you and the shop.
      </p>
    </section>
  );
}
