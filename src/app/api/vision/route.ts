/**
 * POST /api/vision — cart photo -> structured product list.
 *
 * The Gemini key lives only on this side of the wire. Images are held in
 * memory for the duration of the request and are written to disk only when
 * CARTMATCH_PERSIST_PHOTOS=true.
 */

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

import { env } from "@/config/env";
import { analyzeCartPhotos, visionProviderName } from "@/services/vision";
import type { VisionImage } from "@/services/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGES = 4;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per image before base64 expansion

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const images = extractImages(payload);
  if (images.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "No images supplied. Take at least one photo of your cart.",
      },
      { status: 400 },
    );
  }

  for (const img of images) {
    if (approximateBytes(img.base64) > MAX_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "One of the photos is too large. Retake it at a lower resolution.",
        },
        { status: 413 },
      );
    }
  }

  if (env.persistPhotos) {
    await persistForDebugging(images);
  }

  const outcome = await analyzeCartPhotos(images);

  if (!outcome.ok) {
    return NextResponse.json(
      { ok: false, error: outcome.error, code: outcome.code },
      { status: outcome.code === "NO_API_KEY" ? 503 : 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    products: outcome.products,
    isMock: outcome.isMock,
    note: outcome.note,
    provider: visionProviderName(),
  });
}

function extractImages(payload: unknown): VisionImage[] {
  if (typeof payload !== "object" || payload === null) return [];
  const raw = (payload as { images?: unknown }).images;
  if (!Array.isArray(raw)) return [];

  const out: VisionImage[] = [];
  for (const item of raw.slice(0, MAX_IMAGES)) {
    if (typeof item !== "object" || item === null) continue;
    const { base64, mimeType } = item as {
      base64?: unknown;
      mimeType?: unknown;
    };
    if (typeof base64 !== "string" || base64.length === 0) continue;
    const mt = typeof mimeType === "string" ? mimeType : "image/jpeg";
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(mt)) continue;
    // Accept a data: URL as well as bare base64.
    const cleaned = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
    out.push({ base64: cleaned, mimeType: mt });
  }
  return out;
}

function approximateBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

async function persistForDebugging(images: VisionImage[]): Promise<void> {
  try {
    const dir = path.join(process.cwd(), env.dataDir, "photos");
    await fs.mkdir(dir, { recursive: true });
    const stamp = Date.now();
    await Promise.all(
      images.map((img, i) =>
        fs.writeFile(
          path.join(dir, `${stamp}-${i}.bin`),
          Buffer.from(img.base64, "base64"),
        ),
      ),
    );
  } catch {
    // Debug persistence must never break the request.
  }
}
