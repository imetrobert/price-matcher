/**
 * Gemini cart-photo recognition (server-side only).
 *
 * The API key is read from process.env inside this module and never leaves the
 * server. Images arrive as base64 from the browser, are sent inline to Gemini,
 * and are not written to disk unless CARTMATCH_PERSIST_PHOTOS=true.
 *
 * VERIFICATION STATUS: the request shape below follows the documented
 * generateContent REST contract, and the endpoint is reachable from the
 * development environment (it returns a well-formed API error for an invalid
 * key). It has NOT been exercised with a valid key, because no GEMINI_API_KEY
 * was available here. Treat the first real call as the acceptance test.
 */

import "server-only";

import { env, hasGeminiKey } from "@/config/env";
import {
  CART_VISION_SCHEMA,
  VISION_PROMPT,
  parseVisionResponse,
} from "@/services/vision/schema";
import type { DetectedProduct } from "@/types";

export interface VisionImage {
  /** Base64 WITHOUT the data: URL prefix. */
  base64: string;
  mimeType: string;
}

export type VisionOutcome =
  | { ok: true; products: DetectedProduct[]; isMock: boolean; note: string }
  | { ok: false; error: string; code: VisionErrorCode };

export type VisionErrorCode =
  | "NO_API_KEY"
  | "NO_IMAGES"
  | "API_ERROR"
  | "BAD_RESPONSE"
  | "TIMEOUT";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_IMAGES = 4;
const TIMEOUT_MS = 45_000;

export async function recognizeCart(
  images: VisionImage[],
): Promise<VisionOutcome> {
  if (images.length === 0) {
    return { ok: false, code: "NO_IMAGES", error: "No images supplied." };
  }
  if (!hasGeminiKey()) {
    return {
      ok: false,
      code: "NO_API_KEY",
      error:
        "GEMINI_API_KEY is not set, so photo recognition is unavailable. Set it in .env.local, or use Manual Product Test.",
    };
  }

  const parts: unknown[] = [{ text: VISION_PROMPT }];
  for (const img of images.slice(0, MAX_IMAGES)) {
    parts.push({
      inline_data: { mime_type: img.mimeType, data: img.base64 },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let res = await callGemini(parts, supportsThinkingConfig(), controller.signal);

    // Defensive: `thinkingConfig` only exists on the 2.5+ series, and model
    // families change. If it is rejected, drop it and retry once rather than
    // failing a shopper's scan over a config field. Logged so it is visible
    // rather than silently degrading.
    if (!res.ok && res.status === 400 && supportsThinkingConfig()) {
      const detail = await safeText(res);
      if (/thinking/i.test(detail)) {
        console.warn(
          `[cartmatch] ${env.geminiModel} rejected thinkingConfig; retrying without it. Detail: ${truncate(detail, 200)}`,
        );
        res = await callGemini(parts, false, controller.signal);
      } else {
        return {
          ok: false,
          code: "API_ERROR",
          error: `Gemini returned HTTP 400. ${truncate(detail, 400)}`,
        };
      }
    }

    if (!res.ok) {
      const detail = await safeText(res);
      return {
        ok: false,
        code: "API_ERROR",
        // Never echo the key back, even indirectly.
        error: `Gemini returned HTTP ${res.status}. ${truncate(detail, 400)}`,
      };
    }

    const json = (await res.json()) as GeminiResponse;
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      return {
        ok: false,
        code: "BAD_RESPONSE",
        error: "Gemini response contained no JSON payload.",
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        code: "BAD_RESPONSE",
        error: "Gemini returned text that was not valid JSON.",
      };
    }

    const products = parseVisionResponse(parsed, { isMock: false });
    return {
      ok: true,
      products,
      isMock: false,
      note: `Recognized by ${env.geminiModel}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = message.toLowerCase().includes("abort");
    return {
      ok: false,
      code: isAbort ? "TIMEOUT" : "API_ERROR",
      error: isAbort
        ? `Gemini request timed out after ${TIMEOUT_MS}ms.`
        : `Gemini request failed: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

/**
 * `thinkingConfig` is a 2.5-series-and-later parameter. Sending it to an
 * older model is a 400, so gate on the model name. The check is deliberately
 * loose (any 2.5/3.x/etc.) and backed by the retry-without-it path above, so a
 * future model family cannot break recognition.
 */
/** Exposed for tests; not part of the module's public surface. */
export function __supportsThinkingConfigForTest(): boolean {
  return supportsThinkingConfig();
}

function supportsThinkingConfig(): boolean {
  const model = env.geminiModel.toLowerCase();
  if (model.includes("2.0") || model.includes("1.5") || model.includes("1.0")) {
    return false;
  }
  return /gemini-(\d+)\.(\d+)/.test(model);
}

async function callGemini(
  parts: unknown[],
  withThinkingConfig: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseSchema: CART_VISION_SCHEMA,
    // Low temperature: this is an extraction task, not a creative one.
    temperature: 0.1,
  };

  if (withThinkingConfig) {
    generationConfig.thinkingConfig = {
      thinkingBudget: env.geminiThinkingBudget,
    };
  }

  return fetch(
    `${ENDPOINT}/${encodeURIComponent(env.geminiModel)}:generateContent?key=${encodeURIComponent(env.geminiApiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig,
      }),
      signal,
      cache: "no-store",
    },
  );
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
