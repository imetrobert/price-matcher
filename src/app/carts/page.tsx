"use client";

/**
 * Carts you have scanned this flyer week.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * A cart scanned on Tuesday is still useful on Thursday: the flyers behind
 * it run all week, so the same items are still on sale at the same places. The
 * scan screen could only ever show the current cart, and Checkout Mode's copy
 * lived in sessionStorage, which is emptied the moment the tab closes. So the
 * ordinary act of closing a browser between the aisle and checkout lost the
 * work.
 *
 * ---------------------------------------------------------------------------
 * WHY THEY DISAPPEAR ON THEIR OWN
 * ---------------------------------------------------------------------------
 * Every price in a saved cart came from a flyer that runs for a week. The day
 * after the last of those flyers ends, none of those numbers is a price — not
 * an old price, not an approximate one, not a price. A list of expired carts
 * would be a screen full of confident wrong figures, so a cart deletes itself
 * once its flyers have run out. Opening this page is when that happens, since
 * a static site has no timer to do it on a schedule.
 *
 * Nothing here leaves the device. A shopping history says a great deal about a
 * person and this app does not need it on a server to work, so there is no
 * table holding it and nothing to leak.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AuthGuard } from "@/components/AuthGuard";
import { FlyerPageProof, FlippThumbnail } from "@/components/FlyerPageProof";
import { Money, Notice, PageHeader } from "@/components/ui";
import { ActiveFlyerPeriod } from "@/components/ActiveFlyerPeriod";
import { RETAILERS } from "@/config/retailers";
import { formatCents } from "@/lib/money";
import { citationLine } from "@/services/flyers/citation";
import {
  deleteCart,
  getCart,
  listCarts,
  type CartSummary,
  type SavedCart,
} from "@/services/carts/history";
import { itemLabel, type CartLine } from "@/services/flyers/cartMatch";
import { isMeasuredBasis } from "@/types/flyer";
import { describeBasis } from "@/types/flyer";

export default function CartsPage() {
  return (
    <AuthGuard>
      <SavedCarts />
    </AuthGuard>
  );
}

/** A stored timestamp as somebody reads it. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "at an unknown time";
  return d.toLocaleString("en-CA", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A flyer end date as a plain day. Noon UTC so it never slips back one. */
function day(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function SavedCarts() {
  const [carts, setCarts] = useState<CartSummary[] | null>(null);
  const [open, setOpen] = useState<SavedCart | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  // Reading the list is also what deletes the expired ones.
  const refresh = useCallback(() => setCarts(listCarts()), []);

  useEffect(() => refresh(), [refresh]);

  if (carts === null) return null;

  if (open !== null) {
    return <CartDetail cart={open} onBack={() => setOpen(null)} />;
  }

  return (
    <main className="mx-auto max-w-[900px]">
      <PageHeader
        title="Saved carts"
        subtitle="Scans from this flyer week. They delete themselves when the flyers expire."
        backHref="/"
      />

      <ActiveFlyerPeriod />

      {carts.length === 0 ? (
        <div className="mb-4">
          <Notice tone="warn" title="No saved carts">
            Scan a cart and it is kept here until the flyers behind it stop
            running. Carts are stored on this device only — they are not synced,
            and clearing your browsing data removes them.
          </Notice>
          <Link href="/scan" className="btn-primary mt-3">
            Scan a cart
          </Link>
        </div>
      ) : null}

      <div className="space-y-3">
        {carts.map((c) => {
          const store = RETAILERS[c.retailerId]?.displayName ?? c.retailerId;
          return (
            <section key={c.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold leading-tight">{store}</p>
                  <p className="text-xs text-muted">{when(c.at)}</p>
                </div>
                <div className="shrink-0 text-right">
                  {c.totalSavingCents > 0 ? (
                    <>
                      <span className="block text-lg font-extrabold text-good">
                        {formatCents(c.totalSavingCents)}
                      </span>
                      <span className="text-xs text-muted">found</span>
                    </>
                  ) : (
                    // No number invented where none was computed. A cart of
                    // "may be cheaper" lines has a real value and it is not a
                    // dollar figure.
                    <span className="text-xs text-muted">no computed saving</span>
                  )}
                </div>
              </div>

              <p className="mt-2 text-sm">
                {c.items} item{c.items === 1 ? "" : "s"} · {c.cheaper} cheaper
                elsewhere · {c.onSale} on sale elsewhere
              </p>

              {c.validTo ? (
                <p className="mt-1 text-xs text-muted">
                  Flyers run to {day(c.validTo)} — this cart deletes itself after
                  that.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted">
                  Nothing in this cart matched a flyer, so it is kept for a week.
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    const full = getCart(c.id);
                    if (full) setOpen(full);
                    else refresh();
                  }}
                >
                  Open
                </button>

                {confirming === c.id ? (
                  <>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setConfirming(null)}
                    >
                      Keep it
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-bad"
                      onClick={() => {
                        deleteCart(c.id);
                        setConfirming(null);
                        refresh();
                      }}
                    >
                      Yes, delete
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn-ghost text-bad"
                    onClick={() => setConfirming(c.id)}
                  >
                    Delete cart
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {carts.length > 0 ? (
        <p className="mt-4 text-xs text-muted">
          Saved on this device only. Nothing about what you buy is sent
          anywhere, and clearing your browsing data removes these.
        </p>
      ) : null}
    </main>
  );
}

/**
 * One saved cart, read-only.
 *
 * Deliberately not the live results screen. That screen can recompute, accept
 * a typed shelf price and move a line between sections; this is a record of
 * what was true when the cart was scanned, and letting it be edited would make
 * it a worse record without making it a better screen.
 */
function CartDetail({ cart, onBack }: { cart: SavedCart; onBack: () => void }) {
  const here = RETAILERS[cart.retailerId]?.displayName ?? cart.retailerId;
  const c = cart.comparison;

  return (
    <main className="mx-auto max-w-[900px]">
      <button type="button" className="mb-3 text-sm font-semibold text-brand" onClick={onBack}>
        ← All saved carts
      </button>

      <h1 className="text-2xl font-extrabold">{here}</h1>
      <p className="mb-4 text-sm text-muted">
        Scanned {when(cart.at)}
        {cart.validTo ? ` · flyers run to ${day(cart.validTo)}` : ""}
      </p>

      {c.totalSavingCents > 0 ? (
        <div className="card mb-4">
          <p className="text-lg font-bold text-good">
            <Money cents={c.totalSavingCents} /> across this cart
          </p>
          <p className="mt-1 text-xs text-muted">
            Only lines where both prices were known are counted.
          </p>
        </div>
      ) : null}

      <Group
        title="Cheaper at another store"
        note="Both prices were known, so the gap is arithmetic."
        lines={c.cheaperElsewhere}
        here={here}
        showSaving
      />

      <Group
        title="On sale elsewhere — may be cheaper than your price"
        note={`${here} did not advertise these, so no saving could be computed.`}
        lines={c.onSaleElsewhere ?? []}
        here={here}
        showSaving={false}
      />

      {c.bestHere.length > 0 ? (
        <div className="mb-5">
          <h2 className="mb-2 font-bold">Best price was already at {here}</h2>
          <div className="space-y-1">
            {c.bestHere.map((line) => (
              <p key={line.item.id} className="card py-2 text-sm">
                {itemLabel(line.item)}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Group({
  title,
  note,
  lines,
  here,
  showSaving,
}: {
  title: string;
  note: string;
  lines: CartLine[];
  here: string;
  showSaving: boolean;
}) {
  if (lines.length === 0) return null;

  return (
    <div className="mb-5">
      <h2 className="font-bold">{title}</h2>
      <p className="mb-2 text-xs text-muted">{note}</p>
      <div className="space-y-3">
        {lines.map((line) => {
          if (!showSaving) {
            // On sale elsewhere: source is genuinely ambiguous — a product
            // can be advertised in a flyer you scanned, on Flipp, or both,
            // at different stores. List everything rather than silently
            // picking one, so it's visible at a glance which source(s) an
            // item actually came from.
            const scanned = [...line.matches, ...line.measuredElsewhere];
            const flipp = line.uncertainElsewhere;
            if (scanned.length === 0 && flipp.length === 0) return null;

            return (
              <section key={line.item.id} className="card">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-bold leading-tight">{itemLabel(line.item)}</p>
                  <span className="shrink-0 text-xs text-warn">may be cheaper</span>
                </div>

                {scanned.length > 0 ? (
                  <div className="mt-2 rounded-md bg-surface p-2 text-xs">
                    <p className="font-semibold">From flyers you scanned</p>
                    {scanned.map((offer) => (
                      <div key={offer.id} className="mt-1">
                        <p className="flex justify-between gap-3 text-muted">
                          <span>
                            {RETAILERS[offer.retailerId]?.displayName ??
                              offer.retailerId}
                          </span>
                          <span>
                            {formatCents(offer.price)}
                            {isMeasuredBasis(offer.basis)
                              ? ` ${describeBasis(offer.basis)}`
                              : ""}{" "}
                            · p.{offer.flyerPage}
                          </span>
                        </p>
                        <p className="text-[11px]">
                          {citationLine({
                            retailerId: offer.retailerId,
                            flyerPage: offer.flyerPage,
                            validFrom: offer.validFrom,
                            validTo: offer.validTo,
                            hasPageImage: true,
                          })}
                        </p>
                        <FlyerPageProof
                          flyerId={offer.flyerId}
                          page={offer.flyerPage}
                          box={offer.box}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}

                {flipp.length > 0 ? (
                  <div className="mt-2 rounded-md bg-surface p-2 text-xs">
                    <p className="font-semibold">Also seen on Flipp (not confirmed)</p>
                    {flipp.map((offer) => (
                      <div key={offer.id} className="mt-2 flex items-start gap-2">
                        {offer.partnerImageUrl ? (
                          <FlippThumbnail url={offer.partnerImageUrl} />
                        ) : null}
                        <p className="flex-1 flex justify-between gap-3 text-muted">
                          <span>
                            {RETAILERS[offer.retailerId]?.displayName ??
                              offer.retailerId}
                          </span>
                          <span>{formatCents(offer.price)} · via Flipp</span>
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          }

          // Cheaper at another store: always one confirmed, trustworthy
          // offer — this is what the savings figure is citing, so one
          // citation is the correct amount of evidence, not less or more.
          const lead = line.bestElsewhere ?? line.measuredElsewhere?.[0] ?? null;
          if (lead === null) return null;
          const store = RETAILERS[lead.retailerId]?.displayName ?? lead.retailerId;

          return (
            <section key={line.item.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold leading-tight">{itemLabel(line.item)}</p>
                  <p className="text-xs text-muted">
                    {store} · {formatCents(lead.price)}
                    {line.bestElsewhere === null
                      ? ` ${describeBasis(lead.basis)}`
                      : ""}
                  </p>
                </div>
                <span className="shrink-0 text-lg font-extrabold text-good">
                  {line.savingCents !== null ? formatCents(line.savingCents) : null}
                </span>
              </div>

              <p className="mt-2 rounded-lg bg-surface px-2 py-1 text-xs">
                {citationLine({
                  retailerId: lead.retailerId,
                  flyerPage: lead.flyerPage,
                  validFrom: lead.validFrom,
                  validTo: lead.validTo,
                  hasPageImage: true,
                })}
              </p>

              <FlyerPageProof
                flyerId={lead.flyerId}
                page={lead.flyerPage}
                box={lead.box}
              />
            </section>
          );
        })}
      </div>
    </div>
  );
}
