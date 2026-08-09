/**
 * Vision entry point. Chooses the real Gemini provider or the mock provider
 * and always reports which one ran, so the UI can label the result.
 */

import "server-only";

import { env, hasGeminiKey } from "@/config/env";
import { recognizeCart, type VisionImage, type VisionOutcome } from "@/services/vision/gemini";
import { mockRecognizeCart } from "@/services/vision/mock";

export type { VisionImage, VisionOutcome };

export async function analyzeCartPhotos(
  images: VisionImage[],
): Promise<VisionOutcome> {
  // Real vision requires a key. In MOCK data mode we prefer fixtures even if a
  // key exists, so that a mock run is reproducible end to end.
  if (env.dataMode === "MOCK" || !hasGeminiKey()) {
    return mockRecognizeCart(images, {
      reason: hasGeminiKey()
        ? "CARTMATCH_DATA_MODE=MOCK"
        : "GEMINI_API_KEY is not set",
    });
  }
  return recognizeCart(images);
}

export function visionProviderName(): string {
  if (env.dataMode === "MOCK") return "MOCK (fixtures)";
  return hasGeminiKey() ? `Gemini ${env.geminiModel}` : "unavailable (no API key)";
}
