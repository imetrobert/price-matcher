/**
 * Currency handling. Everything internal is integer cents (CAD).
 *
 * Rule: no float ever touches a price. Parsing goes string -> cents directly
 * via digit extraction, never via parseFloat(x) * 100, which produces classics
 * like 7.49 * 100 === 748.9999999999999.
 */

import type { Cents } from "@/types";

export class MoneyParseError extends Error {}

/**
 * Parse a human-entered or scraped price into integer cents.
 * Accepts: "7.49", "$7.49", "7,49 $", "1 234,56", "7", "CA$7.49".
 * Rejects anything that is not unambiguously a single positive amount.
 */
export function parsePriceToCents(input: string): Cents {
  if (typeof input !== "string") throw new MoneyParseError("not a string");

  // Strip currency symbols, code prefixes, NBSP and regular spaces.
  const cleaned = input
    .replace(/ /g, " ")
    .replace(/(CA\$|CAD|\$)/gi, "")
    .replace(/\s/g, "")
    .trim();

  if (cleaned === "") throw new MoneyParseError("empty price");
  if (!/^[0-9.,]+$/.test(cleaned)) {
    throw new MoneyParseError(`unparseable price: ${input}`);
  }

  // Decide which separator is the decimal mark. Quebec pricing is commonly
  // written "7,49" and thousands as "1 234,56" or "1,234.56".
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let decimalSep: "," | "." | null = null;
  if (lastComma === -1 && lastDot === -1) {
    decimalSep = null;
  } else if (lastComma > lastDot) {
    decimalSep = ",";
  } else {
    decimalSep = ".";
  }

  let integerPart: string;
  let fractionPart: string;

  if (decimalSep === null) {
    integerPart = cleaned;
    fractionPart = "";
  } else {
    const idx = decimalSep === "," ? lastComma : lastDot;
    const tail = cleaned.slice(idx + 1);
    // A 3-digit tail after the only separator is a thousands group, not cents:
    // "1,234" is 1234 dollars, not 1 dollar 234 cents.
    const otherSepCount = cleaned.split(decimalSep === "," ? "." : ",").length - 1;
    if (tail.length === 3 && otherSepCount === 0 && cleaned.split(decimalSep).length === 2) {
      integerPart = cleaned.replace(/[.,]/g, "");
      fractionPart = "";
    } else {
      integerPart = cleaned.slice(0, idx).replace(/[.,]/g, "");
      fractionPart = tail;
    }
  }

  if (fractionPart.length > 2) {
    throw new MoneyParseError(`too many decimal places: ${input}`);
  }
  if (!/^[0-9]*$/.test(integerPart) || !/^[0-9]*$/.test(fractionPart)) {
    throw new MoneyParseError(`unparseable price: ${input}`);
  }

  const dollars = integerPart === "" ? 0 : Number.parseInt(integerPart, 10);
  const cents =
    fractionPart === ""
      ? 0
      : Number.parseInt(fractionPart.padEnd(2, "0").slice(0, 2), 10);

  if (!Number.isFinite(dollars) || !Number.isFinite(cents)) {
    throw new MoneyParseError(`unparseable price: ${input}`);
  }

  return dollars * 100 + cents;
}

/** Same as parsePriceToCents but returns null instead of throwing. */
export function tryParsePriceToCents(input: string): Cents | null {
  try {
    return parsePriceToCents(input);
  } catch {
    return null;
  }
}

/** Format integer cents for display, e.g. 749 -> "$7.49". */
export function formatCents(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${negative ? "-" : ""}$${dollars}.${String(rest).padStart(2, "0")}`;
}

/**
 * Savings = current - competitor, in cents. Plain integer subtraction; this
 * is deliberately trivial code and must never be delegated to an LLM.
 */
export function calculateSavingsCents(
  currentPriceCents: Cents,
  competitorPriceCents: Cents,
): Cents {
  return Math.trunc(currentPriceCents) - Math.trunc(competitorPriceCents);
}

/** Threshold test. Savings must MEET the threshold to qualify (>=). */
export function meetsThreshold(
  savingsCents: Cents,
  thresholdCents: Cents,
): boolean {
  return savingsCents >= thresholdCents;
}

export function sumCents(values: Cents[]): Cents {
  return values.reduce<Cents>((acc, v) => acc + Math.trunc(v), 0);
}
