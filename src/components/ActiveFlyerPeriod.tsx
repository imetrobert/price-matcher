"use client";

/**
 * Today's date and the current flyer week, shown the same way on every
 * shopping screen — not just the home screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM flyerStatus()
 * ---------------------------------------------------------------------------
 * flyerStatus() answers "how much of MY OWN scanned flyers is read" — a
 * progress question, scoped to one source. This answers a narrower, more
 * universal question: "what week is it, price-wise, right now" — which
 * applies whether the prices on screen came from a scanned flyer, from
 * Flipp, or (soon) from neither. A shopper on the deals screen or mid-scan
 * should not have to go back to the home screen to check whether the
 * flyers on screen are this week's or last week's.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE WINDOW COMES FROM
 * ---------------------------------------------------------------------------
 * Prefers the scanned-flyer window when any flyer covers today, since a
 * photographed flyer's dates are exact. Falls back to Flipp's window when
 * nothing has been scanned. Shows just today's date, plainly, when neither
 * source has anything — that is still true and still worth saying.
 */

import { useEffect, useState } from "react";
import {
  loadAllFlyersResult,
  loadFlippWindowThisWeek,
} from "@/services/flyers/storage";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function readableDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function ActiveFlyerPeriod() {
  const [window, setWindow] = useState<{
    validFrom: string;
    validTo: string;
    source: "SCAN" | "FLIPP";
  } | null>(null);
  // null = still loading, undefined-equivalent "checked, found nothing" is
  // represented by window staying null after loaded flips true.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    const today = todayIso();

    void loadAllFlyersResult()
      .then((r) => {
        if (!live) return;
        const current = r.ok
          ? r.flyers.filter((f) => f.validFrom <= today && today <= f.validTo)
          : [];
        if (current.length > 0) {
          const validFrom = current.map((f) => f.validFrom).sort()[0]!;
          const validTo = current
            .map((f) => f.validTo)
            .sort()
            .slice(-1)[0]!;
          setWindow({ validFrom, validTo, source: "SCAN" });
          setLoaded(true);
          return;
        }
        // Nothing scanned covers today — try Flipp's window before giving up.
        void loadFlippWindowThisWeek()
          .then((flippWindow) => {
            if (!live) return;
            setWindow(
              flippWindow
                ? { ...flippWindow, source: "FLIPP" }
                : null,
            );
            setLoaded(true);
          })
          .catch(() => {
            if (live) setLoaded(true);
          });
      })
      .catch(() => {
        if (live) setLoaded(true);
      });

    return () => {
      live = false;
    };
  }, []);

  const today = readableDay(todayIso());

  return (
    <p className="mb-4 text-sm font-semibold text-muted">
      {!loaded
        ? `Today is ${today}.`
        : window
          ? `Today is ${today} · this week's flyers run ${readableDay(window.validFrom)}\u2013${readableDay(window.validTo)}${window.source === "FLIPP" ? " (via Flipp)" : ""}`
          : `Today is ${today} · no flyer window found yet.`}
    </p>
  );
}
