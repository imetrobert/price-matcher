"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AuthBar, AuthGuard } from "@/components/AuthGuard";
import { MockBanner, Notice } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { env, visionProviderName } from "@/config/env";
import { formatCents } from "@/lib/money";
import { healthReport } from "@/services/retailers/registry";
import { DEFAULT_PREFS, loadPrefs, prefsAreComplete } from "@/lib/prefs";
import { loadAllFlyers } from "@/services/flyers/storage";
import { flyerStatus, type FlyerStatus } from "@/services/flyers/status";
import type { AdapterHealth, UserPreferences } from "@/types";

export default function HomePage() {
  return (
    <AuthGuard>
      <Home />
    </AuthGuard>
  );
}

function Home() {
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);
  const [adapters, setAdapters] = useState<AdapterHealth[] | null>(null);
  const [flyers, setFlyers] = useState<FlyerStatus | null>(null);

  // While pages are still being read, the number on this card changes without
  // anybody touching the screen — a worker is doing the work on a schedule. A
  // card that only updates on reload would look stalled while it was in fact
  // progressing, which is the impression "Finish loading" gave.
  useEffect(() => {
    if (flyers?.readiness !== "PARTIAL") return;

    const refreshStatus = () =>
      loadAllFlyers()
        .then((all) => setFlyers(flyerStatus(all)))
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
  }, [flyers?.readiness]);

  useEffect(() => {
    setPrefs(loadPrefs());
    healthReport().then(setAdapters).catch(() => setAdapters(null));
    // Derived from what is stored rather than from a run in progress: a run
    // lives in one browser tab, and the question "do I have this week's
    // prices" has to be answerable from anywhere, including tomorrow.
    loadAllFlyers()
      .then((all) => setFlyers(flyerStatus(all)))
      .catch(() => setFlyers(null));
  }, []);

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
            {flyers.readiness === "PARTIAL" ? (
              // Turning, because it IS turning. The work continues on a
              // schedule whether or not this screen is open, and a still card
              // reads as a stalled one.
              <span
                aria-hidden
                className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-warn"
              />
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
          {flyers.readiness === "PARTIAL" ? (
            <>
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

      <MockBanner
        visible={env.dataMode === "MOCK"}
        dataMode={env.dataMode}
        note="Running on test fixtures. Prices shown anywhere in the app are invented and must not be shown to a cashier."
      />

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
        <Link href="/test" className="btn-secondary">
          Manual product test
        </Link>
      </div>

      {!ready ? (
        <div className="mt-4">
          <Notice tone="warn" title="Finish setup first">
            Add your postal code and choose the store you are shopping at.
          </Notice>
        </div>
      ) : null}

      {adapters ? (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">
            Service status
          </h2>
          <div className="card space-y-2 text-sm">
            <Row label="Data mode" value={env.dataMode} />
            <Row label="Photo recognition" value={visionProviderName()} />
            <div className="border-t border-line pt-2">
              {adapters.map((a) => (
                <p key={a.retailerId} className="mb-1 leading-snug">
                  <span className="font-semibold">
                    {RETAILERS[a.retailerId]?.displayName ?? a.retailerId}
                  </span>{" "}
                  <span
                    className={
                      a.status === "AVAILABLE"
                        ? "pill-good"
                        : a.status === "MOCK_ONLY"
                          ? "pill-mock"
                          : "pill-bad"
                    }
                  >
                    {a.status}
                  </span>
                  <span className="block text-xs text-muted">{a.reason}</span>
                </p>
              ))}
            </div>
          </div>
          <Link href="/admin" className="btn-ghost mt-2">
            Developer / debug view
          </Link>
        </section>
      ) : null}
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
