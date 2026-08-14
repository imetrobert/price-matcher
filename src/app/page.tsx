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

  useEffect(() => {
    setPrefs(loadPrefs());
    healthReport().then(setAdapters).catch(() => setAdapters(null));
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
        <Link href="/flyers" className="btn-secondary">
          Import a flyer
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
