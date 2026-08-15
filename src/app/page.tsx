"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AuthBar, AuthGuard } from "@/components/AuthGuard";
import { checkAppAccess } from "@/lib/auth/access";
import { Notice } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { formatCents } from "@/lib/money";
import { DEFAULT_PREFS, loadPrefs, prefsAreComplete } from "@/lib/prefs";
import {
  loadAllFlyers,
  loadAllFlyersResult,
  queueSummary,
  queueSummaryResult,
  retryFailedPages,
} from "@/services/flyers/storage";
import { flyerStatus, type FlyerStatus } from "@/services/flyers/status";
import { listCarts } from "@/services/carts/history";
import type { UserPreferences } from "@/types";

export default function HomePage() {
  return (
    <AuthGuard>
      <Home />
    </AuthGuard>
  );
}

function Home() {
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);
  const [flyers, setFlyers] = useState<FlyerStatus | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Why the week could not be checked, when it could not.
  //
  // This card used to render nothing at all if either query failed, and
  // "nothing on screen" is the same picture as "nothing to report". Worse, a
  // failed queue read looked like a finished one: green, ready, go shopping.
  // An unanswerable question has to look different from a good answer.
  const [checkFailed, setCheckFailed] = useState<string | null>(null);
  // Counted here so the link can be hidden when there is nothing behind it.
  // Reading the list is also what deletes carts whose flyers have expired.
  const [savedCarts, setSavedCarts] = useState(0);
  // The debug link is hidden from ordinary members. Cosmetic on its own — the
  // screen itself checks the same thing, and every row it can reach is
  // governed by RLS regardless — but a link nobody should follow is a link
  // worth not showing.
  const [isAdmin, setIsAdmin] = useState(false);

  // While pages are still being read, the number on this card changes without
  // anybody touching the screen — a worker is doing the work on a schedule. A
  // card that only updates on reload would look stalled while it was in fact
  // progressing, which is the impression "Finish loading" gave.
  //
  // Polling stops once the queue is empty. A stalled run has nothing to
  // report every ten seconds, and a request that can only ever return the
  // same number is a request not worth making on a phone battery.
  useEffect(() => {
    if (flyers?.readiness !== "PARTIAL" || flyers.stalled) return;

    const refreshStatus = () =>
      Promise.all([loadAllFlyers(), queueSummary()])
        .then(([all, queue]) => setFlyers(flyerStatus(all, new Date(), queue)))
        .catch(() => undefined);

    const timer = setInterval(refreshStatus, 10_000);

    // Coming back to a backgrounded tab is the common case on a phone, and it
    // is exactly when the number on screen is most out of date — several
    // minutes of reading have happened since it was last painted, and mobile
    // browsers throttle or suspend timers in background tabs, so the interval
    // above cannot be relied on to have run. Refresh on return.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [flyers?.readiness, flyers?.stalled]);

  useEffect(() => {
    setPrefs(loadPrefs());
    setSavedCarts(listCarts().length);
    // Derived from what is stored rather than from a run in progress: a run
    // lives in one browser tab, and the question "do I have this week's
    // prices" has to be answerable from anywhere, including tomorrow.
    Promise.all([loadAllFlyersResult(), queueSummaryResult()])
      .then(([flyerResult, queueResult]) => {
        if (!flyerResult.ok || !queueResult.ok) {
          setFlyers(null);
          setCheckFailed(
            flyerResult.ok
              ? (queueResult as { error: string }).error
              : flyerResult.error,
          );
          return;
        }
        setCheckFailed(null);
        setFlyers(flyerStatus(flyerResult.flyers, new Date(), queueResult.queue));
      })
      .catch((err) =>
        setCheckFailed(
          err instanceof Error ? err.message : "The check did not answer.",
        ),
      );
    void checkAppAccess()
      .then((access) =>
        setIsAdmin(access.status === "granted" && access.role === "app_admin"),
      )
      .catch(() => setIsAdmin(false));
  }, []);

  const requeue = async () => {
    setRetrying(true);
    await retryFailedPages();
    const [all, queue] = await Promise.all([loadAllFlyers(), queueSummary()]);
    setFlyers(flyerStatus(all, new Date(), queue));
    setRetrying(false);
  };

  const ready = prefsAreComplete(prefs) && prefs.currentRetailerId !== null;
  const retailer = prefs.currentRetailerId
    ? RETAILERS[prefs.currentRetailerId]
    : null;

  return (
    <main>
      <AuthBar />

      <header className="mb-5 mt-2">
        <h1 className="text-3xl font-extrabold tracking-tight">CartMatch</h1>
        <p className="mt-1 text-muted">Find price matches before you pay.</p>
      </header>

      {/*
        The first thing on the screen, because it is the first thing somebody
        wants to know before leaving the house.
      */}
      {flyers ? (
        <section
          className={`card mb-4 border ${
            flyers.readiness === "LOADED"
              ? "border-good/40"
              : flyers.readiness === "PARTIAL"
                ? "border-warn/40"
                : "border-line"
          }`}
        >
          <p
            className={`flex items-center gap-2 font-bold ${
              flyers.readiness === "LOADED"
                ? "text-good"
                : flyers.readiness === "PARTIAL"
                  ? "text-warn"
                  : ""
            }`}
          >
            {/*
              Three states, three marks — because "is it working right now?"
              is answered at a glance or not at all.

                turning ring   pages are being read
                solid disc     queued, but blocked on something outside the
                               app: a quota that resets tomorrow, most often
                (nothing)      stopped, with nothing left in the queue

              The middle one used to spin like the first, which said the work
              was in progress when it was waiting out a daily limit — the
              difference between "a few more minutes" and "tomorrow morning".
            */}
            {flyers.readiness === "PARTIAL" && !flyers.stalled ? (
              flyers.waitingReason ? (
                <span
                  aria-hidden
                  className="h-4 w-4 shrink-0 rounded-full bg-warn"
                />
              ) : (
                <span
                  aria-hidden
                  className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-warn"
                />
              )
            ) : null}
            {flyers.headline}
          </p>
          <p className="mt-1 text-sm text-muted">{flyers.detail}</p>

          {/*
            Today, on the card, beside the window it has to fall inside.

            The app already filters to flyers covering today, so a shopper
            could take "loaded" on trust. Printing the date turns that into
            something checkable at a glance — and the window is the one thing
            here that goes stale on its own while nobody touches the app, so
            it is worth being able to check rather than believe.
          */}
          {flyers.validTo ? (
            <p className="mt-2 text-xs text-muted">
              Today is {flyers.today}
              {flyers.daysLeft === 1 ? (
                <span className="font-semibold text-warn">
                  {" "}
                  — last day of this window
                </span>
              ) : flyers.daysLeft > 1 ? (
                <> — {flyers.daysLeft} days left, through {flyers.validTo ? dayLabel(flyers.validTo) : ""}</>
              ) : null}
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted">Today is {flyers.today}.</p>
          )}

          {flyers.readiness === "PARTIAL" ? (
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-line"
              role="progressbar"
              aria-valuenow={flyers.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-warn"
                style={{ width: `${flyers.percent}%` }}
              />
            </div>
          ) : null}

          {/*
            "Finish loading" asked the reader to do something already being
            done for them. Nothing here needs a person: the only reason to open
            the import screen mid-run is to add a flyer that was missed.
          */}
          {flyers.readiness === "PARTIAL" && flyers.stalled ? (
            <>
              <p className="mt-2 text-xs text-muted">
                {flyers.pagesFailed > 0
                  ? "Pages give up after five tries. If the reason has since been fixed — a model name changed, a quota reset — put them back in the queue."
                  : "Nothing is waiting to be read. Re-import the flyers that are short of pages."}
              </p>
              {flyers.pagesFailed > 0 ? (
                <button
                  type="button"
                  onClick={requeue}
                  disabled={retrying}
                  className="btn-primary mt-3 disabled:opacity-50"
                >
                  {retrying
                    ? "Queueing…"
                    : `Try the ${flyers.pagesFailed} failed ${flyers.pagesFailed === 1 ? "page" : "pages"} again`}
                </button>
              ) : null}
              <Link href="/flyers" className="btn-secondary mt-3">
                Add more flyers
              </Link>
            </>
          ) : flyers.readiness === "PARTIAL" ? (
            <>
              {/*
                A queued page that keeps being handed back — an exhausted
                daily quota does exactly this, correctly, since the page is
                fine and the key is not. Without saying so, "31%" reads as
                nearly there when the truth is tomorrow morning.
              */}
              {flyers.waitingReason ? (
                <p className="mt-2 rounded-md bg-warn/10 p-2 text-xs text-warn">
                  Waiting: {flyers.waitingReason}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-muted">
                Reading continues on its own — you can close this. The count
                updates every ten seconds, and again whenever you come back to
                this tab.
              </p>
              {/*
                The same two actions the loaded card offers, in the same place.
                Scanning is worth offering mid-read: the offers already stored
                are real, and the detail above says plainly that a page still
                unread is missing its offers rather than free of them.
              */}
              <div className="mt-3 space-y-2">
                <Link
                  href="/scan"
                  className={
                    ready
                      ? "btn-primary"
                      : "btn-primary pointer-events-none opacity-40"
                  }
                  aria-disabled={!ready}
                >
                  Scan your cart
                </Link>
                <Link href="/flyers" className="btn-secondary">
                  Add more flyers
                </Link>
              </div>
            </>
          ) : flyers.readiness === "NONE" ? (
            <Link href="/flyers" className="btn-primary mt-3">
              Upload this week&rsquo;s flyers
            </Link>
          ) : (
            /*
              Loaded is the state this screen is in most of the week, so it is
              the one worth laying out properly. The two things a person does
              from here — scan the trolley they are pushing, or add a flyer
              they have just downloaded — belong beside the sentence that says
              the flyers are ready, not scattered down the page among links
              that mean nothing until they are.

              Comparing the flyers against each other is a different kind of
              act: planning rather than shopping. It sits below the settings,
              on its own.
            */
            <div className="mt-3 space-y-2">
              <Link
                href="/scan"
                className={
                  ready
                    ? "btn-primary"
                    : "btn-primary pointer-events-none opacity-40"
                }
                aria-disabled={!ready}
              >
                Scan your cart
              </Link>
              <Link href="/flyers" className="btn-secondary">
                Import additional flyers
              </Link>
            </div>
          )}
        </section>
      ) : checkFailed ? (
        /*
          The card that used to be nothing.

          Silence here is indistinguishable from a quiet week, and this is the
          screen somebody reads before deciding whether to leave the house. It
          must not imply the answer is "no flyers" when the answer is "I could
          not ask" — and it must not offer to import, which is the action that
          answer would wrongly suggest.
        */
        <section className="card mb-4 border border-warn/40">
          <p className="font-bold text-warn">
            Could not check this week&rsquo;s flyers
          </p>
          <p className="mt-2 text-sm text-muted">{checkFailed}</p>
          <p className="mt-2 text-sm text-muted">
            This does not mean your flyers are gone — it means this screen could
            not reach them. Reload the page. If it keeps happening, check that
            you are still signed in before importing anything again.
          </p>
        </section>
      ) : null}

      <section className="card mb-4">
        <Row label="Current store" value={retailer?.displayName ?? "Not set"} />
        <Row label="Postal code" value={prefs.postalCode || "Not set"} />
        <Row
          label="Minimum savings"
          value={formatCents(prefs.minSavingsCents)}
        />
        <Link href="/setup" className="btn-secondary mt-3">
          {ready ? "Change settings" : "Set up"}
        </Link>
      </section>

      {/*
        The card above owns everything to do with loading flyers, in all three
        states, so nothing down here repeats it. Two buttons for one
        destination is how "Add more flyers" and "Import this week's flyers"
        ended up on the same screen.

        What is left is the planning question — what is cheaper where, across
        every flyer held — which belongs nowhere near the card about loading
        them. With nothing loaded it can only report that, so it waits.
      */}
      {flyers && flyers.readiness !== "NONE" ? (
        <Link href="/deals" className="btn-secondary">
          Compare flyer savings
        </Link>
      ) : null}

      {/*
        Only when there is something to look at. A link to an empty list is a
        promise of a feature rather than a way to reach one.
      */}
      {savedCarts > 0 ? (
        <Link href="/carts" className="btn-secondary mt-2">
          Saved carts ({savedCarts})
        </Link>
      ) : null}

      {!ready ? (
        <div className="mt-4">
          <Notice tone="warn" title="Finish setup first">
            Add your postal code and choose the store you are shopping at.
          </Notice>
        </div>
      ) : null}

      {/*
        The adapter health list lived here: six retailers, all reporting
        MOCK_ONLY, on the screen somebody opens to ask whether this week's
        flyers are loaded. It answered a question nobody was asking and
        crowded out the one they were.

        Prices in this app now come from flyers a person uploaded, and their
        status is the card at the top. Adapter health is a debugging concern,
        so it lives where debugging lives.
      */}
      {isAdmin ? (
        <Link href="/admin" className="btn-ghost mt-6">
          Developer / debug view
        </Link>
      ) : null}
    </main>
  );
}

/** The same reading of a date the status uses, for the end of the window. */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-sm text-muted">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}
