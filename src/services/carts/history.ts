"use client";

/**
 * Carts you have scanned, kept until their flyers stop being true.
 *
 * ---------------------------------------------------------------------------
 * WHY ON THE DEVICE
 * ---------------------------------------------------------------------------
 * A shopping history is a personal record — what somebody buys, where, and how
 * often. It is not needed on a server for this app to work, so it is not put on
 * one. Nothing here syncs, nothing here is readable by anybody else, and there
 * is no table to secure. The cost is honest and worth stating on the screen:
 * carts live on the device that scanned them and go when browsing data is
 * cleared.
 *
 * ---------------------------------------------------------------------------
 * WHY THEY EXPIRE WITH THE FLYERS
 * ---------------------------------------------------------------------------
 * Every number in a saved cart came from a flyer that runs for a week. On the
 * day after that week ends, none of those numbers is a price any more — not a
 * stale price, not an approximate one, simply not a price. A saved cart is
 * therefore deleted once the last flyer behind it has expired, without being
 * asked. Keeping it would mean holding a screen full of confident figures that
 * are all wrong, which is the failure this project keeps designing against.
 *
 * ---------------------------------------------------------------------------
 * WHY localStorage AND NOT sessionStorage
 * ---------------------------------------------------------------------------
 * The last-cart handoff to Checkout Mode uses sessionStorage, which is emptied
 * when the tab closes. That is survivable for a handoff between two screens in
 * one visit. It is useless for history: a cart scanned on Tuesday must still be
 * there on Thursday, and closing the browser between the aisle and checkout is
 * an ordinary thing to do.
 */

import type { CartComparison } from "@/services/flyers/cartMatch";
import type { RetailerId } from "@/types";

const KEY = "cartmatch.carts.v1";

/**
 * How many to keep.
 *
 * A cart is a few tens of kilobytes — every matched offer travels with it so
 * the saved view can show the same evidence as the live one. Local storage
 * gives about five megabytes for the whole origin, shared with preferences and
 * the Checkout Mode handoff, so this is deliberately well short of it.
 */
export const MAX_SAVED_CARTS = 20;

export interface SavedCart {
  id: string;
  /** When it was scanned, ISO. */
  at: string;
  /** Where the shopper was standing. */
  retailerId: RetailerId;
  /**
   * The last day any flyer behind this cart runs.
   *
   * The expiry rule turns on this one field. Null when the cart matched
   * nothing at all — such a cart has no flyer behind it, so it is kept for the
   * same week it was scanned and no longer.
   */
  validTo: string | null;
  comparison: CartComparison;
}

/** A cart as the list needs it, without unpacking every offer to draw a row. */
export interface CartSummary {
  id: string;
  at: string;
  retailerId: RetailerId;
  validTo: string | null;
  items: number;
  /** Lines with a computed saving. */
  cheaper: number;
  /** Lines advertised elsewhere with no comparable price here. */
  onSale: number;
  totalSavingCents: number;
}

/**
 * The last day this cart's prices are true.
 *
 * Taken from the offers themselves rather than from the scan date, because the
 * flyer week is what makes a price a price. A cart scanned on the last day of a
 * flyer week expires that night; one scanned on the first day lasts six more
 * days. Both are correct, and neither is a guess about the calendar.
 */
export function cartValidTo(comparison: CartComparison): string | null {
  let latest: string | null = null;
  for (const line of comparison.lines) {
    for (const offer of [...line.matches, ...line.measuredMatches]) {
      if (latest === null || offer.validTo > latest) latest = offer.validTo;
    }
  }
  return latest;
}

/**
 * Is this cart still worth keeping on the given day?
 *
 * A cart with no flyer behind it has no expiry to read, so it is kept for a
 * week from its scan — long enough to be looked at, short enough not to
 * accumulate. Anything unparseable is dropped: a record nobody can date is a
 * record nobody can trust to expire.
 */
export function cartIsCurrent(cart: SavedCart, on: Date = new Date()): boolean {
  const today = on.toISOString().slice(0, 10);
  if (cart.validTo !== null) return cart.validTo >= today;

  const scanned = new Date(cart.at);
  if (Number.isNaN(scanned.getTime())) return false;
  const week = new Date(scanned.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  return week >= today;
}

/** Read every stored cart, dropping anything malformed rather than throwing. */
function readAll(): SavedCart[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedCart);
  } catch {
    return [];
  }
}

function isSavedCart(value: unknown): value is SavedCart {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<SavedCart>;
  return (
    typeof c.id === "string" &&
    typeof c.at === "string" &&
    typeof c.retailerId === "string" &&
    typeof c.comparison === "object" &&
    c.comparison !== null &&
    Array.isArray((c.comparison as CartComparison).lines)
  );
}

function writeAll(carts: SavedCart[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(carts));
  } catch {
    // Out of space. Drop the oldest and try once — losing the oldest cart is
    // better than silently failing to save the one just scanned.
    try {
      window.localStorage.setItem(KEY, JSON.stringify(carts.slice(0, 5)));
    } catch {
      /* Storage is unavailable entirely; the screen will show no history. */
    }
  }
}

/**
 * Save a scan, replacing the newest one when it is the same scan again.
 *
 * The results screen recomputes whenever a shelf price is typed, so a single
 * cart would otherwise write a new record on every keystroke. Same id means
 * same cart: the record is updated in place and the saving reflects the latest
 * numbers.
 */
export function saveCart(
  id: string,
  comparison: CartComparison,
  retailerId: RetailerId,
  at: Date = new Date(),
): void {
  const cart: SavedCart = {
    id,
    at: at.toISOString(),
    retailerId,
    validTo: cartValidTo(comparison),
    comparison,
  };
  const rest = readAll().filter((c) => c.id !== id);
  writeAll([cart, ...rest].slice(0, MAX_SAVED_CARTS));
}

/**
 * Every cart still worth showing, newest first — and expired ones deleted.
 *
 * The purge happens on read rather than on a timer, because a static site has
 * no timer. Opening the list is the moment somebody could otherwise see an
 * expired cart, so it is the moment it stops existing.
 */
export function listCarts(on: Date = new Date()): CartSummary[] {
  const all = readAll();
  const current = all.filter((c) => cartIsCurrent(c, on));
  if (current.length !== all.length) writeAll(current);

  return current
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((c) => ({
      id: c.id,
      at: c.at,
      retailerId: c.retailerId,
      validTo: c.validTo,
      items: c.comparison.lines.length,
      cheaper: c.comparison.cheaperElsewhere.length,
      onSale: c.comparison.onSaleElsewhere?.length ?? 0,
      totalSavingCents: c.comparison.totalSavingCents,
    }));
}

/** One cart in full, or null when it is gone or expired. */
export function getCart(id: string, on: Date = new Date()): SavedCart | null {
  const found = readAll().find((c) => c.id === id) ?? null;
  if (found === null) return null;
  return cartIsCurrent(found, on) ? found : null;
}

/** Forget one cart. */
export function deleteCart(id: string): void {
  writeAll(readAll().filter((c) => c.id !== id));
}

/** Forget all of them. */
export function deleteAllCarts(): void {
  writeAll([]);
}
