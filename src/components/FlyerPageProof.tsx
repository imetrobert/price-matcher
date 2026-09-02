"use client";

/**
 * The flyer page, with the offer's tile marked on it.
 *
 * ---------------------------------------------------------------------------
 * WHY A HIGHLIGHT AND NOT JUST A PAGE
 * ---------------------------------------------------------------------------
 * "IGA, page 7" is a citation somebody can check. A page of a Montreal grocery
 * flyer carries twenty to thirty tiles, so checking it means pinching around
 * artwork on a phone, at checkout, with somebody waiting. That distance is the
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

/**
 * A Flipp item picture, with a visible loading state.
 *
 * Flipp's own CDN can take a real, noticeable moment to answer — a plain
 * <img> tag with nothing else shown just sits blank until then, which reads
 * as broken rather than as loading. This shows a small spinner in the same
 * footprint until the image actually finishes (or gives up and fails
 * quietly, rather than spinning forever). Shared by every place a Flipp
 * picture appears, so the wait looks the same everywhere.
 */
export function FlippThumbnail({
  url,
  className = "h-12 w-12",
}: {
  url: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span
      className={`relative ${className} shrink-0 overflow-hidden rounded bg-surface`}
    >
      {!loaded ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-warn"
          />
        </span>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        className={`h-full w-full object-cover transition-opacity ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
      />
    </span>
  );
}

export interface FlyerPageProofProps {
  flyerId: string;
  page: number;
  /** [ymin, xmin, ymax, xmax] on a 0-1000 scale, or null. */
  box: [number, number, number, number] | null;
  /** The PDF this flyer was imported from, for when no picture was kept. */
  sourceFilename?: string | null;
  /**
   * True for a Flipp/partner-feed offer. There is no page, no photographed
   * picture, and no "your own copy" of a flyer nobody photographed —
   * attempting the usual lookup here would only ever find nothing and say
   * something false.
   */
  isPartnerFeed?: boolean;
  /**
   * Flipp's own per-item picture (StoredOffer.partnerImageUrl), when there
   * is one. Only meaningful alongside isPartnerFeed — a photographed
   * offer's picture always comes from the flyerId/page lookup instead.
   */
  imageUrl?: string | null;
}

export function FlyerPageProof({
  flyerId,
  page,
  box,
  sourceFilename,
  isPartnerFeed,
  imageUrl,
}: FlyerPageProofProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const markRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (isPartnerFeed) {
      // Nothing to fetch — this offer was never a photographed page.
      setState("missing");
      return;
    }
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
  }, [flyerId, page, isPartnerFeed]);

  // Bring the marked tile into view once the picture has laid out. A highlight
  // below the fold on a tall flyer page helps nobody.
  useEffect(() => {
    if (state !== "ready" || !box || !markRef.current) return;
    const timer = setTimeout(() => {
      markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 250);
    return () => clearTimeout(timer);
  }, [state, box]);

  if (isPartnerFeed) {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-md bg-surface p-2 text-sm text-muted">
        {imageUrl ? <FlippThumbnail url={imageUrl} /> : null}
        <span>
          Advertised via Flipp, not a flyer CartMatch photographed — check
          the price and unit at the store before relying on it.
        </span>
      </div>
    );
  }

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
