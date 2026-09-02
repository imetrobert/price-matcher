/**
 * What to say to a cashier about where a price came from.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS TEXT, AND WORKS WITHOUT A PICTURE
 * ---------------------------------------------------------------------------
 * The strongest evidence is the flyer page itself, and the app can keep one.
 * But storing pictures is a choice with a cost attached, and somebody who
 * declines it must not be left with nothing — so every offer records the page
 * it was printed on, and a citation is built from data rather than from an
 * image.
 *
 * "IGA flyer, page 7, valid to Aug 19" is a claim a shopper can act on with
 * their own copy of the flyer in hand. It is weaker than showing the page, and
 * far stronger than "IGA has it cheaper".
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES TO SAY
 * ---------------------------------------------------------------------------
 * Nothing here asserts that a match will be honoured. Every retailer policy in
 * this app is UNKNOWN with no source (see config/policies.ts), so a citation
 * describes what was advertised and where — never what a cashier must do about
 * it.
 */

import { RETAILERS } from "@/config/retailers";
import type { RetailerId } from "@/types";

export interface CitationInput {
  retailerId: RetailerId;
  flyerPage: number;
  validFrom: string;
  validTo: string;
  /** True when a stored page image can be shown alongside the words. */
  hasPageImage: boolean;
  /**
   * True for a Flipp/partner-feed offer. There is no page number and never
   * was — flyerPage on these is a placeholder, not a citation, and saying
   * "page 0" or "your own copy" of a flyer nobody photographed is false.
   */
  isPartnerFeed?: boolean;
}

/** A day as a shopper reads it, in the local sense of the date. */
export function day(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  // Noon UTC, so a date never lands on the previous day west of Greenwich. A
  // flyer shown as expiring a day early is a flyer nobody takes to checkout.
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The one line a shopper reads out or shows.
 *
 * Retailer, page, and the window — in that order, because that is the order a
 * price-match desk asks for them.
 */
export function citationLine(input: CitationInput): string {
  const name = RETAILERS[input.retailerId]?.displayName ?? input.retailerId;
  if (input.isPartnerFeed) {
    return `${name}, via Flipp — not confirmed by CartMatch, valid ${day(input.validFrom)} to ${day(input.validTo)}`;
  }
  return `${name} flyer, page ${input.flyerPage}, valid ${day(input.validFrom)} to ${day(input.validTo)}`;
}

/**
 * What the shopper has to do to produce the document, given what was kept.
 *
 * Said plainly either way. Someone who turned pictures off should learn that
 * at the moment they are planning a shop, not at checkout.
 */
export function citationEvidence(input: CitationInput): string {
  if (input.isPartnerFeed) {
    return "From Flipp, not a flyer CartMatch photographed — check the price and unit at the store before relying on it.";
  }
  return input.hasPageImage
    ? "The page is saved — open it to show the cashier."
    : "No page picture was kept. Open your own copy of the flyer at this page.";
}

/**
 * Is this citation still true today?
 *
 * A citation for a window that has closed is not a weak claim, it is a false
 * one — so it is checked here as well as by the freshness rules, because this
 * is the string that ends up in front of another person.
 */
export function citationIsCurrent(input: CitationInput, on: Date): boolean {
  const today = on.toISOString().slice(0, 10);
  return input.validFrom <= today && today <= input.validTo;
}
