"use client";

/**
 * Import a weekly flyer from a PDF.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS
 * ---------------------------------------------------------------------------
 * Five retailers were asked, from a server, for their weekly flyer. Maxi and
 * IGA refused at the Akamai edge; Walmart, Super C and Metro answered but keep
 * the pages out of the HTML — superc.ca returns 227 KB containing exactly one
 * image, its own logo. There is no supply line to automate.
 *
 * A flyer the shopper already has is the remaining route, and it is the better
 * artefact anyway: a price-match desk asks for the competitor's ADVERTISED
 * price, printed, with dates. That is what a flyer page is.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN DOES, AND DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * It renders the PDF and shows what came out. Nothing is read, nothing is
 * saved, nothing is compared. That is the point: before any of it is trusted,
 * the input has to be seen working on real flyers, on the phone that will
 * actually do it.
 *
 * The file never leaves the device here. Rendering is local, and no page image
 * is uploaded anywhere by this screen.
 */

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

import { AuthGuard } from "@/components/AuthGuard";
import { Notice, PageHeader, Spinner } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import {
  readFlyerPages,
  type ReadFlyerProgress,
  type ReadFlyerResult,
} from "@/services/flyers/pdf/readPage";
import { verifyExtraction } from "@/services/flyers/pdf/verify";
import { describeBasis, describeCondition } from "@/types/flyer";
import { formatCents } from "@/lib/money";
import {
  describeTextCoverage,
  renderFlyerPdf,
  type RenderProgress,
  type RenderedFlyerPage,
} from "@/services/flyers/pdf/renderPages";
import type { RetailerId } from "@/types";

export default function FlyersPage() {
  return (
    <AuthGuard>
      <FlyerImport />
    </AuthGuard>
  );
}

function FlyerImport() {
  const [retailerId, setRetailerId] = useState<RetailerId>("iga");
  const [fileName, setFileName] = useState<string | null>(null);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [pages, setPages] = useState<RenderedFlyerPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<RenderedFlyerPage | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [reading, setReading] = useState<ReadFlyerProgress | null>(null);
  const [read, setRead] = useState<ReadFlyerResult | null>(null);

  // Cancels a render in flight when a second file is chosen. Without it, two
  // renders write to the same state and the pages interleave.
  const abortRef = useRef<AbortController | null>(null);

  const onFile = useCallback(async (file: File) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setFileName(file.name);
    setPages(null);
    setError(null);
    setOpen(null);
    setElapsedMs(null);
    setRead(null);
    setProgress({ page: 0, pageCount: 0 });

    const startedAt = performance.now();
    try {
      const data = await file.arrayBuffer();
      const rendered = await renderFlyerPdf(data, {
        onProgress: setProgress,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setPages(rendered);
      setElapsedMs(Math.round(performance.now() - startedAt));
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(
        /password|encrypt/i.test(message)
          ? "This PDF is password-protected, so it cannot be read."
          : `Could not read this PDF: ${message}`,
      );
    } finally {
      if (!controller.signal.aborted) setProgress(null);
    }
  }, []);

  const runRead = useCallback(async () => {
    if (!pages) return;
    setRead(null);
    setReading({ page: 0, pageCount: pages.length, offersSoFar: 0 });
    const result = await readFlyerPages(pages, { onProgress: setReading });
    setReading(null);
    setRead(result);
  }, [pages]);

  // Verified here rather than inside the reader: the reader's job is to report
  // what a model said, and this file's job is to decide what that is worth.
  const verified = pages && read ? verifyExtraction(read.offers, pages) : null;

  const totalKb = pages?.reduce((sum, p) => sum + p.imageKb, 0) ?? 0;
  const readable = pages?.filter((p) => p.text.length >= 40).length ?? 0;

  return (
    <main className="mx-auto max-w-[900px]">
      <PageHeader
        title="Import a flyer"
        subtitle="Save this week's flyer as a PDF, then load it here."
        backHref="/"
      />

      <section className="card mb-4">
        <label className="mb-1 block text-sm font-semibold" htmlFor="retailer">
          Which retailer&rsquo;s flyer
        </label>
        <select
          id="retailer"
          className="field w-full"
          value={retailerId}
          onChange={(e) => setRetailerId(e.target.value as RetailerId)}
        >
          {Object.values(RETAILERS).map((r) => (
            <option key={r.id} value={r.id}>
              {r.displayName}
            </option>
          ))}
        </select>

        <label className="mb-1 mt-4 block text-sm font-semibold" htmlFor="pdf">
          Flyer PDF
        </label>
        <input
          id="pdf"
          type="file"
          accept="application/pdf,.pdf"
          className="field w-full"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
          }}
        />
        <p className="mt-2 text-xs text-muted">
          The file stays on this device. Nothing is uploaded by this screen.
        </p>
      </section>

      {progress ? (
        <section className="card mb-4">
          <Spinner
            label={
              progress.pageCount > 0
                ? `Rendering page ${progress.page} of ${progress.pageCount}…`
                : "Opening the PDF…"
            }
          />
        </section>
      ) : null}

      {error ? (
        <div className="mb-4">
          <Notice tone="error" title="Could not read the flyer">
            {error}
          </Notice>
        </div>
      ) : null}

      {pages && pages.length > 0 ? (
        <>
          <section className="card mb-4 text-sm">
            <p className="mb-2 font-bold">
              {RETAILERS[retailerId].displayName} — {pages.length} page
              {pages.length === 1 ? "" : "s"}
            </p>
            <Row label="File" value={fileName ?? "—"} />
            <Row
              label="Rendered"
              value={
                elapsedMs === null
                  ? "—"
                  : `${(elapsedMs / 1000).toFixed(1)}s on this device`
              }
            />
            <Row label="Page size" value={`${pages[0]!.widthPx} × ${pages[0]!.heightPx} px`} />
            <Row label="Total image data" value={`${(totalKb / 1024).toFixed(1)} MB`} />
            <Row
              label="Pages the app can check itself"
              value={`${readable} of ${pages.length}`}
            />
          </section>

          {/*
            Said before anything is read, not after. Whether a flyer can be
            checked against its own text decides how much confirming the person
            is signing up for, and that is not a detail to discover later.
          */}
          <div className="mb-4">
            <Notice
              tone={readable === 0 ? "warn" : "info"}
              title={
                readable === 0
                  ? "You can read this flyer. The app cannot."
                  : readable === pages.length
                    ? "The app can check this flyer against itself"
                    : "The app can check part of this flyer against itself"
              }
            >
              {describeTextCoverage(pages)}
            </Notice>
          </div>

          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">
            Pages — tap one to check it is readable
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {pages.map((page) => (
              <button
                key={page.pageNumber}
                type="button"
                onClick={() => setOpen(page)}
                className="overflow-hidden rounded-xl border border-line bg-surface text-left"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={page.thumbDataUrl}
                  alt={`Page ${page.pageNumber}`}
                  className="block w-full"
                />
                <span className="block px-2 py-1 text-xs text-muted">
                  Page {page.pageNumber} · {page.imageKb} KB ·{" "}
                  {page.text.length >= 40 ? "checkable" : "artwork"}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-5 space-y-3">
            {reading ? (
              <div className="card">
                <Spinner
                  label={`Reading page ${reading.page} of ${reading.pageCount} — ${reading.offersSoFar} offers so far…`}
                />
                <p className="mt-2 text-xs text-muted">
                  A page can pause here for up to half a minute if the model is
                  busy. It waits and asks again rather than skipping the page.
                </p>
              </div>
            ) : (
              <button type="button" className="btn-primary" onClick={() => void runRead()}>
                {read ? "Read the flyer again" : "Read the prices off this flyer"}
              </button>
            )}
          </div>

          {read && verified ? (
            <section className="card mt-4 text-sm">
              <p className="mb-2 font-bold">
                {read.offers.length} offer{read.offers.length === 1 ? "" : "s"} read
                {read.model ? ` by ${read.model}` : ""}
              </p>
              <Row label="Confirmed by the flyer's own text" value={String(verified.summary.confirmed)} />
              <Row label="Need your confirmation" value={String(verified.summary.needsReview)} />
              <Row label="Dropped as contradicted" value={String(verified.summary.rejected)} />
              {read.rejected.length > 0 ? (
                <Row label="Unreadable tiles skipped" value={String(read.rejected.length)} />
              ) : null}
              {read.failedPages.length > 0 ? (
                <Row
                  label="Pages that failed"
                  value={read.failedPages.map((f) => f.pageNumber).join(", ")}
                />
              ) : null}
            </section>
          ) : null}

          {read && read.failedPages.length > 0 ? (
            <div className="mt-3">
              <Notice tone="error" title="Some pages could not be read">
                {read.failedPages[0]!.error}
              </Notice>
            </div>
          ) : null}

          {read && read.offers.length > 0 ? (
            <section className="mt-4">
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">
                What it read — check these against the pages above
              </h2>
              <div className="card space-y-2 text-sm">
                {read.offers.slice(0, 60).map((offer, i) => (
                  <p key={i} className="border-b border-line pb-2 last:border-0">
                    <span className="font-bold">{formatCents(offer.price)}</span>{" "}
                    <span className="text-muted">{describeBasis(offer.basis)}</span>
                    {" — "}
                    {offer.advertisedText}
                    {offer.size ? <span className="text-muted"> · {offer.size}</span> : null}
                    <span className="block text-xs text-muted">
                      p.{offer.pageNumber}
                      {offer.retailerSku ? ` · N° ${offer.retailerSku}` : ""}
                      {offer.regularPrice ? ` · reg. ${formatCents(offer.regularPrice)}` : ""}
                      {" · "}
                      {describeCondition({
                        ...offer,
                        id: "",
                        retailerId,
                        validity: { startsAt: null, endsAt: null },
                        source: "FLYER_PDF",
                        flyerUrl: null,
                        flyerDocumentRef: null,
                        flyerPage: offer.pageNumber,
                        storeId: null,
                        observedAt: "",
                      })}
                    </span>
                  </p>
                ))}
                {read.offers.length > 60 ? (
                  <p className="text-xs text-muted">
                    …and {read.offers.length - 60} more.
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          <div className="mt-5">
            <Notice tone="info" title="Nothing has been saved">
              These are candidates, not offers. Storing them, and comparing
              them against a cart, comes next — and nothing reaches a cashier
              until it is either confirmed by the flyer&rsquo;s own text or by
              you.
            </Notice>
          </div>

          <Link href="/" className="btn-secondary mt-4">
            Done
          </Link>
        </>
      ) : null}

      {pages && pages.length === 0 ? (
        <Notice tone="warn" title="That PDF has no pages" />
      ) : null}

      {/*
        Full resolution, deliberately. The whole question this screen answers is
        whether the small print survives, and a thumbnail cannot answer it.
      */}
      {open ? (
        <div
          className="fixed inset-0 z-50 overflow-auto bg-black/90 p-2"
          onClick={() => setOpen(null)}
          role="presentation"
        >
          <p className="sticky top-0 mb-2 rounded-lg bg-black/70 px-3 py-2 text-sm text-white">
            Page {open.pageNumber} — {open.widthPx} × {open.heightPx} px. Tap to
            close. Pinch to zoom in on the small print.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={open.imageDataUrl}
            alt={`Flyer page ${open.pageNumber} at full size`}
            className="mx-auto block w-full max-w-[1600px]"
          />
        </div>
      ) : null}
    </main>
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
