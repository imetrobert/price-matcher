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
 * photographed flyer's dates are exact and genuinely span one week. Falls
 * back to the calendar's own Thursday-to-Wednesday week when nothing has
 * been scanned — NOT to Flipp's own stored dates, which can span far wider
 * than a week on offers tied to a longer-running promotion or catalog. The
 * calendar is always right; the widest matching row in the database is not.
 */

import { useEffect, useState } from "react";
import { loadAllFlyersResult } from "@/services/flyers/storage";
import { currentWeekWindow } from "@/services/flyers/status";

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
        } else {
          // Nothing scanned covers today. Rather than ask the database what
          // Flipp's window is — fragile, since one long-running promotion on
          // the feed can stretch it to months — the calendar itself defines
          // the week. This is always right, and never needs a query.
          setWindow({ ...currentWeekWindow(), source: "FLIPP" });
        }
        setLoaded(true);
      })
      .catch(() => {
        if (live) {
          setWindow({ ...currentWeekWindow(), source: "FLIPP" });
          setLoaded(true);
        }
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
