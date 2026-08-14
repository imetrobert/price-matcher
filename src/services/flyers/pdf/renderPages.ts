"use client";

/**
 * Turning an uploaded flyer PDF into page images and page text, in the browser.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS ON THE PHONE
 * ---------------------------------------------------------------------------
 * There is no server. But even with one, this belongs here: the PDF is the
 * shopper's own copy of a flyer, and rendering it locally means the file never
 * leaves the device. Only the page images go anywhere, and only to Gemini, one
 * page at a time, to be read.
 *
 * ---------------------------------------------------------------------------
 * WHAT A REAL FLYER PDF LOOKS LIKE — MEASURED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * From the IGA flyer of 2026-08-13, saved with the site's own print button,
 * rendered through this code in Chromium:
 *
 *   16 pages, 12.6 MB, one JPEG per page, producer "Prawn".
 *   Zero text characters. Every page. It is artwork, not a document.
 *   Page box 5809 x 2942 — but the artwork is a PORTRAIT image roughly
 *   1434 x 2867, placed against the left edge of that box.
 *
 * So about three quarters of every page is empty. Rendering the page box to a
 * 1600px canvas gave the flyer itself only ~400px of width, and at that size
 * the product names under the prices are unreadable — the prices survive, the
 * products do not, which is the half that matters for matching.
 *
 * Hence CROP TO CONTENT below. The page is rendered small first, the ink is
 * located, and the real render is scaled so the ARTWORK gets the target width.
 * On this flyer that is a four-fold gain in usable resolution for the same
 * number of pixels.
 */

import type { PDFPageProxy } from "pdfjs-dist";

import type { FlyerPdfPage } from "./types";

/**
 * How wide to render a page, in device pixels.
 *
 * Chosen against the measured source: ~1434 columns of real detail. Going much
 * beyond that upsamples artwork rather than revealing anything, and every extra
 * pixel is upload time on a phone and tokens at the other end.
 */
const DEFAULT_TARGET_WIDTH = 1600;

/** Beyond this, a phone browser starts failing to allocate canvases. */
const MAX_CANVAS_PIXELS = 16_777_216;

export interface RenderedFlyerPage extends FlyerPdfPage {
  /** JPEG data URL of the rendered page. What Gemini is asked to read. */
  imageDataUrl: string;
  widthPx: number;
  heightPx: number;
}

/** Where the ink sits on the page, as fractions of the page box. */
interface InkBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderProgress {
  page: number;
  pageCount: number;
}

export interface RenderOptions {
  targetWidth?: number;
  onProgress?: (progress: RenderProgress) => void;
  /** Aborts a long render when the user leaves or picks a different file. */
  signal?: AbortSignal;
}

/**
 * pdf.js needs its worker, and a static export has no bundler route to it.
 *
 * The file is copied into `public/` by a prebuild step, so it is served from
 * the site's own origin — no CDN, which also keeps this working offline and
 * unaffected by someone else's uptime.
 */
function workerSrc(): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return `${base}/pdf.worker.min.mjs`;
}

/**
 * Render every page of a flyer PDF to an image, and pull whatever text exists.
 *
 * The text matters as much as the image: it is the independent witness that
 * `verifyExtractedOffer` checks a model's reading against. When it comes back
 * empty — as it does for every page of the IGA flyer — that is not a failure,
 * it is the finding that this flyer cannot be auto-verified and its offers need
 * a person's eye before they can be shown to a cashier.
 */
export async function renderFlyerPdf(
  data: ArrayBuffer,
  options: RenderOptions = {},
): Promise<RenderedFlyerPage[]> {
  const { targetWidth = DEFAULT_TARGET_WIDTH, onProgress, signal } = options;

  // Imported here rather than at module scope so the ~1 MB library is fetched
  // only when someone actually uploads a flyer, not on every page load.
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc();

  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: RenderedFlyerPage[] = [];

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      onProgress?.({ page: n, pageCount: doc.numPages });

      const page = await doc.getPage(n);
      const unscaled = page.getViewport({ scale: 1 });

      const ink = await findInkBounds(page, unscaled.width);

      // Scale so the ARTWORK reaches the target width, not the page box. On a
      // flyer whose page box is four times the width of its content, those
      // differ by a factor of four in usable detail.
      let scale = targetWidth / (unscaled.width * ink.width);
      const pixels =
        unscaled.width * ink.width * scale * unscaled.height * ink.height * scale;
      if (pixels > MAX_CANVAS_PIXELS) {
        scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      }

      // offsetX/offsetY shift the page within the canvas, in device pixels, so
      // the crop needs no separate copy step — the empty margin simply falls
      // outside the canvas.
      const viewport = page.getViewport({
        scale,
        offsetX: -ink.x * unscaled.width * scale,
        offsetY: -ink.y * unscaled.height * scale,
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(unscaled.width * ink.width * scale));
      canvas.height = Math.max(1, Math.floor(unscaled.height * ink.height * scale));

      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser would not provide a canvas.");

      await page.render({ canvasContext: context, viewport }).promise;

      const text = await extractPageText(page);

      pages.push({
        pageNumber: n,
        text,
        // JPEG, not PNG: flyer pages are photographs of food. PNG would be
        // several times the size for no gain a reader could notice.
        imageDataUrl: canvas.toDataURL("image/jpeg", 0.85),
        widthPx: canvas.width,
        heightPx: canvas.height,
      });

      // Free the backing store now rather than waiting for collection. Sixteen
      // full-page canvases held at once is how a phone tab dies.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }

  return pages;
}

/**
 * Where the ink actually is on the page, as fractions of the page box.
 *
 * Flyer PDFs are assembled by tools that set a generous page size and drop the
 * artwork onto it, so the box is a poor guide to where the flyer is. This finds
 * out by rendering the page small — cheap, a few milliseconds — and looking for
 * the first and last rows and columns that are not background.
 *
 * Fails safe in both directions: a page that is entirely ink returns the whole
 * box, and a page that is entirely blank returns the whole box too, because
 * cropping a blank page to nothing would lose the fact that it was blank.
 */
async function findInkBounds(
  page: PDFPageProxy,
  pageWidth: number,
): Promise<InkBounds> {
  const WHOLE_PAGE: InkBounds = { x: 0, y: 0, width: 1, height: 1 };
  /** Wide enough to find an edge, small enough to be free. */
  const PROBE_WIDTH = 400;
  /** How far from pure white still counts as background. */
  const BACKGROUND_TOLERANCE = 8;

  try {
    const viewport = page.getViewport({ scale: PROBE_WIDTH / pageWidth });
    const canvas = document.createElement("canvas");
    const w = Math.max(1, Math.floor(viewport.width));
    const h = Math.max(1, Math.floor(viewport.height));
    canvas.width = w;
    canvas.height = h;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return WHOLE_PAGE;

    // Paint white first: an untouched canvas is transparent black, which would
    // read as ink everywhere and defeat the whole measurement.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, w, h);
    await page.render({ canvasContext: context, viewport }).promise;

    const { data } = context.getImageData(0, 0, w, h);
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const background =
          data[i]! >= 255 - BACKGROUND_TOLERANCE &&
          data[i + 1]! >= 255 - BACKGROUND_TOLERANCE &&
          data[i + 2]! >= 255 - BACKGROUND_TOLERANCE;
        if (background) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    canvas.width = 0;
    canvas.height = 0;

    if (maxX < 0 || maxY < 0) return WHOLE_PAGE;

    // A hair of margin, so nothing is shaved off a glyph at the edge.
    const PAD = 2;
    const x0 = Math.max(0, minX - PAD) / w;
    const y0 = Math.max(0, minY - PAD) / h;
    const x1 = Math.min(w, maxX + 1 + PAD) / w;
    const y1 = Math.min(h, maxY + 1 + PAD) / h;
    const width = x1 - x0;
    const height = y1 - y0;

    // A crop that saves almost nothing is not worth the arithmetic, and one
    // that claims to save almost everything is a measurement gone wrong.
    if (width > 0.97 && height > 0.97) return WHOLE_PAGE;
    if (width <= 0.02 || height <= 0.02) return WHOLE_PAGE;

    return { x: x0, y: y0, width, height };
  } catch {
    return WHOLE_PAGE;
  }
}

/**
 * The page's text layer, flattened.
 *
 * Joined with spaces rather than concatenated: PDF text is emitted in
 * positioned runs, and gluing them together turns "650 g" into "650g" and
 * "7,49 $" into "7,49$", either of which could miss a match the page in fact
 * supports. The verifier normalises whitespace anyway, so a spare space costs
 * nothing and a missing one costs a confirmation.
 */
async function extractPageText(page: {
  getTextContent: () => Promise<{ items: unknown[] }>;
}): Promise<string> {
  try {
    const content = await page.getTextContent();
    return content.items
      .map((item) =>
        typeof item === "object" && item !== null && "str" in item
          ? String((item as { str: unknown }).str)
          : "",
      )
      .join(" ")
      .trim();
  } catch {
    // A page whose text cannot be read is reported as having none, which sends
    // its offers to review. That is the safe direction to fail in.
    return "";
  }
}

/** How much of a flyer can be checked automatically, before spending on it. */
export function describeTextCoverage(pages: RenderedFlyerPage[]): string {
  const withText = pages.filter((p) => p.text.length >= 40).length;
  if (withText === 0) {
    return `No page in this flyer carries readable text, so every price read from it will need your confirmation before it can be shown at a till.`;
  }
  if (withText === pages.length) {
    return `Every page carries readable text, so prices can be checked against the flyer's own words.`;
  }
  return `${withText} of ${pages.length} pages carry readable text. Prices from the other ${pages.length - withText} will need your confirmation.`;
}
