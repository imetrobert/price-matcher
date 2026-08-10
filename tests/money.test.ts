import { describe, expect, it } from "vitest";

import {
  calculateSavingsCents,
  formatCents,
  meetsThreshold,
  parsePriceToCents,
  sumCents,
  tryParsePriceToCents,
} from "@/lib/money";

describe("price parsing", () => {
  it("parses plain and decorated amounts", () => {
    expect(parsePriceToCents("7.49")).toBe(749);
    expect(parsePriceToCents("$7.49")).toBe(749);
    expect(parsePriceToCents("CA$7.49")).toBe(749);
    expect(parsePriceToCents("7")).toBe(700);
    expect(parsePriceToCents("0.05")).toBe(5);
  });

  it("parses Quebec comma decimals", () => {
    expect(parsePriceToCents("7,49")).toBe(749);
    expect(parsePriceToCents("7,49 $")).toBe(749);
    expect(parsePriceToCents("1 234,56")).toBe(123456);
  });

  it("treats a lone 3-digit group as thousands, not cents", () => {
    expect(parsePriceToCents("1,234")).toBe(123400);
    expect(parsePriceToCents("1.234")).toBe(123400);
  });

  it("avoids the float trap entirely", () => {
    // 7.49 * 100 === 748.9999999999999 in IEEE-754.
    expect(parsePriceToCents("7.49")).toBe(749);
    expect(parsePriceToCents("29.97")).toBe(2997);
    expect(parsePriceToCents("1.15")).toBe(115);
    for (let cents = 0; cents <= 2000; cents += 1) {
      const text = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
      expect(parsePriceToCents(text)).toBe(cents);
    }
  });

  it("rejects nonsense instead of guessing", () => {
    expect(tryParsePriceToCents("")).toBeNull();
    expect(tryParsePriceToCents("abc")).toBeNull();
    expect(tryParsePriceToCents("7.4999")).toBeNull();
    expect(() => parsePriceToCents("free")).toThrow();
  });
});

describe("formatting", () => {
  it("formats integer cents", () => {
    expect(formatCents(749)).toBe("$7.49");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(-100)).toBe("-$1.00");
  });
});

describe("savings and threshold", () => {
  it("computes savings in cents", () => {
    expect(calculateSavingsCents(749, 649)).toBe(100);
    expect(calculateSavingsCents(749, 699)).toBe(50);
    expect(calculateSavingsCents(279, 270)).toBe(9);
  });

  it("shows at exactly the threshold and hides one cent below", () => {
    // Spec §54: $0.50 saving with a $0.50 threshold must display.
    expect(meetsThreshold(50, 50)).toBe(true);
    // $0.49 must not.
    expect(meetsThreshold(49, 50)).toBe(false);
  });

  it("sums without drift", () => {
    expect(sumCents([100, 50, 9, 875])).toBe(1034);
    expect(sumCents([])).toBe(0);
  });
});
