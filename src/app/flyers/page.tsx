"use client";

/**
 * Import a week's flyers.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS
 * ---------------------------------------------------------------------------
 * Five retailers were asked, from a server, for their weekly flyer. Maxi and
 * IGA refused at the Akamai edge; Walmart, Super C and Metro answered but keep
 * the pages out of the HTML — superc.ca returns 227 KB containing exactly one
 * image, its own logo. There is no supply line to automate.
 *
 * The flyer PDFs themselves are a different story: they sit on plain blob
 * storage. But their URLs carry an unpredictable version suffix, so the
 * reliable weekly act is a person downloading five files and dropping them
 * here.
 *
 * ---------------------------------------------------------------------------
 * ONE ACTION, THEN WALK AWAY
 * ---------------------------------------------------------------------------
 * The work takes upwards of half an hour, nearly all of it spent waiting out
 * an API quota. That is machine work. So the only thing asked of a person is
 * the upload; everything after it is queued, paced and reported.
 *
 * The files never leave the device. Rendering is local; only page images go to
 * Gemini, one at a time, to be read.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AuthGuard } from "@/components/AuthGuard";
import { Notice, PageHeader } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { formatCents } from "@/lib/money";
import {
  batchTotals,
  countBatchPages,
  newBatchItem,
  runBatch,
  saveLater,
  type BatchItem,
} from "@/services/flyers/batch";
import {
  deleteFlyer,
  flyerContents,
  loadAllFlyers,
  type StoredFlyer,
  measureStoredPages,
  purgeExpiredPages,
  type StorageUsage,
} from "@/services/flyers/storage";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "@/lib/prefs";
import { describeBasis } from "@/types/flyer";
import type { RetailerId } from "@/types";

export default function FlyersPage() {
  return (
    <AuthGuard>
      <FlyerImport />
    </AuthGuard>
  );
}

function FlyerImport() {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [keepPages, setKeepPages] = useState(DEFAULT_PREFS.keepFlyerPages);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [held, setHeld] = useState<StoredFlyer[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Purge on arrival, then measure.
   *
   * The purge has to happen somewhere, and Postgres cannot reach object
   * storage. Here is the honest place: the only screen that creates these
   * files, visited about once a week, which is exactly the cadence the
   * retention rule needs. A page image kept forever is how twenty megabytes a
   * week quietly becomes a gigabyte a year.
   */
  useEffect(() => {
    const prefs = loadPrefs();
    setKeepPages(prefs.keepFlyerPages);
    void purgeExpiredPages()
      .then(() => measureStoredPages())
      .then(setUsage)
      .catch(() => setUsage(null));
    void loadAllFlyers().then(setHeld).catch(() => setHeld(null));
  }, []);

  const onFiles = useCallback((files: FileList) => {
    abortRef.current?.abort();
    setItems([...files].map((file, i) => newBatchItem(file, i)));
    setFinishedAt(null);
    setStartedAt(null);
  }, []);

  const start = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setStartedAt(Date.now());
    setFinishedAt(null);

    // Count first. Without a page total the bar can only count files, and "2 of
    // 5 flyers" moves once every eight minutes — not something a person can
    // read a decision off. Counting costs a fraction of a second per file.
    const counted = await countBatchPages(items, (updated) =>
      setItems((prev) =>
        prev.map((it) => (it.id === updated.id ? updated : it)),
      ),
    );
    setItems(counted);

    // Each item reports its own progress, so the list updates in place rather
    // than only at the end of a half-hour run.
    const done = await runBatch(counted, {
      signal: controller.signal,
      keepPages,
      replaceExisting,
      onUpdate: (updated) =>
        setItems((prev) =>
          prev.map((it) => (it.id === updated.id ? updated : it)),
        ),
    });

    setItems(done);
    setRunning(false);
    setFinishedAt(Date.now());
    void measureStoredPages().then(setUsage).catch(() => undefined);
  }, [items, keepPages]);

  const totals = useMemo(() => batchTotals(items), [items]);

  // Re-rendered on every item update, which is every few seconds while a page
  // is read — often enough for a clock without a timer of its own.
  const remaining = useMemo(() => {
    if (!running || startedAt === null) return null;
    if (totals.pagesRead < 2 || totals.pagesTotal === 0) return null;
    const perPage = (Date.now() - startedAt) / totals.pagesRead;
    const left = Math.max(0, totals.pagesTotal - totals.pagesRead);
    return Math.ceil((perPage * left) / 60000);
  }, [running, startedAt, totals.pagesRead, totals.pagesTotal]);
  const elapsedMin =
    startedAt === null || finishedAt === null
      ? null
      : Math.max(1, Math.round((finishedAt - startedAt) / 60000));

  return (
    <main className="mx-auto max-w-[900px]">
      <PageHeader
        title="Import this week's flyers"
        subtitle="Drop them all in. Uploading takes a couple of minutes, then you can close the tab — the reading finishes on its own."
        backHref="/"
      />

      <HeldFlyers
        flyers={held}
        onRemoved={() => {
          void loadAllFlyers().then(setHeld).catch(() => undefined);
          void measureStoredPages().then(setUsage).catch(() => undefined);
        }}
      />

      <section className="card mb-4">
        <label className="mb-1 block text-sm font-semibold" htmlFor="pdfs">
          Flyer PDFs
        </label>
        <input
          id="pdfs"
          type="file"
          accept="application/pdf,.pdf"
          multiple
          disabled={running}
          className="field w-full"
          onChange={(e) => {
            if (e.target.files?.length) onFiles(e.target.files);
          }}
        />
        <p className="mt-2 text-xs text-muted">
          Select all of them together. The files stay on this device — only the
          rendered pages are sent, one at a time, to be read.
        </p>

        {/*
          Handing over the same file twice is usually not noticing it was
          already done, and doing it anyway spends the day's allowance to
          arrive back where you started. So a store and week already held in
          full is skipped, and this is how somebody says they mean it.

          It has to exist: re-importing is how a bad reading gets fixed. A
          flyer read from the wrong PDF, or read badly, is corrected by handing
          over the right file and ticking this.
        */}
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={replaceExisting}
            disabled={running}
            onChange={(e) => setReplaceExisting(e.target.checked)}
          />
          <span>
            <span className="font-semibold">Read again if already loaded</span>
            <span className="block text-xs text-muted">
              Off by default: a store and week already read in full is skipped
              rather than read twice. Tick this to replace one — correcting a
              flyer that was read from the wrong PDF, for instance.
            </span>
          </span>
        </label>

        {/*
          The one setting in this app that costs money if it is wrong, so it is
          here with the numbers beside it rather than buried in preferences.
        */}
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={keepPages}
            disabled={running}
            onChange={(e) => {
              setKeepPages(e.target.checked);
              savePrefs({ ...loadPrefs(), keepFlyerPages: e.target.checked });
            }}
          />
          <span>
            <span className="font-semibold">Keep a picture of each page</span>
            <span className="block text-xs text-muted">
              The strongest thing to show a cashier, and the only part of this
              app that uses storage. Roughly 20 MB a week, deleted three days
              after each flyer expires. Turn it off and offers still record
              their page number — you would show the flyer from your own copy.
            </span>
          </span>
        </label>

        {usage ? (
          <p className="mt-2 text-xs text-muted">
            Using {(usage.bytes / 1024 / 1024).toFixed(1)} MB across{" "}
            {usage.files} page{usage.files === 1 ? "" : "s"} —{" "}
            {usage.percentOfFreeTier}% of the 1 GB free allowance. Expired pages
            were cleared when this screen opened.
          </p>
        ) : null}

        {items.length > 0 && !running ? (
          <button
            type="button"
            className="btn-primary mt-3"
            onClick={() => void start()}
          >
            {finishedAt
              ? "Upload them again"
              : `Upload ${items.length} flyer${items.length === 1 ? "" : "s"}`}
          </button>
        ) : null}

        {running ? (
          <button
            type="button"
            className="btn-secondary mt-3"
            onClick={() => abortRef.current?.abort()}
          >
            Stop
          </button>
        ) : null}
      </section>

      {running ? (
        <section className="card mb-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <p className="font-bold">
              {totals.percent}% — page {totals.pagesRead} of {totals.pagesTotal || "…"}
            </p>
            <p className="text-sm text-muted">
              {/*
                Measured from this run's own pace rather than from a constant.
                The rate changes with the quota, so a fixed estimate would be
                wrong in exactly the runs where someone is watching it.
              */}
              {remaining === null
                ? "estimating…"
                : remaining <= 1
                  ? "under a minute left"
                  : `about ${remaining} min left`}
            </p>
          </div>
          <div
            className="h-3 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-valuenow={totals.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-good transition-[width] duration-500"
              style={{ width: `${totals.percent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            Each cover is read here to find the store and the dates, then the
            pages are uploaded. Once the uploads finish you can close the tab —
            the reading happens on the server.
          </p>
        </section>
      ) : null}

      {items.length > 0 ? (
        <section className="mb-4">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">
            Flyers ({items.length})
          </h2>
          <div className="space-y-3">
            {items.map((item) => (
              <FlyerRow
                key={item.id}
                item={item}
                locked={running}
                expanded={expanded === item.id}
                onToggle={() =>
                  setExpanded(expanded === item.id ? null : item.id)
                }
                onRetailer={(retailerId) =>
                  setItems((prev) =>
                    prev.map((it) =>
                      it.id === item.id
                        ? { ...it, retailerId, retailerFrom: "CHOSEN" as const }
                        : it,
                    ),
                  )
                }
                onDates={(validFrom, validTo) =>
                  setItems((prev) =>
                    prev.map((it) =>
                      it.id === item.id
                        ? // MANUAL, not COVER. Dates typed in by a person are
                          // not dates read off the flyer, and labelling them
                          // "from cover" told the reader the app had verified
                          // something nobody had — on a run where no page was
                          // read at all.
                          { ...it, validFrom, validTo, validityFrom: "MANUAL" as const }
                        : it,
                    ),
                  )
                }
                onSave={async () => {
                  const outcome = await saveLater(item);
                  setItems((prev) =>
                    prev.map((it) =>
                      it.id === item.id
                        ? outcome.ok
                          ? {
                              ...it,
                              saved: { offers: outcome.offers, pages: 0 },
                              saveError: null,
                              detail: `${outcome.offers} offers saved`,
                            }
                          : { ...it, saveError: outcome.error }
                        : it,
                    ),
                  );
                  void measureStoredPages().then(setUsage).catch(() => undefined);
                  void loadAllFlyers().then(setHeld).catch(() => undefined);
                }}
              />
            ))}
          </div>
        </section>
      ) : null}

      {finishedAt ? (
        <section className="card mb-4 text-sm">
          <p
            className={`mb-1 text-lg font-bold ${
              totals.flyersIncomplete + totals.flyersFailed === 0 && totals.offers > 0
                ? "text-good"
                : "text-warn"
            }`}
          >
            {totals.offers === 0
              ? "Finished, but nothing was read"
              : totals.flyersIncomplete + totals.flyersFailed === 0
                ? "Done — every flyer read in full"
                : "Finished, with gaps"}
          </p>
          <p className="mb-2 font-bold">
            {totals.offers} offers from{" "}
            {totals.flyersDone + totals.flyersIncomplete} flyer
            {totals.flyersDone + totals.flyersIncomplete === 1 ? "" : "s"},{" "}
            {totals.pagesRead} of {totals.pagesTotal} pages
          </p>
          <Row
            label="Time taken"
            value={elapsedMin === null ? "—" : `${elapsedMin} min`}
          />
          <Row label="Complete" value={String(totals.flyersDone)} />
          {totals.flyersIncomplete > 0 ? (
            <Row label="Incomplete" value={String(totals.flyersIncomplete)} />
          ) : null}
          {totals.flyersFailed > 0 ? (
            <Row label="Failed" value={String(totals.flyersFailed)} />
          ) : null}
        </section>
      ) : null}

      {/*
        Two conditions worth interrupting for, because both make the data wrong
        rather than merely thin: a flyer filed under no retailer cannot be
        compared against anything, and a flyer read only in part looks complete.
      */}
      {finishedAt && totals.needsRetailer > 0 ? (
        <div className="mb-4">
          <Notice tone="warn" title="Some flyers have no store set">
            {totals.needsRetailer} could not be matched to a retailer from the
            filename or the logo on page 1. Set the store on each, otherwise
            their prices cannot be compared against anything.
          </Notice>
        </div>
      ) : null}

      {finishedAt && items.some((i) => i.result?.stoppedReason === "RATE_LIMITED") ? (
        <div className="mb-4">
          <Notice tone="error" title="The API key ran out of quota">
            The run stopped there — the remaining flyers were not started,
            because a quota belongs to the key rather than to a flyer and they
            would all have failed the same way. The row says whether it was the
            per-minute or the per-day limit. Note that Gemini&rsquo;s free
            quota is per Google project, so a second key in the same project
            shares the same allowance.
          </Notice>
        </div>
      ) : null}

      {finishedAt && totals.notSaved > 0 ? (
        <div className="mb-4">
          <Notice tone="error" title="Some flyers were not saved">
            {totals.notSaved} of these were read but not stored, so their
            prices will be gone when this page closes. Each row says why —
            usually a missing store or missing dates. Fix those and read again.
          </Notice>
        </div>
      ) : null}

      {finishedAt && totals.needsDates > 0 ? (
        <div className="mb-4">
          <Notice tone="warn" title="Some flyers have no dates">
            {totals.needsDates} of these printed no run dates the app could
            read, and an offer with no end date cannot be shown to a cashier —
            &ldquo;still valid?&rdquo; is the first thing asked at the till. Set
            them by hand, or re-read the flyer so page 1 is seen.
          </Notice>
        </div>
      ) : null}

      {finishedAt && totals.flyersIncomplete > 0 ? (
        <div className="mb-4">
          <Notice tone="warn" title="Some flyers were only partly read">
            The pages that were never opened are listed on each flyer above.
            Anything advertised on them is missing rather than absent. Reading
            again picks up what a quota cut off.
          </Notice>
        </div>
      ) : null}

      {finishedAt ? (
        <>
          <div className="mb-4">
            <Notice tone="info" title="You can close this tab now">
              The pages are uploaded and queued. A scheduled job reads a few
              every minute — a five-flyer week takes roughly half an hour, and a
              quota that runs out simply resumes when it resets. Watch the home
              screen for progress. Nothing reaches a cashier until you have
              confirmed it against the page.
            </Notice>
          </div>
          <Link href="/" className="btn-secondary">
            Done
          </Link>
        </>
      ) : null}
    </main>
  );
}

function FlyerRow({
  item,
  locked,
  expanded,
  onToggle,
  onRetailer,
  onDates,
  onSave,
}: {
  item: BatchItem;
  locked: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRetailer: (id: RetailerId) => void;
  onDates: (from: string, to: string) => void;
  onSave: () => void | Promise<void>;
}) {
  const busy = item.stage === "RENDERING" || item.stage === "READING";
  const border =
    item.stage === "FAILED"
      ? "border-bad/40"
      : item.stage === "DONE"
        ? "border-good/40"
        : "border-line";
  // Skipped is neither success nor failure: nothing went wrong and nothing was
  // done. A tick would claim work that did not happen.
  const mark =
    item.stage === "DONE"
      ? "✓ "
      : item.stage === "FAILED"
        ? "✕ "
        : item.stage === "SKIPPED"
          ? "— "
          : "";

  return (
    <div className={`card border ${border}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{item.file.name}</p>
          <p className="mt-1 text-xs text-muted">
            {busy ? "… " : mark}
            {item.detail}
          </p>
        </div>
        {item.result && item.result.offers.length > 0 ? (
          <button
            type="button"
            onClick={onToggle}
            className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs font-semibold"
          >
            {expanded ? "Hide" : "Show"}
          </button>
        ) : null}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <label className="text-xs text-muted" htmlFor={`retailer-${item.id}`}>
          Store
        </label>
        <select
          id={`retailer-${item.id}`}
          disabled={locked}
          className="field flex-1 py-1 text-sm"
          value={item.retailerId ?? ""}
          onChange={(e) => onRetailer(e.target.value as RetailerId)}
        >
          <option value="" disabled>
            Not set
          </option>
          {Object.values(RETAILERS).map((r) => (
            <option key={r.id} value={r.id}>
              {r.displayName}
            </option>
          ))}
        </select>
        <span className="shrink-0 text-xs text-muted">
          {item.retailerFrom === "FILENAME"
            ? "from filename"
            : item.retailerFrom === "LOGO"
              ? "from page 1"
              : item.retailerFrom === "CHOSEN"
                ? "you chose"
                : "unknown"}
        </span>
      </div>

      <p className="mt-2 text-xs">
        {item.validFrom && item.validTo ? (
          <>
            <span className="font-semibold">
              Valid {formatDay(item.validFrom)} – {formatDay(item.validTo)}
            </span>
            <span className="text-muted">
              {" "}
              (
              {item.validityFrom === "FILENAME"
                ? "from filename"
                : item.validityFrom === "MANUAL"
                  ? "you set these"
                  : "from cover"}
              )
            </span>
          </>
        ) : item.stage === "DONE" ? (
          <span className="text-warn">
            No run dates found — offers from this flyer cannot back a checkout
            claim until dates are set
          </span>
        ) : null}
      </p>

      {/*
        Everything needed to rescue a flyer the run could not store, without
        reading it again. The offers are still here; only a store name or a
        pair of dates was missing, and asking somebody to spend another half
        hour and another quota on that would be absurd.
      */}
      {item.stage === "DONE" && !item.saved && item.result ? (
        <div className="mt-2 rounded-xl border border-line p-2">
          <p className="mb-2 text-xs font-semibold">
            {item.result.offers.length} offers are read and waiting. Fill in
            what is missing and save — no need to read the flyer again.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-muted" htmlFor={`from-${item.id}`}>
              Valid from
            </label>
            <input
              id={`from-${item.id}`}
              type="date"
              className="field py-1 text-sm"
              value={item.validFrom ?? ""}
              onChange={(e) => onDates(e.target.value, item.validTo ?? "")}
            />
            <label className="text-xs text-muted" htmlFor={`to-${item.id}`}>
              to
            </label>
            <input
              id={`to-${item.id}`}
              type="date"
              className="field py-1 text-sm"
              value={item.validTo ?? ""}
              onChange={(e) => onDates(item.validFrom ?? "", e.target.value)}
            />
          </div>
          <button
            type="button"
            disabled={
              locked || !item.retailerId || !item.validFrom || !item.validTo
            }
            onClick={() => void onSave()}
            className="btn-secondary mt-2 disabled:opacity-50"
          >
            Save these offers
          </button>
          <p className="mt-1 text-xs text-muted">
            The page pictures were released when the flyer finished, so this
            saves the prices and their page numbers. Reading again is what
            recovers the pictures.
          </p>
        </div>
      ) : null}

      {item.saved ? (
        <p className="mt-1 text-xs text-good">
          Saved — {item.saved.offers} offers
          {item.saved.pages > 0
            ? `, ${item.saved.pages} pages kept for the till`
            : " (page numbers only, no pictures kept)"}
        </p>
      ) : item.saveError ? (
        <p className="mt-1 text-xs text-bad">{item.saveError}</p>
      ) : null}

      {/*
        Tiles the model reported and the parser refused. Invisible until now,
        which meant a flyer yielding a fifth of its usual offers looked like a
        thin week rather than a rule quietly discarding most of it.
      */}
      {/*
        Per page, what the model returned against what survived. A row of
        zeroes says the model reported nothing; a row where returned far
        exceeds kept says the parser is eating them. The offer count alone
        cannot tell those apart, and they need opposite fixes.
      */}
      {item.stage === "DONE" && item.result && item.result.pageYield.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted">
            Per-page yield — tap to see which pages came back empty
          </summary>
          <p className="mt-1 break-all text-xs text-muted">
            {item.result.pageYield
              .map((y) =>
                y.returned === y.kept
                  ? `p${y.page}:${y.kept}`
                  : `p${y.page}:${y.kept}/${y.returned}`,
              )
              .join("  ")}
          </p>
          <p className="mt-1 text-xs text-muted">
            Shown as page:kept, or page:kept/returned where the two differ.
          </p>
        </details>
      ) : null}

      {item.result && item.result.rejected.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-warn">
            {item.result.rejected.length} tile
            {item.result.rejected.length === 1 ? "" : "s"} read but discarded —
            tap to see why
          </summary>
          <div className="mt-1 space-y-1 text-xs text-muted">
            {item.result.rejected.slice(0, 12).map((reason, i) => (
              <p key={i}>{reason}</p>
            ))}
            {item.result.rejected.length > 12 ? (
              <p>…and {item.result.rejected.length - 12} more.</p>
            ) : null}
          </div>
        </details>
      ) : null}

      {item.result && item.result.failedPages.length > 0 ? (
        <p className="mt-2 rounded-lg bg-bad/5 px-2 py-1 text-xs text-bad">
          {item.result.failedPages.length} page
          {item.result.failedPages.length === 1 ? "" : "s"} refused:{" "}
          {item.result.failedPages[0]!.error}
        </p>
      ) : null}

      {item.result && item.result.notAttempted.length > 0 ? (
        <p className="mt-2 rounded-lg bg-warn/5 px-2 py-1 text-xs text-warn">
          Pages never read: {item.result.notAttempted.join(", ")}
        </p>
      ) : null}

      {expanded && item.result ? (
        <div className="mt-3 space-y-2 border-t border-line pt-2 text-sm">
          {item.result.offers.slice(0, 40).map((offer, i) => (
            <p key={i} className="border-b border-line pb-1 last:border-0">
              <span className="font-bold">{formatCents(offer.price)}</span>{" "}
              <span className="text-muted">{describeBasis(offer.basis)}</span> —{" "}
              {offer.advertisedText}
              <span className="block text-xs text-muted">
                p.{offer.pageNumber}
                {offer.retailerSku ? ` · N° ${offer.retailerSku}` : ""}
                {offer.regularPrice
                  ? ` · reg. ${formatCents(offer.regularPrice)}${
                      offer.regularBasis && offer.regularBasis !== offer.basis
                        ? ` ${describeBasis(offer.regularBasis)}`
                        : ""
                    }`
                  : ""}
                {offer.condition !== "UNIT_PRICE"
                  ? ` · ${offer.conditionText ?? offer.condition}`
                  : ""}
              </span>
            </p>
          ))}
          {item.result.offers.length > 40 ? (
            <p className="text-xs text-muted">
              …and {item.result.offers.length - 40} more.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A date as a shopper reads it, not as a database stores it.
 *
 * Deliberately parsed as UTC noon. "2026-08-13" parsed as local midnight lands
 * on the 12th west of Greenwich, and a flyer shown as expiring a day early is
 * a flyer nobody takes to the till.
 */
function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex justify-between gap-3 border-b border-line py-1 last:border-0">
      <span className="text-muted">{label}</span>
      <span className="text-right font-semibold">{value}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// WHAT IS ALREADY HELD
// ---------------------------------------------------------------------------
//
// This screen used to be write-only: a file picker with no idea what it had
// already been given. So the two questions somebody actually arrives with —
// which shops have I done, and is any of this still good — could only be
// answered by going back to the home card, and the second one not at all.
//
// Both are answered against today's date, printed here rather than assumed,
// because the whole judgement is relative to it and a flyer expires while
// nobody is looking.

/** A date as a shopper reads it. Noon UTC so it never slips back a day. */
function readableDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function HeldFlyers({
  flyers,
  onRemoved,
}: {
  flyers: StoredFlyer[] | null;
  onRemoved: () => void;
}) {
  const today = todayIso();

  if (flyers === null) return null;

  const current = flyers
    .filter((f) => f.validFrom <= today && today <= f.validTo)
    .sort((a, b) => a.retailerId.localeCompare(b.retailerId));

  // Only recent history. A flyer from six weeks ago is not a prompt to do
  // anything; last week's is, because it is what somebody would otherwise
  // mistake for this week's.
  const expired = flyers
    .filter((f) => f.validTo < today)
    .sort((a, b) => b.validTo.localeCompare(a.validTo))
    .slice(0, 4);

  const upcoming = flyers.filter((f) => f.validFrom > today);

  return (
    <section className="card mb-4">
      <p className="font-bold">Flyers you already hold</p>
      <p className="mt-1 text-xs text-muted">Today is {readableDay(today)}.</p>

      {current.length === 0 ? (
        <p className="mt-3 rounded-md bg-warn/10 p-2 text-sm text-warn">
          {expired.length > 0
            ? `Nothing covers today. The newest you hold ran to ${readableDay(expired[0]!.validTo)} — those prices have expired and this week's need uploading.`
            : "Nothing has been loaded yet."}
        </p>
      ) : (
        <div className="mt-3 space-y-1">
          {current.map((f) => (
            <HeldFlyerRow key={f.id} flyer={f} today={today} onRemoved={onRemoved} />
          ))}
        </div>
      )}

      {upcoming.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Starts later
          </p>
          {upcoming.map((f) => (
            <HeldFlyerRow key={f.id} flyer={f} today={today} onRemoved={onRemoved} />
          ))}
        </div>
      ) : null}

      {expired.length > 0 && current.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted">
            {expired.length} expired flyer{expired.length === 1 ? "" : "s"} still
            stored
          </summary>
          <div className="mt-1 space-y-1">
            {expired.map((f) => (
              <HeldFlyerRow key={f.id} flyer={f} today={today} onRemoved={onRemoved} />
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">
            Their offers are no longer compared. Page pictures are deleted three
            days after a flyer expires.
          </p>
        </details>
      ) : null}
    </section>
  );
}

function HeldFlyerRow({
  flyer,
  today,
  onRemoved,
}: {
  flyer: StoredFlyer;
  today: string;
  onRemoved: () => void;
}) {
  const live = flyer.validFrom <= today && today <= flyer.validTo;
  const complete = flyer.pagesRead >= flyer.pageCount;

  // Two taps, and the second one says what it is about to destroy.
  //
  // Not every PDF a store publishes is a price list — a recipe booklet, a
  // pharmacy insert, last week's file picked by mistake. Each imports happily
  // and then feeds comparisons, because nothing downstream can tell the prices
  // came from the wrong document. So removing one has to be possible.
  //
  // It also cannot be undone: the offers go, the pictures go, and getting them
  // back means importing the PDF again. Hence the count in the confirmation —
  // "delete Metro" and "delete 7 pages and 84 offers" are different decisions,
  // and only the second can be made knowingly.
  const [confirming, setConfirming] = useState(false);
  const [contents, setContents] = useState<{ pages: number; offers: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    setConfirming(true);
    setContents(await flyerContents(flyer.id));
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const result = await deleteFlyer(flyer.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onRemoved();
  };

  return (
    <div className="border-b border-line py-1 last:border-0">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-semibold">
          {RETAILERS[flyer.retailerId]?.displayName ?? flyer.retailerId}
        </span>
        <span className={live ? "text-xs text-muted" : "text-xs text-muted line-through"}>
          {readableDay(flyer.validFrom)} – {readableDay(flyer.validTo)}
        </span>
        {/*
          Pages read against pages held, because a flyer can be current and
          still be missing most of its offers — and on this screen that is
          actionable: it is the one place a re-import happens.
        */}
        <span className={complete ? "text-xs text-good" : "text-xs text-warn"}>
          {complete
            ? `all ${flyer.pageCount} pages`
            : `${flyer.pagesRead} of ${flyer.pageCount} pages`}
        </span>
        <button
          type="button"
          onClick={() => (confirming ? setConfirming(false) : void ask())}
          className="shrink-0 px-2 text-sm font-bold text-muted"
          aria-label={`Remove the ${RETAILERS[flyer.retailerId]?.displayName ?? flyer.retailerId} flyer`}
        >
          {confirming ? "Cancel" : "\u00d7"}
        </button>
      </p>

      {confirming ? (
        <div className="mt-1 rounded-md bg-warn/10 p-2 text-xs">
          <p className="text-warn">
            Remove this flyer and everything read from it
            {contents
              ? ` — ${contents.offers} offer${contents.offers === 1 ? "" : "s"} and ${contents.pages} page${contents.pages === 1 ? "" : "s"}`
              : ""}
            ? It cannot be undone; importing the PDF again is the only way back.
          </p>
          {error ? <p className="mt-1 text-bad">{error}</p> : null}
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="btn-secondary mt-2 disabled:opacity-50"
          >
            {busy ? "Removing…" : "Yes, remove it"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
