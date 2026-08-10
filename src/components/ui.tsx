"use client";

import Link from "next/link";

import { formatCents } from "@/lib/money";
import type { Cents, DataMode } from "@/types";

export function PageHeader({
  title,
  subtitle,
  backHref,
}: {
  title: string;
  subtitle?: string;
  backHref?: string;
}) {
  return (
    <header className="mb-4">
      {backHref ? (
        <Link
          href={backHref}
          className="mb-2 inline-block text-sm font-semibold text-brand"
        >
          ← Back
        </Link>
      ) : null}
      <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
      {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
    </header>
  );
}

/**
 * Persistent, unmissable banner whenever any figure on screen came from
 * fixtures. This is the single most important piece of UI in the app for not
 * misleading someone standing at a till.
 */
export function MockBanner({
  dataMode,
  visible,
  note,
}: {
  dataMode?: DataMode;
  visible: boolean;
  note?: string;
}) {
  if (!visible) return null;
  return (
    <div className="mb-4 rounded-2xl border-2 border-mock/40 bg-mock/5 p-3">
      <p className="text-sm font-extrabold uppercase tracking-wide text-mock">
        Mock data — not real prices
      </p>
      <p className="mt-1 text-sm text-mock/90">
        {note ??
          "These figures come from local test fixtures and were never observed at a retailer. They cannot be used at checkout."}
        {dataMode ? ` (CARTMATCH_DATA_MODE=${dataMode})` : ""}
      </p>
    </div>
  );
}

export function Money({
  cents,
  className = "",
}: {
  cents: Cents;
  className?: string;
}) {
  return <span className={className}>{formatCents(cents)}</span>;
}

export function Check({ passed }: { passed: boolean }) {
  return (
    <span
      aria-hidden
      className={passed ? "font-bold text-good" : "font-bold text-bad"}
    >
      {passed ? "✓" : "✕"}
    </span>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "error";
  title: string;
  children?: React.ReactNode;
}) {
  const toneClass =
    tone === "error"
      ? "border-bad/30 bg-bad/5 text-bad"
      : tone === "warn"
        ? "border-warn/30 bg-warn/5 text-warn"
        : "border-line bg-surface text-muted";
  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <p className="text-sm font-bold">{title}</p>
      {children ? <div className="mt-1 text-sm">{children}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-brand" />
      {label}
    </div>
  );
}
