/**
 * Postal code handling and the Montreal-region gate (spec §16).
 *
 * The MVP deliberately refuses to compare against anything outside the
 * configured region rather than silently widening the search.
 */

import { REGION } from "@/config/thresholds";

const CANADIAN_POSTAL = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ ]?\d[ABCEGHJ-NPRSTV-Z]\d$/i;

export function normalizePostalCode(input: string): string | null {
  const cleaned = input.replace(/\s+/g, "").toUpperCase();
  if (cleaned.length !== 6) return null;
  const spaced = `${cleaned.slice(0, 3)} ${cleaned.slice(3)}`;
  return CANADIAN_POSTAL.test(spaced) ? spaced : null;
}

export function isValidPostalCode(input: string): boolean {
  return normalizePostalCode(input) !== null;
}

/** Forward sortation area — the first three characters. */
export function fsa(postalCode: string): string | null {
  const n = normalizePostalCode(postalCode);
  return n ? n.slice(0, 3) : null;
}

/** Is this postal code inside the supported market? */
export function isInSupportedRegion(postalCode: string): boolean {
  const f = fsa(postalCode);
  if (!f) return false;
  return REGION.allowedFsaPrefixes.some((p) => f.startsWith(p));
}

export function regionLabel(): string {
  return REGION.label;
}

export function unsupportedRegionMessage(postalCode: string): string {
  return `${postalCode} is outside the ${REGION.name} region. This MVP only compares ${REGION.name}-area pricing, so results would not be meaningful here.`;
}
