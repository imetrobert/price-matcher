"use client";

/**
 * Shrink a camera photo before it is sent anywhere.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * It did not, and that was the whole timeout bug. Cart photos were read with
 * FileReader and posted at whatever the camera produced: a modern phone takes
 * a 3–4 MB JPEG, base64 adds a third, and four of them is roughly twenty
 * megabytes going up a shop's mobile signal, through an Edge Function, and on
 * to Gemini — inside one 45-second budget. It timed out, and a photo of two
 * items "took just as long as the whole cart" because almost all of the time
 * was upload, not recognition.
 *
 * The flyer path already knew this: it renders pages at proof size, about
 * 250 KB, precisely because a megabyte per page killed the run. Cart photos
 * never got the same treatment.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE NUMBERS
 * ---------------------------------------------------------------------------
 * 1600px on the long edge and JPEG quality 0.72 lands around 250–350 KB — a
 * tenth of the original at worst — and is enough to read a brand, a flavour
 * and, with luck, the printed weight. It is NOT enough for a nutrition panel,
 * which nothing here asks for.
 *
 * It started at 1280px, which fixed the timeouts and left package sizes
 * unreadable. Since a product with no size cannot be matched to a flyer at
 * all, unreadable sizes are not a cosmetic loss — they are the comparison
 * failing quietly. The extra 100 KB buys back the field the whole match turns
 * on, and is still an order of magnitude below the 3–4 MB that was timing out.
 *
 * The retry size is smaller again, for the one case where the first attempt
 * timed out anyway: a worse photo that arrives beats a better one that does
 * not.
 */

export const VISION_MAX_EDGE = 1600;
export const VISION_QUALITY = 0.72;

/** Second attempt, when the first timed out. Smaller and cheaper. */
export const RETRY_MAX_EDGE = 900;
export const RETRY_QUALITY = 0.6;

export interface ShrunkImage {
  /** Base64 without the data: URL prefix, which is what the API wants. */
  base64: string;
  mimeType: string;
  /** For the thumbnail strip. Same bytes, so no second copy is held. */
  preview: string;
  /** Encoded size in bytes, so the screen can be honest about what it sent. */
  bytes: number;
  /**
   * The file as the camera produced it.
   *
   * Kept so a timed-out attempt can be re-encoded smaller from the original
   * rather than from an already-compressed copy. A File is a handle, not a
   * second copy in memory — holding it costs nothing next to the base64 above.
   */
  source: Blob;
}

/**
 * Draw the file into a canvas at a bounded size and re-encode it as JPEG.
 *
 * Falls back to the original bytes if anything about the canvas path fails —
 * an unreadable photo is worse than a large one, and this must never be the
 * reason a scan cannot happen at all.
 */
export async function shrinkForVision(
  file: Blob,
  maxEdge: number = VISION_MAX_EDGE,
  quality: number = VISION_QUALITY,
): Promise<ShrunkImage> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("No 2D context.");
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (blob === null) throw new Error("Canvas produced no image.");

    return {
      base64: await blobToBase64(blob),
      mimeType: "image/jpeg",
      preview: URL.createObjectURL(blob),
      bytes: blob.size,
      source: file,
    };
  } catch {
    // Whatever went wrong, the photo still has to be sendable.
    return {
      base64: await blobToBase64(file),
      mimeType: file.type || "image/jpeg",
      preview: URL.createObjectURL(file),
      bytes: file.size,
      source: file,
    };
  }
}

/** A Blob as base64 without the data: prefix. */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Bytes as something a person reads, for the "sent 214 KB" line. */
export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
