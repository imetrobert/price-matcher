"use client";

/**
 * Checkout Mode (spec §25, §26).
 *
 * Everything shown here was computed and verified before the user arrived on
 * this screen. There is NO network call, no AI, no recomputation — it reads the
 * saved result and renders it very large. The only outbound action is opening
 * the proof URL that was already verified.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { ProofSheet } from "@/components/ProofSheet";
import { MockBanner, Money, Notice } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { loadLastResult } from "@/lib/prefs";
import type { PipelineResult, SavingsOpportunity } from "@/types";

export default function CheckoutPage() {
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [index, setIndex] = useState(0);
  const [proof, setProof] = useState<SavingsOpportunity | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setResult(loadLastResult<PipelineResult>());
    setLoaded(true);
  }, []);

  const matches = (result?.opportunities ?? []).filter((o) => o.checkoutReady);
  const current = matches[index];

  if (!loaded) return null;

  if (matches.length === 0) {
    return (
      <main>
        <Link href="/scan" className="mb-3 inline-block text-sm font-semibold text-brand">
          ← Back
        </Link>
        <Notice tone="warn" title="No checkout-ready matches">
          Checkout Mode only shows results with an exact product match, a
          current verified price, confirmed availability and a direct product
          link. Nothing in the last scan met all four.
        </Notice>
        <Link href="/scan" className="btn-primary mt-4">
          Scan again
        </Link>
      </main>
    );
  }

  return (
    <main className="flex min-h-[92dvh] flex-col">
      {/*
        The one screen a cashier looks at, and until now the only screen
        showing prices without this. The home screen carried the warning
        instead, where no price is ever displayed — so the warning sat where
        it could not be needed and was absent where it could.
      */}
      <MockBanner
        visible={Boolean(result?.containsMockData)}
        dataMode={result?.dataMode}
        note="These figures came from test fixtures, not from a retailer. Do not show this screen to a cashier."
      />

      <div className="mb-4 flex items-center justify-between">
        <Link href="/scan" className="text-sm font-semibold text-brand">
          ← Exit
        </Link>
        <p className="text-sm font-bold text-muted">
          MATCH {index + 1} OF {matches.length}
        </p>
      </div>

      {current ? (
        <>
          <section className="flex-1">
            <h1 className="text-checkout uppercase leading-none">
              {current.canonical.brand}
            </h1>
            <p className="mt-1 text-2xl font-extrabold uppercase leading-tight">
              {current.canonical.name}
            </p>
            <p className="mt-1 text-xl font-bold uppercase text-muted">
              {[current.canonical.variant, current.canonical.size?.raw]
                .filter(Boolean)
                .join(" · ")}
            </p>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="rounded-2xl border-2 border-line p-4">
                <p className="text-sm font-bold uppercase text-muted">
                  {RETAILERS[current.currentStore.retailerId].displayName}
                </p>
                <p className="text-4xl font-extrabold">
                  <Money cents={current.currentStore.price} />
                </p>
              </div>
              <div className="rounded-2xl border-2 border-brand bg-brand/5 p-4">
                <p className="text-sm font-bold uppercase text-brand">
                  {RETAILERS[current.competitor.retailerId].displayName}
                </p>
                <p className="text-4xl font-extrabold text-brand">
                  <Money cents={current.competitor.price} />
                </p>
              </div>
            </div>

            <p className="mt-6 text-center text-5xl font-extrabold text-good">
              SAVE <Money cents={current.savingsCents} />
            </p>

            <p className="mt-4 text-center text-lg font-bold text-good">
              ✓ EXACT MATCH
            </p>
          </section>

          <div className="sticky bottom-0 space-y-2 bg-[#f6f7f9] pb-2 pt-3">
            <button
              type="button"
              className="btn-primary !min-h-[60px] text-lg"
              onClick={() => setProof(current)}
            >
              Show price proof
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary !min-h-[56px]"
                disabled={index === 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              >
                ← Previous
              </button>
              <button
                type="button"
                className="btn-secondary !min-h-[56px]"
                disabled={index >= matches.length - 1}
                onClick={() =>
                  setIndex((i) => Math.min(matches.length - 1, i + 1))
                }
              >
                Next →
              </button>
            </div>
          </div>
        </>
      ) : null}

      {proof ? (
        <ProofSheet opportunity={proof} onClose={() => setProof(null)} />
      ) : null}
    </main>
  );
}
