/**
 * The flyer offer parser, for the browser.
 *
 * The rules themselves live in `supabase/functions/_shared/parseOffers.ts`,
 * because the scheduled worker runs them too — it reads the pages after the
 * tab has closed, and a second implementation of the rules that decide whether
 * a number reaches a cashier is the most dangerous thing this project could
 * contain.
 *
 * This file exists only to re-export them under the app's own types, so
 * nothing downstream has to know where they live.
 */

export {
  parseFlyerExtraction,
  type ParsedExtraction,
} from "@shared/parseOffers";
