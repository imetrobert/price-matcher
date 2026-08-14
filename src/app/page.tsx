"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AuthBar, AuthGuard } from "@/components/AuthGuard";
import { Notice } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { formatCents } from "@/lib/money";
import { DEFAULT_PREFS, loadPrefs, prefsAreComplete } from "@/lib/prefs";
import {
  loadAllFlyers,
  queueSummary,
  retryFailedPages,
} from "@/services/flyers/storage";
import { flyerStatus, type FlyerStatus } from "@/services/flyers/status";
import type { UserPreferences } from "@/types";

export default function HomePage() {
  return (
    <AuthGuard>
      <Home />
    </AuthGuard>
  );
}

function Home() {
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);
  const [flyers, setFlyers] = useState<FlyerStatus | null>(null);
  const [retrying, setRetrying] = useState(false);

  // While pages are still being read, the number on this card changes without
  // anybody touching the screen — a worker is doing the work on a schedule. A
  // card that only updates on reload would look stalled while it was in fact
  // progressing, which is the impression "Finish loading" gave.
  //
  // Polling stops once the queue is empty. A stalled run has nothing to
  // report every ten seconds, and a request that can only ever return the
  // same number is a request not worth making on a phone battery.
  useEffect(() => {
    if (flyers?.readiness !== "PARTIAL" || flyers.stalled) return;

    const refreshStatus = () =>
      Promise.all([loadAllFlyers(), queueSummary()])
        .then(([all, queue]) => setFlyers(flyerStatus(all, new Date(), queue)))
        .catch(() => undefined);

    const timer = setInterval(refreshStatus, 10_000);

    // Coming back to a backgrounded tab is the common case on a phone, and it
    // is exactly when the number on screen is most out of date — several
    // minutes of reading have happened since it was last painted, and mobile
    // browsers throttle or suspend timers in background tabs, so the interval
    // above cannot be relied on to have run. Refresh on return.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [flyers?.readiness, flyers?.stalled]);

  useEffect(() => {
    setPrefs(loadPrefs());
    // Derived from what is stored rather than from a run in progress: a run
    // lives in one browser tab, and the question "do I have this week's
    // prices" has to be answerable from anywhere, including tomorrow.
    Promise.all([loadAllFlyers(), queueSummary()])
      .then(([all, queue]) => setFlyers(flyerStatus(all, new Date(), queue)))
      .catch(() => setFlyers(null));
  }, []);

  const requeue = async () => {
    setRetrying(true);
    await retryFailedPages();
    const [all, queue] = await Promise.all([loadAllFlyers(), queueSummary()]);
    setFlyers(flyerStatus(all, new Date(), queue));
    setRetrying(false);
  };

  const ready = prefsAreComplete(prefs) && prefs.currentRetailerId !== null;
  const retailer = prefs.currentRetailerId
    ? RETAILERS[prefs.currentRetailerId]
    : null;

  return (
    <main>
      <AuthBar />

      <header className="mb-5 mt-2">
        <h1 className="text-3xl font-extrabold tracking-tight">CartMatch</h1>
        <p className="mt-1 text-muted">Find price matches before you pay.</p>
      </header>

      {/*
        The first thing on the screen, because it is the first thing somebody
        wants to know before leaving the house.
      */}
      {flyers ? (
        <section
          className={`card mb-4 border ${
            flyers.readiness === "LOADED"
              ? "border-good/40"
              : flyers.readiness === "PARTIAL"
                ? "border-warn/40"
                : "border-line"
          }`}
        >
          <p
            className={`flex items-center gap-2 font-bold ${
              flyers.readiness === "LOADED"
                ? "text-good"
                : flyers.readiness === "PARTIAL"
                  ? "text-warn"
                  : ""
            }`}
          >
            {/*
              Three states, three marks — because "is it working right now?"
              is answered at a glance or not at all.

                turning ring   pages are being read
                solid disc     queued, but blocked on something outside the
                               app: a quota that resets tomorrow, most often
                (nothing)      stopped, with nothing left in the queue

              The middle one used to spin like the first, which said the work
              was in progress when it was waiting out a daily limit — the
              difference between "a few more minutes" and "tomorrow morning".
            */}
            {flyers.readiness === "PARTIAL" && !flyers.stalled ? (
              flyers.waitingReason ? (
                <span
                  aria-hidden
                  className="h-4 w-4 shrink-0 rounded-full bg-warn"
                />
              ) : (
                <span
                  aria-hidden
                  className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-warn"
                />
              )
            ) : null}
            {flyers.headline}
          </p>
          <p className="mt-1 text-sm text-muted">{flyers.detail}</p>

          {flyers.readiness === "PARTIAL" ? (
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-line"
              role="progressbar"
              aria-valuenow={flyers.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-warn"
                style={{ width: `${flyers.percent}%` }}
              />
            </div>
          ) : null}

          {/*
            "Finish loading" asked the reader to do something already being
            done for them. Nothing here needs a person: the only reason to open
            the import screen mid-run is to add a flyer that was missed.
          */}
          {flyers.readiness === "PARTIAL" && flyers.stalled ? (
            <>
              <p className="mt-2 text-xs text-muted">
                {flyers.pagesFailed > 0
                  ? "Pages give up after five tries. If the reason has since been fixed — a model name changed, a quota reset — put them back in the queue."
                  : "Nothing is waiting to be read. Re-import the flyers that are short of pages."}
              </p>
              {flyers.pagesFailed > 0 ? (
                <button
                  type="button"
                  onClick={requeue}
                  disabled={retrying}
                  className="btn-primary mt-3 disabled:opacity-50"
                >
                  {retrying
                    ? "Queueing…"
                    : `Try the ${flyers.pagesFailed} failed ${flyers.pagesFailed === 1 ? "page" : "pages"} again`}
                </button>
              ) : null}
              <Link href="/flyers" className="btn-secondary mt-3">
                Add more flyers
              </Link>
            </>
          ) : flyers.readiness === "PARTIAL" ? (
            <>
              {/*
                A queued page that keeps being handed back — an exhausted
                daily quota does exactly this, correctly, since the page is
                fine and the key is not. Without saying so, "31%" reads as
                nearly there when the truth is tomorrow morning.
              */}
              {flyers.waitingReason ? (
                <p className="mt-2 rounded-md bg-warn/10 p-2 text-xs text-warn">
                  Waiting: {flyers.waitingReason}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-muted">
                Reading continues on its own — you can close this. The count
                updates every ten seconds, and again whenever you come back to
                this tab.
              </p>
              <Link href="/flyers" className="btn-secondary mt-3">
                Add more flyers
              </Link>
            </>
          ) : flyers.readiness === "NONE" ? (
            <Link href="/flyers" className="btn-primary mt-3">
              Upload this week&rsquo;s flyers
            </Link>
          ) : (
            <Link href="/deals" className="btn-secondary mt-3">
              See what is cheaper elsewhere
            </Link>
          )}
        </section>
      ) : null}

      <section className="card mb-4">
        <Row label="Current store" value={retailer?.displayName ?? "Not set"} />
        <Row label="Postal code" value={prefs.postalCode || "Not set"} />
        <Row
          label="Minimum savings"
          value={formatCents(prefs.minSavingsCents)}
        />
        <Link href="/setup" className="btn-secondary mt-3">
          {ready ? "Change settings" : "Set up"}
        </Link>
      </section>

      <div className="space-y-3">
        <Link
          href="/scan"
          className={ready ? "btn-primary" : "btn-primary pointer-events-none opacity-40"}
          aria-disabled={!ready}
        >
          Scan cart
        </Link>
        <Link href="/deals" className="btn-secondary">
          Cheaper elsewhere this week
        </Link>
        <Link href="/flyers" className="btn-secondary">
          Import this week&rsquo;s flyers
        </Link>
      </div>

      {!ready ? (
        <div className="mt-4">
          <Notice tone="warn" title="Finish setup first">
            Add your postal code and choose the store you are shopping at.
          </Notice>
        </div>
      ) : null}

      {/*
        The adapter health list lived here: six retailers, all reporting
        MOCK_ONLY, on the screen somebody opens to ask whether this week's
        flyers are loaded. It answered a question nobody was asking and
        crowded out the one they were.

        Prices in this app now come from flyers a person uploaded, and their
        status is the card at the top. Adapter health is a debugging concern,
        so it lives where debugging lives.
      */}
      <Link href="/admin" className="btn-ghost mt-6">
        Developer / debug view
      </Link>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-sm text-muted">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}
