"use client";

/**
 * The flyer page, with the offer's tile marked on it.
 *
 * ---------------------------------------------------------------------------
 * WHY A HIGHLIGHT AND NOT JUST A PAGE
 * ---------------------------------------------------------------------------
 * "IGA, page 7" is a citation somebody can check. A page of a Montreal grocery
 * flyer carries twenty to thirty tiles, so checking it means pinching around
 * artwork on a phone, at a till, with somebody waiting. That distance is the
 * difference between a citation and a proof.
 *
 * When the reading recorded where the tile sits, this draws a rectangle round
 * it and scrolls it into view. When it did not, the page still appears and the
 * page number still stands — the highlight is the only thing lost.
 *
 * ---------------------------------------------------------------------------
 * WHEN THERE IS NO PICTURE AT ALL
 * ---------------------------------------------------------------------------
 * A stored page can be missing: the shopper turned pictures off, an upload
 * failed, or the flyer has expired and its images were purged. That case used
 * to say only "no image was kept", which left somebody to work out for
 * themselves which of five PDFs to open.
 *
 * So it names the file. The flyer records the filename it was imported from,
 * and "open PDF_wk33-2026-SA V6.pdf at page 7" is a usable instruction where
 * "no image" is not.
 */

import { useEffect, useRef, useState } from "react";

import { flyerPageUrl } from "@/services/flyers/storage";

export interface FlyerPageProofProps {
  flyerId: string;
  page: number;
  /** [ymin, xmin, ymax, xmax] on a 0-1000 scale, or null. */
  box: [number, number, number, number] | null;
  /** The PDF this flyer was imported from, for when no picture was kept. */
  sourceFilename?: string | null;
}

export function FlyerPageProof({
  flyerId,
  page,
  box,
  sourceFilename,
}: FlyerPageProofProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const markRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let live = true;
    setState("loading");
    flyerPageUrl(flyerId, page)
      .then((found) => {
        if (!live) return;
        setUrl(found);
        setState(found ? "ready" : "missing");
      })
      .catch(() => live && setState("missing"));
    return () => {
      live = false;
    };
  }, [flyerId, page]);

  // Bring the marked tile into view once the picture has laid out. A highlight
  // below the fold on a tall flyer page helps nobody.
  useEffect(() => {
    if (state !== "ready" || !box || !markRef.current) return;
    const timer = setTimeout(() => {
      markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 250);
    return () => clearTimeout(timer);
  }, [state, box]);

  if (state === "loading") {
    return <p className="mt-3 text-sm text-muted">Loading the page…</p>;
  }

  if (state === "missing" || !url) {
    return (
      <div className="mt-3 rounded-md bg-warn/10 p-2 text-sm text-warn">
        <p className="font-semibold">No picture of this page was kept.</p>
        <p className="mt-1">
          {sourceFilename
            ? `Open your own copy — ${sourceFilename} — at page ${page}.`
            : `Check page ${page} of the flyer in your own copy.`}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="relative overflow-hidden rounded-xl border border-line">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={`Flyer page ${page}`} className="block w-full" />

        {box ? (
          <span
            ref={markRef}
            aria-hidden
            className="pointer-events-none absolute rounded-md border-[3px] border-good shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
            style={{
              // 0-1000, origin top-left, in the order the model was asked for.
              top: `${box[0] / 10}%`,
              left: `${box[1] / 10}%`,
              height: `${(box[2] - box[0]) / 10}%`,
              width: `${(box[3] - box[1]) / 10}%`,
            }}
          />
        ) : null}
      </div>

      <p className="mt-1 text-center text-xs text-muted">
        {box
          ? "The offer is inside the box. Tap to open the full page."
          : `Page ${page}. This reading did not record where on the page, so look for the product yourself.`}
      </p>

      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="btn-secondary mt-2"
      >
        Open page {page} full size
      </a>
    </div>
  );
}
