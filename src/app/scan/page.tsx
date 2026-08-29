"use client";

/**
 * The main flow: photo -> confirm -> results.
 *
 * Kept as one client component with an explicit `step` so the confirmed cart
 * survives between stages without a round trip or a store. Recognition and
 * comparison are separate requests, so the user sees products to confirm while
 * nothing is being priced yet.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ProofSheet } from "@/components/ProofSheet";
import { AuthGuard } from "@/components/AuthGuard";
import { FlyerPageProof } from "@/components/FlyerPageProof";
import { MockBanner, Money, Notice, PageHeader, Spinner } from "@/components/ui";
import { ActiveFlyerPeriod } from "@/components/ActiveFlyerPeriod";
import { RETAILERS } from "@/config/retailers";
import { formatCents, tryParsePriceToCents } from "@/lib/money";
import { DEFAULT_PREFS, clearLastResult, loadPrefs, saveLastResult } from "@/lib/prefs";
import { deleteCart, saveCart } from "@/services/carts/history";
import {
  applyCorrection,
  fingerprintOf,
  loadCorrections,
  pickCorrection,
  saveCorrection,
} from "@/services/products/corrections";
import { analyzeCartPhotos } from "@/services/vision";
import {
  describeBytes,
  shrinkForVision,
  RETRY_MAX_EDGE,
  RETRY_QUALITY,
  type ShrunkImage,
} from "@/services/vision/downscale";
import type { CoverageReport } from "@/services/vision/schema";
import {
  compareCartToFlyers,
  itemLabel,
  needsConfirming,
  NEEDS_A_LOOK_BELOW,
  type CartComparison,
  type CartLine,
} from "@/services/flyers/cartMatch";
import {
  loadCurrentOffers,
  loadCurrentFlippOffers,
  type StoredOffer,
} from "@/services/flyers/storage";
import { citationLine } from "@/services/flyers/citation";
import { conditionLabel, describeBasis } from "@/types/flyer";
import type { Cents, DetectedProduct, RetailerId, UserPreferences } from "@/types";

type Step = "capture" | "confirm" | "results";

/**
 * Photographs per round, not per cart.
 *
 * Four at once was the shape that timed out, and it was also the wrong
 * interaction: it asked somebody to guess up front how many angles a trolley
 * needs. Two is a round. A round comes back quickly, says what it found and
 * what it could not see, and invites another — as many as it takes, each one
 * small enough to survive a shop's signal.
 */
const PHOTOS_PER_ROUND = 2;

interface EditableItem extends DetectedProduct {
  include: boolean;
  manualPrice: string;
  /**
   * Fields filled from a correction somebody typed before, and the reading
   * that correction was keyed to.
   *
   * Both travel with the item: the first so the card can say where a value
   * came from, the second so a further correction updates the same row instead
   * of keying itself to the corrected reading — which would never be produced
   * by a camera again, and so would never be found.
   */
  correctedFields: string[];
  fingerprint: string | null;
}

export default function ScanPage() {
  return (
    <AuthGuard>
      <ScanFlow />
    </AuthGuard>
  );
}

function ScanFlow() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);
  const [step, setStep] = useState<Step>("capture");
  const [images, setImages] = useState<ShrunkImage[]>([]);
  /**
   * This trolley's identity in the saved list.
   *
   * Minted when a scan produces results and kept until the cart is discarded.
   * The comparison is recomputed on every typed shelf price, so without a
   * stable id one trolley would write a new saved record per keystroke.
   */
  const [cartId, setCartId] = useState<string | null>(null);
  const [items, setItems] = useState<EditableItem[]>([]);
  const [cart, setCart] = useState<CartComparison | null>(null);
  const [offerCount, setOfferCount] = useState<number | null>(null);
  // The offers themselves, not just how many. Typing a shelf price has to
  // recompute the comparison on the spot, and refetching the week's flyers on
  // every keystroke is not a thing to do to somebody's phone in a shop.
  const [offers, setOffers] = useState<StoredOffer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visionNote, setVisionNote] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<CoverageReport>({ obscured: 0, note: null });
  const fileRef = useRef<HTMLInputElement>(null);
  /** The library picker. See the note beside the inputs for why it is separate. */
  const libraryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const p = loadPrefs();
    setPrefs(p);
    if (!p.postalCode || !p.currentRetailerId) router.replace("/setup");
  }, [router]);

  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    // Shrunk here, before anything else touches them. A camera photo is 3–4 MB
    // and four of those was twenty megabytes going up a shop's mobile signal
    // inside a 45-second budget — which is what the timeouts actually were.
    const next: ShrunkImage[] = [];
    for (const file of Array.from(files).slice(0, PHOTOS_PER_ROUND)) {
      next.push(await shrinkForVision(file));
    }
    setImages((prev) => [...prev, ...next].slice(0, PHOTOS_PER_ROUND));
  }, []);

  async function recognize() {
    if (images.length === 0) {
      setError("Take at least one photo of your cart first.");
      return;
    }
    setBusy("Reading your cart…");
    setError(null);
    try {
      // What earlier rounds already found, so this one is asked the small
      // question — "what is here that we have not got yet" — instead of being
      // made to re-describe the whole trolley.
      const known = items
        .filter((i) => i.include)
        .map((i) => ({
          brand: i.brand,
          productName: i.productName,
          size: i.size,
        }));

      let outcome = await analyzeCartPhotos(
        images.map((i) => ({ base64: i.base64, mimeType: i.mimeType })),
        { known },
      );

      // One retry, smaller, and only for a timeout. A worse photo that arrives
      // beats a better one that does not — and anything else that failed will
      // fail again the same way, so retrying it would just spend the day's
      // allowance twice.
      if (!outcome.ok && /timed out/i.test(outcome.error) && images.length > 0) {
        setBusy("That timed out — trying once more with a smaller photo…");
        const first = images[0]?.source;
        if (first) {
          const smaller = await shrinkForVision(first, RETRY_MAX_EDGE, RETRY_QUALITY);
          outcome = await analyzeCartPhotos(
            [{ base64: smaller.base64, mimeType: smaller.mimeType }],
            { known },
          );
        }
      }
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      const detected = outcome.products;
      if (detected.length === 0) {
        // Empty means two different things now, and they must not share a
        // message. With nothing known yet it is a failed reading. With items
        // already in the cart the model was asked for NEW products only, and
        // "none" is a correct answer — the photo showed what you already had.
        if (known.length > 0) {
          setVisionNote(
            "Nothing new in that photo — everything it could see is already in your cart.",
          );
          setImages([]);
          setStep("confirm");
          return;
        }
        setError("No products detected. Try a closer or better-lit photo.");
        return;
      }
      setVisionNote(outcome.note);
      // Accumulated across photos. A second angle that reveals what the first
      // hid should lower this, so the count is replaced per run rather than
      // summed — but a second photo of a DIFFERENT part of the cart adds its
      // own hidden items, so the larger of the two is the honest figure.
      setCoverage((prev) => ({
        obscured: Math.max(prev.obscured, outcome.coverage.obscured),
        note: outcome.coverage.note ?? prev.note,
      }));
      // Appended, not replaced. Photographing a missed item is the second half
      // of "what did the camera catch" — a shopper who spots a gap in the list
      // must be able to fill it without losing everything already confirmed.
      /*
        Apply what anybody has already fixed about these exact readings.

        One query for the whole batch, before the list is shown, so a product
        somebody corrected last week arrives correct rather than arriving wrong
        and being corrected again. A failure here is silent by design: the
        corrections are an improvement, and a trolley must still compare
        without them.
      */
      const prints = detected.map((d) => fingerprintOf(d));
      const fixes = await loadCorrections(
        prints.filter((p): p is string => p !== null),
      ).catch(() => new Map<string, never[]>());

      setItems((prev) => [
        ...prev,
        ...detected.map((d, i) => {
          const fingerprint = prints[i] ?? null;
          const rows = fingerprint ? (fixes.get(fingerprint) ?? []) : [];
          const correction = pickCorrection(rows);
          const { correctedFields, ...patch } = correction
            ? applyCorrection(d, correction)
            : { correctedFields: [] as string[] };
          return {
            ...d,
            ...patch,
            include: true,
            manualPrice: "",
            correctedFields,
            fingerprint,
          };
        }),
      ]);
      setImages([]);
      setStep("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recognition failed.");
    } finally {
      setBusy(null);
    }
  }

  async function compare() {
    const chosen = items.filter((i) => i.include);
    if (chosen.length === 0) {
      setError("Keep at least one product to compare.");
      return;
    }
    setBusy("Checking this week's flyers…");
    setError(null);
    try {
      // Against the flyers this shopper loaded, plus this week's Flipp feed.
      // Every price behind a personal flyer offer was printed in a document
      // they hold and can show at a till; Flipp offers carry no such
      // guarantee and are marked SOURCE_UNCERTAIN so they never get treated
      // the same way downstream.
      const [personal, flipp] = await Promise.all([
        loadCurrentOffers(),
        loadCurrentFlippOffers(),
      ]);
      const loaded = [...personal, ...flipp];
      setOffers(loaded);
      setOfferCount(loaded.length);
      setCartId((id) => id ?? `cart-${Date.now()}`);
      setStep("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Comparison failed.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * The comparison, recomputed whenever the cart or a typed price changes.
   *
   * It used to be computed once and frozen into state. That was fine while
   * nothing on the results screen could change an input — but a shelf price
   * typed in IS an input, and the whole value of typing one is watching the
   * line turn from "may be cheaper" into a number. So it is derived.
   *
   * The flyers are fetched once, into `offers`, and never refetched here.
   */
  useEffect(() => {
    if (step !== "results" || !prefs.currentRetailerId) return;
    const chosen = items.filter((i) => i.include);
    if (chosen.length === 0) return;

    const enteredPrices: Record<string, Cents | null> = {};
    for (const it of chosen) {
      // A price is only a price once it parses. Half-typed "4." is not a
      // number and must not briefly compare as one.
      enteredPrices[it.id] = it.manualPrice.trim()
        ? tryParsePriceToCents(it.manualPrice)
        : null;
    }

    const comparison = compareCartToFlyers(
      chosen,
      offers,
      prefs.currentRetailerId,
      { enteredPrices },
    );
    setCart(comparison);
    // Kept for Checkout Mode, which shows one match at a time at a till.
    saveLastResult({
      comparison,
      currentRetailer: prefs.currentRetailerId,
      at: new Date().toISOString(),
    });
    // And kept for the saved list, which outlives this tab. Same id every
    // time, so typing a price updates this cart rather than adding another.
    if (cartId) saveCart(cartId, comparison, prefs.currentRetailerId);
  }, [step, items, offers, prefs.currentRetailerId, cartId]);

  /**
   * Set a shelf price without claiming the identity was confirmed.
   *
   * Deliberately not patchItem: that marks userConfirmed, because editing a
   * product card IS confirming it. Typing what something costs says nothing
   * about whether the camera read the right product, and conflating the two
   * would quietly clear a "please look at this" warning.
   */
  const setPrice = (id: string, manualPrice: string) =>
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, manualPrice } : it)),
    );

  // The shelf price is no longer asked for as a precondition. This screen
  // compares flyer against flyer; what the current store charges only enters
  // when that store advertised the item, and then it comes from its own flyer
  // rather than from somebody squinting at a tag.
  /** Everything earlier rounds kept — what the capture step must not hide. */
  const keptItems = items.filter((i) => i.include);

  /**
   * Throw the cart away — all of it, everywhere it lives.
   *
   * The important part is `clearLastResult`. A comparison is written to local
   * storage for Checkout Mode, which shows one match at a time in large type
   * at a till. Resetting the screen without clearing that left the previous
   * trolley's comparison sitting there, ready to be shown to a cashier by
   * somebody who believed they had started over. The screen said empty and
   * the till screen said $2.40 off a jar of coffee that is not in the cart.
   *
   * So this is deliberately one function rather than four screens each
   * remembering to clear four things.
   */
  const startNewCart = useCallback(() => {
    // The saved copy goes too. "Start a new cart" has to mean the old one is
    // gone, not that it quietly moved to a list nobody was told about.
    if (cartId) deleteCart(cartId);
    setCartId(null);
    setItems([]);
    setImages([]);
    setCart(null);
    setOffers([]);
    setOfferCount(null);
    setCoverage({ obscured: 0, note: null });
    setVisionNote(null);
    setError(null);
    clearLastResult();
    setStep("capture");
  }, [cartId]);

  const unsure = items.filter((i) => i.include && needsConfirming(i));
  const clear = items.filter((i) => i.include && !needsConfirming(i));

  // Editing a card IS the confirmation. Somebody who has typed the brand in
  // has looked at the item, and asking them to then tick a box to say so is a
  // second action for a decision they already made.
  const patchItem = (id: string, patch: Partial<EditableItem>) =>
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const next = { ...it, ...patch, userConfirmed: true };

        /*
          Remember it, keyed to the reading it corrected.

          `it.fingerprint` rather than one computed from `next`: the key has to
          be what the CAMERA produced, because that is what the camera will
          produce again next week. Keying to the corrected values would store a
          fix under a reading no photograph ever generates, and it would never
          be found.

          Fire and forget. Somebody standing in a shop correcting a name is not
          waiting on a round trip, and a failed save costs the improvement, not
          the scan.
        */
        if (it.fingerprint) {
          const touchesIdentity =
            "brand" in patch ||
            "productName" in patch ||
            "variant" in patch ||
            "size" in patch;
          if (touchesIdentity) {
            void saveCorrection(it.fingerprint, {
              brand: next.brand,
              productName: next.productName,
              variant: next.variant,
              size: next.size,
            }).catch(() => undefined);
          }
        }

        return next;
      }),
    );

  return (
    <main>
      <PageHeader
        title={
          step === "capture"
            ? "Scan your cart"
            : step === "confirm"
              ? "Confirm products"
              : "Your cart"
        }
        subtitle={
          prefs.currentRetailerId
            ? `Shopping at ${RETAILERS[prefs.currentRetailerId].displayName} · ${prefs.postalCode}`
            : undefined
        }
        backHref="/"
      />

      <ActiveFlyerPeriod />

      <MockBanner
        visible={Boolean(items[0]?.isMock)}
        note="The camera reading came from test fixtures, so these products are invented. Flyer prices are unaffected."
      />

      {error ? (
        <div className="mb-4">
          <Notice tone="error" title="Something went wrong">
            {error}
          </Notice>
        </div>
      ) : null}

      {busy ? (
        <div className="card mb-4">
          <Spinner label={busy} />
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {step === "capture" ? (
        <section>
          {/*
            What the cart already holds, said before another photo is taken.

            Going back for a second angle used to look exactly like starting
            over: the item list was off-screen, nothing on this step mentioned
            it, and the only way to find out that work had been kept was to
            finish another round and see. It was kept — that was never the bug.
            Not saying so was.
          */}
          {keptItems.length > 0 ? (
            <div className="card mb-4 border border-good/40">
              <p className="font-bold text-good">
                {keptItems.length} item{keptItems.length === 1 ? "" : "s"} already
                in this cart
              </p>
              <p className="mt-1 text-sm text-muted">
                Another photo ADDS to them. Nothing you have confirmed is lost,
                and the next round is told what is already accounted for so it
                only looks for what is missing.
              </p>
              {coverage.obscured > 0 ? (
                <p className="mt-2 rounded-md bg-warn/10 p-2 text-xs text-warn">
                  {/*
                    Across every round, not the last one — the count is kept as
                    the highest any round reported, so attributing it to "last
                    round" would be a false claim about which photo said it.
                  */}
                  The camera has seen {coverage.obscured} item
                  {coverage.obscured === 1 ? "" : "s"} it could not identify
                  {coverage.note ? `: ${coverage.note}` : ""}. That is what
                  another angle is for.
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setStep("confirm")}
                >
                  Done — review {keptItems.length} item
                  {keptItems.length === 1 ? "" : "s"}
                </button>
                <StartOver count={keptItems.length} onConfirm={startNewCart} />
              </div>
            </div>
          ) : null}

          <div className="card mb-4">
            <p className="text-sm text-muted">
              {keptItems.length === 0
                ? `One clear photo is usually enough. Up to ${PHOTOS_PER_ROUND} at a time — you can come back for more angles, or use a picture already on this device.`
                : `Photograph what the last round missed. Up to ${PHOTOS_PER_ROUND} at a time.`}
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
            {/*
              The same input without `capture`, and that one attribute is the
              entire difference: with it, a phone opens the camera and gives
              you no way back to the library; without it, it opens the library.
              One input cannot be both, which is why there are two.
            */}
            <input
              ref={libraryRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
            <button
              type="button"
              className="btn-primary mt-3"
              disabled={images.length >= PHOTOS_PER_ROUND}
              onClick={() => fileRef.current?.click()}
            >
              {images.length === 0
                ? keptItems.length === 0
                  ? "Take a photo of your cart"
                  : "Photograph another angle"
                : images.length >= PHOTOS_PER_ROUND
                  ? `${PHOTOS_PER_ROUND} photos ready — read them`
                  : "Add one more photo"}
            </button>

            {/*
              Secondary, and deliberately so. Photographing the trolley you are
              pushing is the thing this screen is for; choosing an existing
              picture is for the person who already has one — a photo taken in
              the aisle before opening the app, a shelf snapped last night, a
              screenshot of a list. Same pipeline either way: both inputs land
              in onFiles, get shrunk, and count against the same two per round.
            */}
            <button
              type="button"
              className="btn-secondary mt-2"
              disabled={images.length >= PHOTOS_PER_ROUND}
              onClick={() => libraryRef.current?.click()}
            >
              Upload a photo from this device
            </button>
          </div>

          {images.length > 0 ? (
            <div className="mb-4 grid grid-cols-2 gap-2">
              {images.map((img, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <figure key={i}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.preview}
                    alt={`Cart photo ${i + 1}`}
                    className="h-32 w-full rounded-xl border border-line object-cover"
                  />
                  <figcaption className="mt-1 text-center text-xs text-muted">
                    {describeBytes(img.bytes)} to send
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            className="btn-primary"
            disabled={images.length === 0 || busy !== null}
            onClick={recognize}
          >
            Identify products
          </button>
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {step === "confirm" ? (
        <section>
          {visionNote ? (
            <p className="mb-3 text-xs text-muted">{visionNote}</p>
          ) : null}

          {/*
            What the camera caught, and what it did not — split, because they
            need different things from the reader.

            A confident reading needs a glance. An uncertain one needs a
            decision, and burying it in a list of twenty identical cards is how
            it gets waved through. The uncertain ones go first and say so.
          */}
          <div className="card mb-4">
            <p className="font-bold">
              {items.length} item{items.length === 1 ? "" : "s"} read from your
              photos
            </p>
            <p className="mt-1 text-sm text-muted">
              {unsure.length === 0
                ? "All of them were read clearly. Correct anything that looks wrong."
                : `${unsure.length} could not be read confidently — check ${unsure.length === 1 ? "it" : "those"} first.`}
            </p>

            <CoverageNote coverage={coverage} />

            {/*
              Bulk approval for the confident ones, so the shopper's attention
              goes where it is worth something. Approving a card here is the
              same claim as editing one — "I looked, this is right" — and the
              button says how many and at what confidence rather than asking
              for a blanket yes.
            */}
            {clear.length > 0 && clear.some((i) => !i.userConfirmed) ? (
              <button
                type="button"
                className="btn-secondary mt-3"
                onClick={() =>
                  setItems((prev) =>
                    prev.map((it) =>
                      needsConfirming(it) ? it : { ...it, userConfirmed: true },
                    ),
                  )
                }
              >
                Accept the {clear.filter((i) => !i.userConfirmed).length} read
                clearly
              </button>
            ) : null}
            <button
              type="button"
              className="btn-secondary mt-3"
              onClick={() => setStep("capture")}
            >
              Photograph something it missed
            </button>
          </div>

          {unsure.length > 0 ? (
            <div className="mb-4">
              <SectionHeading
                title="Check these"
                note="Low confidence, or the product name could not be read. Correct or remove them — a misread product is worse than one left out."
              />
              <div className="space-y-3">
                {unsure.map((item) => (
                  <ConfirmCard
                    key={item.id}
                    item={item}
                    onChange={(patch) => patchItem(item.id, patch)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {clear.length > 0 ? (
            <div className="mb-4">
              <SectionHeading
                title="Read clearly"
                note="Edit any of these if the camera got a detail wrong."
              />
              <div className="space-y-3">
                {clear.map((item) => (
                  <ConfirmCard
                    key={item.id}
                    item={item}
                    onChange={(patch) => patchItem(item.id, patch)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <button
            type="button"
            className="btn-primary mt-4"
            disabled={busy !== null}
            onClick={compare}
          >
            Check against this week&rsquo;s flyers
          </button>
          <button
            type="button"
            className="btn-secondary mt-2"
            onClick={() => setStep("capture")}
          >
            Back to photos
          </button>
          {/*
            Also here, because this is the screen where somebody realises the
            photo caught the wrong trolley or the list is beyond fixing.
          */}
          <div className="mt-2">
            <StartOver count={keptItems.length} onConfirm={startNewCart} />
          </div>
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {step === "results" && cart ? (
        <CartResults
          cart={cart}
          currentRetailer={prefs.currentRetailerId!}
          offerCount={offerCount ?? 0}
          coverage={coverage}
          priceOf={(id) => items.find((i) => i.id === id)?.manualPrice ?? ""}
          setPrice={setPrice}
          onRescan={startNewCart}
          onAddMore={() => setStep("capture")}
        />
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------

function ConfirmCard({
  item,
  onChange,
}: {
  item: EditableItem;
  onChange: (patch: Partial<EditableItem>) => void;
}) {
  return (
    <div className={`card ${item.include ? "" : "opacity-50"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold leading-tight">
            {[item.brand, item.productName].filter(Boolean).join(" ") ||
              "Could not read this package"}
          </p>
          <p className="text-sm text-muted">
            {[item.variant, item.size, item.fatPercentage ? `${item.fatPercentage}%` : null]
              .filter(Boolean)
              .join(" · ") || "Details unread"}
          </p>
          <p className="mt-1 text-xs text-muted">
            <ConfidenceBadge item={item} />
            {item.notes ? ` · ${item.notes}` : ""}
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 text-sm font-semibold text-muted underline"
          onClick={() => onChange({ include: !item.include })}
        >
          {item.include ? "Remove" : "Add back"}
        </button>
      </div>

      {item.include ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Field
            label="Brand"
            value={item.brand ?? ""}
            onChange={(v) => onChange({ brand: v || null })}
          />
          <Field
            label="Product"
            value={item.productName ?? ""}
            onChange={(v) => onChange({ productName: v || null })}
          />
          <Field
            label="Variant"
            value={item.variant ?? ""}
            onChange={(v) => onChange({ variant: v || null })}
          />
          <div>
            <Field
              label="Size"
              value={item.size ?? ""}
              onChange={(v) => onChange({ size: v || null })}
              // Not a plausible size. A grey "650 g" in an empty box reads as
              // a value at a glance, which is the worst thing a placeholder
              // can do on a screen about not inventing numbers.
              placeholder="type what the label says"
            />
            <SizeHelp item={item} onUse={(size) => onChange({ size })} />
            <CorrectedNote item={item} />
          </div>
          <Field
            label="Qty in cart"
            value={String(item.packageQuantity ?? 1)}
            onChange={(v) =>
              onChange({ packageQuantity: Number.parseInt(v, 10) || 1 })
            }
            inputMode="numeric"
          />
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "decimal";
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-muted">{label}</span>
      <input
        className="field !min-h-[44px] text-sm"
        value={value}
        placeholder={placeholder}
        inputMode={inputMode ?? "text"}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// THE RESULTS
// ---------------------------------------------------------------------------
//
// Three sections, in the order a shopper's attention should go, and only one
// of them opens up. "Cheaper somewhere else" is the only outcome that asks
// anything of them; the other two are told plainly and then left alone.
//
// Everything shown here traces to a document the shopper is holding — a flyer
// they loaded, a page number, a run of dates. That is what a price-match desk
// asks for, and it is the whole reason this screen no longer talks to a
// retailer API.

function CartResults({
  cart,
  currentRetailer,
  offerCount,
  coverage,
  priceOf,
  setPrice,
  onRescan,
  onAddMore,
}: {
  /** The text currently typed for an item's shelf price, if any. */
  priceOf: (id: string) => string;
  setPrice: (id: string, value: string) => void;
  cart: CartComparison;
  currentRetailer: RetailerId;
  offerCount: number;
  coverage: CoverageReport;
  onRescan: () => void;
  onAddMore: () => void;
}) {
  const here = RETAILERS[currentRetailer]?.displayName ?? currentRetailer;

  return (
    <section>
      <div className="card mb-4">
        {/*
          The headline counts BOTH answers, because a trolley where nothing has
          a computed saving but four things are on sale elsewhere is not a
          trolley with nothing to report — and that is precisely what the old
          headline said.
        */}
        <p className="text-2xl font-extrabold">
          {cart.cheaperElsewhere.length + cart.onSaleElsewhere.length === 0
            ? "Nothing in your cart is on sale elsewhere"
            : `${cart.cheaperElsewhere.length + cart.onSaleElsewhere.length} item${
                cart.cheaperElsewhere.length + cart.onSaleElsewhere.length === 1
                  ? " is"
                  : "s are"
              } on sale at another store`}
        </p>
        {cart.totalSavingCents > 0 ? (
          <p className="text-lg font-bold text-good">
            Up to <Money cents={cart.totalSavingCents} /> across your cart
          </p>
        ) : null}
        <p className="mt-1 text-xs text-muted">
          {cart.lines.length} item{cart.lines.length === 1 ? "" : "s"} checked
          against {offerCount} offers from this week&rsquo;s flyers. Only
          products advertised in a flyer you loaded can appear here.
        </p>

        {/*
          Repeated on the results, not only on the confirm step. This is where
          somebody decides they are done, and "nothing else is cheaper" reads
          very differently when three items were never looked at.
        */}
        <CoverageNote coverage={coverage} />
      </div>

      {/*
        First, because it is the only section with a number somebody can act on
        without doing any more work. It is also the smaller of the two: a
        computed saving needs both sides known.
      */}
      {cart.cheaperElsewhere.length > 0 ? (
        <div className="mb-5">
          <SectionHeading
            title="Cheaper at another store"
            note="Both prices are known, so the gap is arithmetic. Open one to see the flyer page and the dates it runs — what a price-match desk asks for."
          />
          <div className="space-y-3">
            {cart.cheaperElsewhere.map((line) => (
              <CheaperCard
                key={line.item.id}
                line={line}
                here={here}
                priceText={priceOf(line.item.id)}
                onPrice={(v) => setPrice(line.item.id, v)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/*
        The section this screen exists for.

        Somebody else advertised it and nobody knows what you pay here, so
        there is no number and none is invented. The heading says MAY BE
        cheaper because that is the whole truth: the competitor's sale price
        might still be above your shelf tag. Typing that tag in is one field
        away, and doing so moves the line up into the section above.
      */}
      {cart.onSaleElsewhere.length > 0 ? (
        <div className="mb-5">
          <SectionHeading
            title="On sale elsewhere — may be cheaper than your price"
            note={`Advertised at another store this week. ${here} did not advertise these, so there is no saving to quote — type what the shelf says and it becomes a real number.`}
          />
          <div className="space-y-3">
            {cart.onSaleElsewhere.map((line) => (
              <OnSaleCard
                key={line.item.id}
                line={line}
                here={here}
                priceText={priceOf(line.item.id)}
                onPrice={(v) => setPrice(line.item.id, v)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {cart.bestHere.length > 0 ? (
        <div className="mb-5">
          <SectionHeading
            title={`Best price is already at ${here}`}
            note="Advertised where you are standing, and no other flyer beats it."
          />
          <div className="space-y-2">
            {cart.bestHere.map((line) => (
              <QuietRow
                key={line.item.id}
                label={itemLabel(line.item)}
                right={
                  line.yourPriceCents !== null ? (
                    <span className="font-semibold text-good">
                      {formatCents(line.yourPriceCents)}
                    </span>
                  ) : null
                }
                sub={
                  /*
                    Which price won, and where it came from. A line can land
                    here because a typed shelf price beat every flyer, and
                    saying "flyer, page 7" about a number somebody read off a
                    tag would be a citation for a document that does not say it.
                  */
                  line.yourPriceSource === "ENTERED"
                    ? "the price you entered — nothing advertised beats it"
                    : line.hereOffer
                      ? `${here} flyer, page ${line.hereOffer.flyerPage}`
                      : undefined
                }
              />
            ))}
          </div>
        </div>
      ) : null}

      {cart.notInFlyers.length > 0 ? (
        <div className="mb-5">
          <SectionHeading
            title="Not on sale in any flyer this week"
            note="No flyer you loaded advertises these. That is not a claim about shelf prices — only that nobody advertised them."
          />
          <div className="space-y-2">
            {cart.notInFlyers.map((line) => (
              <QuietRow key={line.item.id} label={itemLabel(line.item)} />
            ))}
          </div>
        </div>
      ) : null}

      {/*
        The same test Checkout Mode applies, repeated here so the button does
        not offer a screen that turns out to be empty. It includes hereOffer
        because a till needs a document for BOTH halves, and a shelf price
        somebody typed has none.
      */}
      {cart.cheaperElsewhere.some(
        (l) =>
          l.savingCents !== null &&
          l.hereOffer !== null &&
          l.bestElsewhere?.condition === "UNIT_PRICE",
      ) ? (
        <Link href="/checkout" className="btn-primary mt-2">
          Checkout mode — one at a time, large
        </Link>
      ) : null}

      <button type="button" className="btn-secondary mt-2" onClick={onAddMore}>
        Photograph something it missed
      </button>
      {/*
        Said here because this is where somebody wonders whether closing the
        tab loses the work. It does not, and it used to.
      */}
      <Link href="/carts" className="btn-secondary mt-2">
        Saved carts — this one is kept until the flyers expire
      </Link>
      <div className="mt-2">
        <StartOver count={cart.lines.length} onConfirm={onRescan} />
      </div>
    </section>
  );
}

/**
 * How much of the cart the camera could not read.
 *
 * ---------------------------------------------------------------------------
 * WHY A COUNT OF FAILURES BELONGS ON SCREEN
 * ---------------------------------------------------------------------------
 * Six products read from a photograph of eleven is not a reading of that cart,
 * and a list of six looks identical either way. The shopper is the only one
 * who can fix it — another angle, lifting the bread — and they will only think
 * to if somebody says there is something to fix.
 *
 * Silent when nothing was hidden, because a reassurance printed on every scan
 * is one nobody reads on the scan where it changes.
 */
function CoverageNote({ coverage }: { coverage: CoverageReport }) {
  if (coverage.obscured <= 0) return null;
  return (
    <p className="mt-3 rounded-md bg-warn/10 p-2 text-xs text-warn">
      <span className="font-semibold">
        {coverage.obscured} item{coverage.obscured === 1 ? "" : "s"} could be
        seen but not identified.
      </span>{" "}
      {coverage.note ?? "They are hidden behind or underneath something."} They
      are not in the list below — photograph them separately, or take another
      angle.
    </p>
  );
}

/**
 * Confidence as a word first, a number second.
 *
 * "62%" invites arithmetic nobody should do. "Low" is the actionable reading,
 * and the figure is kept beside it for anyone who wants to sort by it.
 */
function ConfidenceBadge({ item }: { item: EditableItem }) {
  const pct = Math.round(item.confidence * 100);
  const band =
    item.userConfirmed
      ? { label: "You confirmed", cls: "text-good" }
      : item.confidence >= 0.9
        ? { label: "High", cls: "text-good" }
        : item.confidence >= NEEDS_A_LOOK_BELOW
          ? { label: "Medium", cls: "text-muted" }
          : { label: "Low", cls: "text-warn" };

  return (
    <span className={`text-xs font-semibold ${band.cls}`}>
      {band.label}
      {item.userConfirmed ? "" : ` · ${pct}%`}
    </span>
  );
}

function SectionHeading({ title, note }: { title: string; note: string }) {
  return (
    <div className="mb-2">
      <h2 className="text-sm font-bold uppercase tracking-wide">{title}</h2>
      <p className="text-xs text-muted">{note}</p>
    </div>
  );
}

function QuietRow({
  label,
  right,
  sub,
}: {
  label: string;
  right?: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="card flex items-baseline justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm">{label}</p>
        {sub ? <p className="text-xs text-muted">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

/**
 * The one card that opens.
 *
 * Collapsed it answers "how much and where". Expanded it produces the evidence
 * — the flyer page itself, the page number, the dates, and the condition if
 * there is one. Nothing here is fetched until somebody opens it: a signed URL
 * for every page of every result would be a dozen requests for a screen where
 * most rows are never touched.
 */
/**
 * "What does it cost here?" — the one field that turns a suggestion into a sum.
 *
 * Placed in the results rather than back on the item list, because that is the
 * order the real thing happens in: you learn Maxi has it for $3.99, you look at
 * the shelf in front of you, and only then do you have a number worth typing.
 * Asking for it up front asked for it before anybody knew which items mattered.
 *
 * Nothing is required. A blank field is a perfectly good answer and leaves the
 * line saying what it honestly can.
 */
function ShelfPriceField({
  here,
  value,
  onChange,
  known,
}: {
  here: string;
  value: string;
  onChange: (value: string) => void;
  /** What the app already believes, when it believes anything. */
  known: string | null;
}) {
  const parsed = value.trim() ? tryParsePriceToCents(value) : null;
  const bad = value.trim() !== "" && parsed === null;

  return (
    <label className="mt-3 block">
      <span className="text-xs font-semibold">
        What does it cost at {here}?
      </span>
      <span className="mt-1 flex items-center gap-2">
        <input
          type="text"
          inputMode="decimal"
          className="field w-28"
          placeholder={known ?? "$0.00"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`Shelf price at ${here}`}
        />
        <span className="text-xs text-muted">
          {bad
            ? "Not a price."
            : parsed !== null
              ? "Compared against the flyers below."
              : "Optional — type the shelf tag to get a real number."}
        </span>
      </span>
    </label>
  );
}

/**
 * An item somebody else advertised, where nobody knows what you pay.
 *
 * The card that this whole screen was missing. It states two facts — the
 * product, and what another shop advertised it for — and stops. There is no
 * saving, no "cheaper", and no arrow pointing at a number, because the shelf
 * price of a product your shop did not advertise is not in this app and cannot
 * be guessed from a competitor's sale price.
 *
 * It may have no per-item offer at all: a competitor advertising chicken at
 * $3.62/lb is real information about an item in your trolley, and it is shown
 * with its unit rather than dropped or silently compared.
 */
function OnSaleCard({
  line,
  here,
  priceText,
  onPrice,
}: {
  line: CartLine;
  here: string;
  priceText: string;
  onPrice: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Per-item first; a weight price only when that is all there is.
  const lead = line.bestElsewhere ?? line.measuredElsewhere[0] ?? null;
  if (lead === null) return null;
  const store = RETAILERS[lead.retailerId]?.displayName ?? lead.retailerId;
  const byWeight = line.bestElsewhere === null;
  // At a glance: is what's shown here from a flyer you scanned (with a real
  // page number) or from Flipp (never a page)? Both lists render fully
  // below once expanded — this is just the summary line's short version.
  const sourceTag =
    lead.condition === "SOURCE_UNCERTAIN" ? "via Flipp" : `p.${lead.flyerPage}`;

  return (
    <section className="card border border-warn/30">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="min-w-0">
          <p className="font-bold leading-tight">{itemLabel(line.item)}</p>
          <p className="text-xs text-muted">
            On sale at {store} · {formatCents(lead.price)}
            {byWeight ? ` ${describeBasis(lead.basis)}` : ""} · {sourceTag} ·
            not advertised at {here}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {/*
            Where a saving would go, and deliberately not a number. "May be
            cheaper" is the entire claim the data supports.
          */}
          <span className="block text-sm font-bold text-warn">may be</span>
          <span className="text-xs text-muted">cheaper</span>
        </div>
      </button>

      <SizeUnverifiedNote line={line} />

      <ShelfPriceField
        here={here}
        value={priceText}
        onChange={onPrice}
        known={null}
      />

      {open ? (
        <div className="mt-3 border-t border-line pt-3">
          <p className="mb-3 rounded-md bg-warn/10 p-2 text-xs text-warn">
            {here} did not advertise this, so nobody knows what you would pay
            here — {store} may still be dearer than the shelf in front of you.
            Compare it yourself, or type the shelf price above.
          </p>
          <OfferEvidence line={line} best={line.bestElsewhere} />
        </div>
      ) : null}
    </section>
  );
}

function CheaperCard({
  line,
  here,
  priceText,
  onPrice,
}: {
  line: CartLine;
  here: string;
  priceText: string;
  onPrice: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Guaranteed by the outcome: CHEAPER_ELSEWHERE requires a per-item offer at
  // another chain to have beaten a known price here.
  const best = line.bestElsewhere!;
  const store = RETAILERS[best.retailerId]?.displayName ?? best.retailerId;

  return (
    <section className="card">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="min-w-0">
          <p className="font-bold leading-tight">{itemLabel(line.item)}</p>
          <p className="text-xs text-muted">
            {store} · {formatCents(best.price)}
            {/*
              Where the price being compared against came from. A shopper has
              to be able to tell "your flyer says $5.99" from "you typed
              $5.49" — they are different kinds of fact and only one of them
              has a document behind it.
            */}
            {line.yourPriceSource === "ENTERED"
              ? ` · you said ${formatCents(line.yourPriceCents!)}`
              : ` · ${here} ${formatCents(line.yourPriceCents!)}`}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <span className="block text-lg font-extrabold text-good">
            {formatCents(line.savingCents!)}
          </span>
          <span className="text-xs text-muted">cheaper</span>
        </div>
      </button>

      <SizeUnverifiedNote line={line} />

      {/*
        Still offered here, so a flyer price can be corrected by somebody
        standing in front of the shelf. The sale may have ended, or the tile may
        have been read wrongly, and the person looking at it is right.
      */}
      <ShelfPriceField
        here={here}
        value={priceText}
        onChange={onPrice}
        known={
          line.hereOffer ? `flyer: ${formatCents(line.hereOffer.price)}` : null
        }
      />

      {open ? (
        <div className="mt-3 border-t border-line pt-3">
          <OfferEvidence line={line} best={best} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The paperwork behind a line: every matched offer, the conditions, the weight
 * prices that were deliberately not compared, and the flyer page itself.
 *
 * Shared by both cards. It was written once inside the "cheaper" card, which
 * meant the new section either duplicated it or went without the evidence —
 * and evidence is the thing this whole app is for.
 */
function OfferEvidence({
  line,
  best,
}: {
  line: CartLine;
  best: StoredOffer | null;
}) {
  return (
    <>
      {line.matches.length > 0 ? (
        <div className="space-y-1 text-sm">
          {line.matches.map((offer, i) => (
            <p
              key={offer.id}
              className={`flex justify-between gap-3 ${
                i === 0 ? "font-bold text-good" : "text-muted"
              }`}
            >
              <span>
                {RETAILERS[offer.retailerId]?.displayName ?? offer.retailerId}
              </span>
              <span>
                {formatCents(offer.price)} · p.{offer.flyerPage}
              </span>
            </p>
          ))}
        </div>
      ) : null}

      {best && best.condition !== "UNIT_PRICE" ? (
        <p className="mt-2 text-xs text-warn">
          {best.conditionText ?? conditionLabel(best.condition)}
        </p>
      ) : null}

      {/*
        Advertised by weight. Shown because it is real information a shopper
        can act on, and kept out of the arithmetic because a weight price and
        a package price are not two prices for the same thing.
      */}
      {line.measuredMatches.length > 0 ? (
        <div className="mt-3 rounded-md bg-surface p-2 text-xs">
          <p className="font-semibold">Advertised by weight</p>
          {line.measuredMatches.map((offer) => (
            <p key={offer.id} className="text-muted">
              {RETAILERS[offer.retailerId]?.displayName ?? offer.retailerId}:{" "}
              {formatCents(offer.price)} {describeBasis(offer.basis)} — not
              compared against a package price.
            </p>
          ))}
        </div>
      ) : null}

      {/*
        Every Flipp match, always shown in full — not just the one used as
        the fallback lead when nothing scanned exists. Without this list, a
        Flipp offer at a store you DID scan a cheaper trustworthy price for
        would be silently invisible, and there would be no way to tell
        whether "on sale elsewhere" means your own scan, Flipp, or both.
      */}
      {line.uncertainElsewhere.length > 0 ? (
        <div className="mt-3 rounded-md bg-surface p-2 text-xs">
          <p className="font-semibold">Also seen on Flipp (not confirmed)</p>
          {line.uncertainElsewhere.map((offer) => (
            <div key={offer.id} className="mt-2 flex items-start gap-2">
              {offer.partnerImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={offer.partnerImageUrl}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded object-cover"
                />
              ) : null}
              <p className="text-muted">
                {RETAILERS[offer.retailerId]?.displayName ?? offer.retailerId}:{" "}
                {formatCents(offer.price)} — via Flipp; check the price and
                unit yourself.
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {/*
        The proof. Falls back to the cheapest weight-priced offer when there is
        no per-item one, because a page number is still a page number.
      */}
      {(() => {
        const cited = best ?? line.measuredElsewhere[0] ?? null;
        if (cited === null) return null;
        const isPartnerFeed = cited.condition === "SOURCE_UNCERTAIN";
        return (
          <>
            <p className="mt-3 rounded-lg bg-surface px-2 py-1 text-xs">
              {citationLine({
                retailerId: cited.retailerId,
                flyerPage: cited.flyerPage,
                validFrom: cited.validFrom,
                validTo: cited.validTo,
                hasPageImage: true,
                isPartnerFeed,
              })}
            </p>

            {!isPartnerFeed && cited.confirmedAt === null ? (
              <p className="mt-1 text-xs text-warn">
                Not yet confirmed against the page — check it before showing
                anyone.
              </p>
            ) : null}

            <FlyerPageProof
              flyerId={cited.flyerId}
              page={cited.flyerPage}
              box={cited.box}
              isPartnerFeed={isPartnerFeed}
              imageUrl={cited.partnerImageUrl}
            />
          </>
        );
      })()}
    </>
  );
}

/**
 * "Start a new cart", with one tap between a full trolley and an empty one.
 *
 * A cart is twenty minutes of photographing, correcting names and typing shelf
 * prices. A single mis-tap on a phone in a shop should not end that, and a
 * browser confirm() dialog is both ugly and easy to dismiss without reading.
 * So the button asks in place, says how much is about to go, and defaults to
 * keeping it — the destructive option is the one you have to reach for twice.
 */
function StartOver({ count, onConfirm }: { count: number; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button type="button" className="btn-ghost" onClick={() => setAsking(true)}>
        Start a new cart
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-bad/40 p-3">
      <p className="text-sm font-semibold">
        Discard {count} item{count === 1 ? "" : "s"} and start again?
      </p>
      <p className="mt-1 text-xs text-muted">
        The photos, the products and any prices you typed all go. Your flyers
        are not touched.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setAsking(false)}
        >
          Keep this cart
        </button>
        <button
          type="button"
          className="btn-ghost text-bad"
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          Yes, discard it
        </button>
      </div>
    </div>
  );
}

/**
 * What to do about a size nobody read.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WORTH A WHOLE COMPONENT
 * ---------------------------------------------------------------------------
 * A blank size is not always a cosmetic gap, but it is not an automatic
 * dead end either — the two get conflated easily, so worth being precise.
 * When the brand and name read confidently, a missing size still clears the
 * matching bar at a score of 90 (see SCORE.unverifiedSize in scoring.ts) —
 * it matches, with a caution shown afterward rather than silently. It ONLY
 * becomes a true dead end when the name itself is also too unclear to read
 * confidently, landing in the fuzzy tier (capped at 70), which sits below
 * the 90 needed to count as a match at all. This component cannot know in
 * advance which of those two an item will hit — matching has not run yet at
 * confirm time — so its wording describes the mechanism honestly rather
 * than asserting either outcome as certain.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SUGGESTION IS NOT SIMPLY FILLED IN
 * ---------------------------------------------------------------------------
 * Because a wrong size does not fail safely. "650 g" accepted against a
 * flyer's 750 g tub is a confident match on the wrong product, carried to a
 * till with a page number attached. So the guess is shown with what it rests
 * on and stays out of `size` until somebody says otherwise — and once they do,
 * it is their reading rather than the model's guess.
 *
 * The basis matters more than the number. "Some of the label is legible" and
 * "this brand usually sells 650 g" are different kinds of claim, and a person
 * deciding whether to trust it should be told which one they are looking at.
 */
function SizeHelp({
  item,
  onUse,
}: {
  item: EditableItem;
  onUse: (size: string) => void;
}) {
  if (item.size) return null;

  const basis = describeSizeBasis(item.sizeGuessBasis);

  return (
    <div className="mt-1 rounded-md bg-warn/10 p-2 text-xs">
      <p className="text-warn">
        <span className="font-semibold">No size read.</span> If the brand and
        name are clear, this can still match — you will be asked to confirm
        the size before relying on it. It only fails to match anything if the
        name itself is also too unclear to read confidently.
      </p>

      {item.sizeGuess ? (
        <div className="mt-2">
          <p>
            <span className="font-semibold">Suggested {item.sizeGuess}</span>
            {basis ? ` — ${basis}.` : "."} Not read from your photo.
          </p>
          <button
            type="button"
            className="btn-secondary mt-1"
            onClick={() => onUse(item.sizeGuess!)}
          >
            Use {item.sizeGuess}
          </button>
        </div>
      ) : (
        <p className="mt-1">
          Nothing to suggest — the label was not legible and the package was not
          recognisable. Type it from the tub.
        </p>
      )}
    </div>
  );
}

/**
 * The basis, as a sentence rather than a token.
 *
 * Ordered strongest first, matching the order the model was asked to report
 * them in, so the first clause a person reads is the best reason there is.
 */
function describeSizeBasis(basis: string | null): string | null {
  if (!basis) return null;
  const parts: string[] = [];
  if (basis.includes("partial_label")) parts.push("part of the label is legible");
  if (basis.includes("dimensions")) parts.push("judged from the package size in the photo");
  if (basis.includes("typical")) parts.push("the size this product is usually sold in");
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The caution that pays for matching without a size.
 *
 * Brand, name and variant agreed, and a size known on both sides and different
 * is a hard blocker that never reaches here — so this is the same product as
 * far as anything readable goes. What is missing is the check, and the whole
 * case for allowing the match is that this note gets shown instead.
 *
 * Names the actual size when the flyer side has one — "the flyer says 250 g"
 * is a specific thing to go check, not just a reason to distrust the match.
 * Falls back to a generic caution only when neither side has a size to name.
 */
function SizeUnverifiedNote({ line }: { line: CartLine }) {
  if (!line.sizeUnverified) return null;
  const flyerSize = line.bestElsewhere?.size ?? null;

  return (
    <p className="mt-2 rounded-md bg-warn/10 p-2 text-xs text-warn">
      <span className="font-semibold">
        {flyerSize
          ? `Found a match — check the size. The flyer shows ${flyerSize}.`
          : "Check the size before you quote this."}
      </span>{" "}
      {flyerSize
        ? "The brand and product match, but your cart's size was not read — confirm the tub or box in your cart is the same size before you rely on this."
        : "The brand and product match, but the size could not be read on one side — so this may be a different pack."}{" "}
      Checkout Mode will not show it until the size is confirmed.
    </p>
  );
}

/**
 * Where a value came from, when it did not come from the photograph.
 *
 * A correction applied silently is indistinguishable from a reading, and the
 * difference matters: a reading is what the camera saw this time, a correction
 * is what somebody typed about this reading before — possibly weeks ago,
 * possibly somebody else, possibly about a pack that has since changed size.
 *
 * So it is named, and it is editable like anything else. The value is applied
 * rather than merely suggested because a person typed it about this exact
 * reading, which is a stronger claim than a model's recollection of a typical
 * size — but "stronger" is not "beyond question", and the card says so.
 */
function CorrectedNote({ item }: { item: EditableItem }) {
  if (item.correctedFields.length === 0) return null;

  const names: Record<string, string> = {
    brand: "brand",
    productName: "product",
    variant: "variant",
    size: "size",
  };
  const fixed = item.correctedFields.map((f) => names[f] ?? f).join(", ");

  return (
    <p className="mt-1 rounded-md bg-brand/10 p-2 text-xs">
      <span className="font-semibold">Filled from an earlier correction</span> —
      the {fixed} came from a fix somebody typed for this same reading, not from
      this photo. Change it if the pack is different now.
    </p>
  );
}
