/**
 * Finding a flyer's run dates in its own text, without asking a model.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Maxi's cover prints, in both languages:
 *
 *   Du jeudi 13 aout au mercredi 19 aout 2026
 *   From Thursday, August 13th to Wednesday, August 19th, 2026
 *
 * The dates were nonetheless reported as missing, because the only route to
 * them ran through Gemini — and the API key was over quota, so page 1 was
 * never read at all. A fact printed on the cover should not be unobtainable
 * because a rate limit elsewhere.
 *
 * So the text layer is tried first. It costs nothing, needs no network, works
 * when the quota is gone, and is not a reading — it is the characters the file
 * itself declares. Where a flyer is pure artwork this finds nothing and the
 * model route still applies.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES
 * ---------------------------------------------------------------------------
 * A year it did not see. Flyers routinely print "du 13 au 19 aout" with the
 * year only in small print or not at all, and inferring "this year" would put
 * a December flyer read in January eleven months out of date. No year, no
 * answer.
 */

const MONTHS: Record<string, number> = {
  // French, as printed on a Quebec flyer.
  janvier: 1,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
  // English.
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const MONTH_NAMES = Object.keys(MONTHS).join("|");

/** Accents off, case down, whitespace flattened — as the rest of this app does. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface TextValidity {
  from: string;
  to: string;
}

/**
 * Look for a date range in a page's text.
 *
 * Handles the two shapes a Montreal flyer actually prints:
 *
 *   "du jeudi 13 aout au mercredi 19 aout 2026"   day before month, one year
 *   "from Thursday, August 13th to Wednesday, August 19th, 2026"
 *
 * The month may appear once or twice; the year appears once, at the end. Both
 * are handled by looking for two day-and-optional-month pairs followed by a
 * four-digit year.
 */
export function validityFromText(text: string): TextValidity | null {
  const t = fold(text);

  // French: du [weekday] D [month] au [weekday] D [month] YYYY
  const fr = new RegExp(
    `\\bdu\\b[^0-9]{0,20}(\\d{1,2})\\s*(${MONTH_NAMES})?[^0-9]{0,20}\\bau\\b[^0-9]{0,20}(\\d{1,2})\\s*(${MONTH_NAMES})[^0-9]{0,12}(\\d{4})`,
  ).exec(t);
  if (fr) {
    const endMonth = MONTHS[fr[4]!]!;
    const startMonth = fr[2] ? MONTHS[fr[2]]! : endMonth;
    const year = Number(fr[5]);
    // A range that crosses new year prints the later month with a smaller
    // number; the start belongs to the previous year.
    const startYear = startMonth > endMonth ? year - 1 : year;
    const from = iso(startYear, startMonth, Number(fr[1]));
    const to = iso(year, endMonth, Number(fr[3]));
    if (from && to && from <= to) return { from, to };
  }

  // English: from [weekday,] Month D[st] to [weekday,] Month D[st], YYYY
  const en = new RegExp(
    `\\bfrom\\b[^0-9]{0,24}(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?[^0-9]{0,24}\\bto\\b[^0-9]{0,24}(${MONTH_NAMES})?\\s*(\\d{1,2})(?:st|nd|rd|th)?[^0-9]{0,12}(\\d{4})`,
  ).exec(t);
  if (en) {
    const startMonth = MONTHS[en[1]!]!;
    const endMonth = en[3] ? MONTHS[en[3]]! : startMonth;
    const year = Number(en[5]);
    const startYear = startMonth > endMonth ? year - 1 : year;
    const from = iso(startYear, startMonth, Number(en[2]));
    const to = iso(year, endMonth, Number(en[4]));
    if (from && to && from <= to) return { from, to };
  }

  // Numeric, as Metro Inc writes it: "Valid 13-08-26 - 19-08-26".
  const numeric =
    /(\d{2})-(\d{2})-(\d{2})\s*(?:-|to|au)\s*(\d{2})-(\d{2})-(\d{2})/.exec(t);
  if (numeric) {
    const from = iso(
      2000 + Number(numeric[3]),
      Number(numeric[2]),
      Number(numeric[1]),
    );
    const to = iso(
      2000 + Number(numeric[6]),
      Number(numeric[5]),
      Number(numeric[4]),
    );
    if (from && to && from <= to) return { from, to };
  }

  return null;
}

/**
 * Try the earliest pages first, and stop at the first answer.
 *
 * The cover carries the flyer's own window. Later pages carry section dates and
 * coupon expiries, and taking one of those would date the whole flyer by
 * whatever was printed on page nine — so only the first few are consulted.
 */
export function validityFromPages(
  pages: { pageNumber: number; text: string }[],
  maxPages = 3,
): TextValidity | null {
  for (const page of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    if (page.pageNumber > maxPages) break;
    const found = validityFromText(page.text);
    if (found) return found;
  }
  return null;
}
