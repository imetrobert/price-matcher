"use client";

/**
 * Where a week's flyers actually come from.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ON THE IMPORT SCREEN
 * ---------------------------------------------------------------------------
 * The screen asks for six PDFs and never says where to get them. That was fine
 * for the person who built it and useless to anybody else — and it is the step
 * most likely to stop somebody, because the retailers' own sites do not offer a
 * PDF anywhere obvious. Every one of them was measured: the pages are drawn by
 * script and there is no download link in the HTML.
 *
 * raddar.ca publishes the same weekly flyers as PDFs, one click from each
 * flyer's header, which is how the flyers in this app were obtained. So the
 * link goes here, next to the file picker it feeds.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PICTURE IS DRAWN AND NOT PHOTOGRAPHED
 * ---------------------------------------------------------------------------
 * The illustration below is a diagram of raddar's toolbar, not a screenshot of
 * it: a drawing of somebody else's page cannot go stale in a way that misleads,
 * and it carries none of their artwork. It shows the row of buttons under a
 * flyer's title and rings the one that matters.
 *
 * If you would rather show a real screenshot — and it will look more like what
 * you see — drop an image at `public/raddar-pdf.png` and commit it. It is used
 * automatically, and the drawing goes back to being the fallback for when the
 * file is missing. Nothing else needs changing.
 */

import { useState } from "react";

/** Where the site is served from, for the optional screenshot's URL. */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const RADDAR_URL = "https://raddar.ca/en/flyers/all-flyers";

export function WhereToGetFlyers() {
  const [open, setOpen] = useState(false);
  // The optional screenshot, until the browser tells us there isn't one.
  const [shotMissing, setShotMissing] = useState(false);

  return (
    <section className="card mb-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold">Where to get this week&rsquo;s flyers</span>
        {/*
          A button, not a link, and it says what it does. An "i" alone is a
          guess about whether anything happens when you press it.
        */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="raddar-help"
          className="flex h-6 w-6 items-center justify-center rounded-full border border-line text-xs font-bold text-brand"
        >
          <span aria-hidden>i</span>
          <span className="sr-only">
            {open ? "Hide how to download a flyer" : "How to download a flyer"}
          </span>
        </button>
      </div>

      <a
        href={RADDAR_URL}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-2 inline-block break-all text-sm font-semibold text-brand underline"
      >
        raddar.ca — all Quebec flyers
      </a>

      <p className="mt-2 text-xs text-muted">
        Opens in a new tab. Set the location to yours, then download each
        store&rsquo;s PDF and bring the files back here.
      </p>

      {open ? (
        <div id="raddar-help" className="mt-3 rounded-md border border-line p-3">
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>Open a flyer from the list.</li>
            <li>
              In the bar under its name, press the{" "}
              <span className="font-semibold">PDF</span> button.
            </li>
            <li>Save the file, then choose it below.</li>
          </ol>

          {shotMissing ? (
            <RaddarToolbarDrawing />
          ) : (
            <img
              src={`${BASE}/raddar-pdf.png`}
              alt="The button bar under a flyer's name on raddar, with the PDF button marked"
              className="mt-3 w-full rounded-md border border-line"
              onError={() => setShotMissing(true)}
            />
          )}

          <p className="mt-2 text-xs text-muted">
            raddar is somebody else&rsquo;s site and can change its layout at
            any time. If it looks nothing like this, the PDF button is still
            the one to look for.
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The toolbar as a drawing: [Enhanced Filters ▸] [PDF] [share] [favorite],
 * with the second one ringed.
 *
 * Deliberately plain shapes. The point is which position in the row to press,
 * and reproducing a company's icons to make that point would be copying their
 * artwork to say something a rectangle says just as well.
 */
function RaddarToolbarDrawing() {
  return (
    <svg
      viewBox="0 0 360 108"
      role="img"
      aria-label="A row of four buttons; the second, labeled PDF, is circled"
      className="mt-3 w-full rounded-md border border-line bg-surface"
    >
      {/* Enhanced Filters */}
      <rect x="10" y="18" width="150" height="44" rx="10" className="fill-none stroke-line" strokeWidth="2" />
      <circle cx="34" cy="40" r="10" className="fill-none stroke-line" strokeWidth="2" />
      <text x="52" y="45" className="fill-muted" fontSize="13">Enhanced Filters ▸</text>

      {/* PDF — the one that matters */}
      <rect x="170" y="18" width="52" height="44" rx="10" className="fill-none stroke-warn" strokeWidth="3" />
      <rect x="184" y="27" width="24" height="26" rx="3" className="fill-none stroke-warn" strokeWidth="2" />
      <text x="196" y="45" textAnchor="middle" className="fill-warn" fontSize="9" fontWeight="bold">PDF</text>

      {/* Share, favorite — position only, so the eye can count along the row. */}
      <rect x="232" y="18" width="52" height="44" rx="10" className="fill-none stroke-line" strokeWidth="2" />
      <path d="M248 40 l16 -8 M248 40 l16 8" className="fill-none stroke-line" strokeWidth="2" />
      <circle cx="268" cy="32" r="4" className="fill-none stroke-line" strokeWidth="2" />
      <circle cx="268" cy="48" r="4" className="fill-none stroke-line" strokeWidth="2" />
      <circle cx="246" cy="40" r="4" className="fill-none stroke-line" strokeWidth="2" />

      <rect x="294" y="18" width="52" height="44" rx="10" className="fill-none stroke-line" strokeWidth="2" />
      <path
        d="M320 50 c-10 -7 -14 -12 -14 -17 a6 6 0 0 1 14 -4 a6 6 0 0 1 14 4 c0 5 -4 10 -14 17 z"
        className="fill-none stroke-line"
        strokeWidth="2"
      />

      {/* The callout, pointing up at the ringed button. */}
      <path d="M196 70 v14" className="stroke-warn" strokeWidth="2" />
      <text x="196" y="100" textAnchor="middle" className="fill-warn" fontSize="13" fontWeight="bold">
        Press this to download
      </text>
    </svg>
  );
}
