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
import { MockBanner, Money, Notice, PageHeader, Spinner } from "@/components/ui";
import { RETAILERS } from "@/config/retailers";
import { formatCents, tryParsePriceToCents } from "@/lib/money";
import { DEFAULT_PREFS, loadPrefs, saveLastResult } from "@/lib/prefs";
import { analyzeCartPhotos } from "@/services/vision";
import {
  compareCartToFlyers,
  itemLabel,
  needsConfirming,
  type CartComparison,
  type CartLine,
} from "@/services/flyers/cartMatch";
import {
  flyerPageUrl,
  loadCurrentOffers,
  type StoredOffer,
} from "@/services/flyers/storage";
import { citationLine } from "@/services/flyers/citation";
import { conditionLabel, describeBasis } from "@/types/flyer";
import type { DetectedProduct, RetailerId, UserPreferences } from "@/types";

type Step = "capture" | "confirm" | "results";

interface EditableItem extends DetectedProduct {
  include: boolean;
  manualPrice: string;
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
  const [images, setImages] = useState<{ base64: string; mimeType: string; preview: string }[]>([]);
  const [items, setItems] = useState<EditableItem[]>([]);
  const [cart, setCart] = useState<CartComparison | null>(null);
  const [offerCount, setOfferCount] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visionNote, setVisionNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const p = loadPrefs();
    setPrefs(p);
    if (!p.postalCode || !p.currentRetailerId) router.replace("/setup");
  }, [router]);

  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const next: { base64: string; mimeType: string; preview: string }[] = [];
    for (const file of Array.from(files).slice(0, 4)) {
      const base64 = await fileToBase64(file);
      next.push({
        base64,
        mimeType: file.type || "image/jpeg",
        preview: URL.createObjectURL(file),
      });
    }
    setImages((prev) => [...prev, ...next].slice(0, 4));
  }, []);

  async function recognize() {
    if (images.length === 0) {
      setError("Take at least one photo of your cart first.");
      return;
    }
    setBusy("Reading your cart…");
    setError(null);
    try {
      const outcome = await analyzeCartPhotos(
        images.map((i) => ({ base64: i.base64, mimeType: i.mimeType })),
      );
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      const detected = outcome.products;
      if (detected.length === 0) {
        setError("No products detected. Try a closer or better-lit photo.");
        return;
      }
      setVisionNote(outcome.note);
      // Appended, not replaced. Photographing a missed item is the second half
      // of "what did the camera catch" — a shopper who spots a gap in the list
      // must be able to fill it without losing everything already confirmed.
      setItems((prev) => [
        ...prev,
        ...detected.map((d) => ({ ...d, include: true, manualPrice: "" })),
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
      // Against the flyers this shopper loaded — not against a retailer API.
      // Every price behind these results was printed in a document they hold
      // and can show at a till, which is the only kind a price-match desk
      // accepts.
      const offers = await loadCurrentOffers();
      setOfferCount(offers.length);
      setCart(
        compareCartToFlyers(chosen, offers, prefs.currentRetailerId!),
      );
      setStep("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Comparison failed.");
    } finally {
      setBusy(null);
    }
  }

  // The shelf price is no longer asked for as a precondition. This screen
  // compares flyer against flyer; what the current store charges only enters
  // when that store advertised the item, and then it comes from its own flyer
  // rather than from somebody squinting at a tag.
  const unsure = items.filter((i) => i.include && needsConfirming(i));
  const clear = items.filter((i) => i.include && !needsConfirming(i));

  // Editing a card IS the confirmation. Somebody who has typed the brand in
  // has looked at the item, and asking them to then tick a box to say so is a
  // second action for a decision they already made.
  const patchItem = (id: string, patch: Partial<EditableItem>) =>
    setItems((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, ...patch, userConfirmed: true } : it,
      ),
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
          <div className="card mb-4">
            <p className="text-sm text-muted">
              One clear photo is usually enough. A second angle helps when items
              are stacked.
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
            <button
              type="button"
              className="btn-primary mt-3"
              onClick={() => fileRef.current?.click()}
            >
              {images.length === 0 ? "Take a photo of your cart" : "Add another photo"}
            </button>
          </div>

          {images.length > 0 ? (
            <div className="mb-4 grid grid-cols-2 gap-2">
              {images.map((img, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={img.preview}
                  alt={`Cart photo ${i + 1}`}
                  className="h-32 w-full rounded-xl border border-line object-cover"
                />
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
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {step === "results" && cart ? (
        <CartResults
          cart={cart}
          currentRetailer={prefs.currentRetailerId!}
          offerCount={offerCount ?? 0}
          onRescan={() => {
            setStep("capture");
            setCart(null);
            setItems([]);
          }}
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
  const uncertain = item.confidence < 0.9;
  return (
    <div className={`card ${item.include ? "" : "opacity-50"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold leading-tight">
            <span className={uncertain ? "text-warn" : "text-good"}>
              {uncertain ? "?" : "✓"}
            </span>{" "}
            {[item.brand, item.productName].filter(Boolean).join(" ")}
          </p>
          <p className="text-sm text-muted">
            {[item.variant, item.size, item.fatPercentage ? `${item.fatPercentage}%` : null]
              .filter(Boolean)
              .join(" · ") || "Details unread"}
          </p>
          <p className="mt-1 text-xs text-muted">
            Confidence {(item.confidence * 100).toFixed(0)}%
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
          <Field
            label="Size"
            value={item.size ?? ""}
            onChange={(v) => onChange({ size: v || null })}
            placeholder="650 g"
          />
          <Field
            label="Qty in cart"
            value={String(item.packageQuantity ?? 1)}
            onChange={(v) =>
              onChange({ packageQuantity: Number.parseInt(v, 10) || 1 })
            }
            inputMode="numeric"
          />
          <Field
            label="Shelf price here"
            value={item.manualPrice}
            onChange={(v) => onChange({ manualPrice: v })}
            placeholder="7.49"
            inputMode="decimal"
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
  onRescan,
  onAddMore,
}: {
  cart: CartComparison;
  currentRetailer: RetailerId;
  offerCount: number;
  onRescan: () => void;
  onAddMore: () => void;
}) {
  const here = RETAILERS[currentRetailer]?.displayName ?? currentRetailer;

  return (
    <section>
      <div className="card mb-4">
        <p className="text-2xl font-extrabold">
          {cart.cheaperElsewhere.length === 0
            ? "Nothing is cheaper elsewhere"
            : `${cart.cheaperElsewhere.length} item${cart.cheaperElsewhere.length === 1 ? " is" : "s are"} cheaper elsewhere`}
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
      </div>

      {/*
        First and biggest, because it is the only section with anything to do.
      */}
      {cart.cheaperElsewhere.length > 0 ? (
        <div className="mb-5">
          <SectionHeading
            title="Cheaper at another store"
            note="Open one to see the price, the flyer page and the dates it runs — what a price-match desk asks for."
          />
          <div className="space-y-3">
            {cart.cheaperElsewhere.map((line) => (
              <CheaperCard key={line.item.id} line={line} here={here} />
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
                  line.hereOffer ? (
                    <span className="font-semibold text-good">
                      {formatCents(line.hereOffer.price)}
                    </span>
                  ) : null
                }
                sub={
                  line.hereOffer
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

      <button type="button" className="btn-secondary mt-2" onClick={onAddMore}>
        Photograph something it missed
      </button>
      <button type="button" className="btn-ghost mt-2" onClick={onRescan}>
        Start a new cart
      </button>
    </section>
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
function CheaperCard({ line, here }: { line: CartLine; here: string }) {
  const [open, setOpen] = useState(false);
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
            {line.hereOffer
              ? ` · ${here} ${formatCents(line.hereOffer.price)}`
              : ` · not advertised at ${here}`}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {line.savingCents !== null ? (
            <>
              <span className="block text-lg font-extrabold text-good">
                {formatCents(line.savingCents)}
              </span>
              <span className="text-xs text-muted">cheaper</span>
            </>
          ) : (
            // No number, because there is no honest number: the shelf price of
            // a product your shop did not advertise is not in this app.
            <span className="text-xs text-muted">
              on sale
              <br />
              elsewhere
            </span>
          )}
        </div>
      </button>

      {open ? (
        <div className="mt-3 border-t border-line pt-3">
          {line.savingCents === null ? (
            <p className="mb-3 rounded-md bg-warn/10 p-2 text-xs text-warn">
              {here} did not advertise this, so there is no saving to quote —
              only that {store} has it on sale. Compare it against the shelf
              tag yourself.
            </p>
          ) : null}

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

          {best.condition !== "UNIT_PRICE" ? (
            <p className="mt-2 text-xs text-warn">
              {best.conditionText ?? conditionLabel(best.condition)}
            </p>
          ) : null}

          {/*
            Advertised per pound or per kilo. Shown because it is real
            information a shopper can act on, and kept out of the arithmetic
            because a weight price and a package price are not two prices for
            the same thing.
          */}
          {line.measuredMatches.length > 0 ? (
            <div className="mt-3 rounded-md bg-surface p-2 text-xs">
              <p className="font-semibold">Also advertised by weight</p>
              {line.measuredMatches.map((offer) => (
                <p key={offer.id} className="text-muted">
                  {RETAILERS[offer.retailerId]?.displayName ?? offer.retailerId}:{" "}
                  {formatCents(offer.price)} {describeBasis(offer.basis)} — not
                  compared against a package price.
                </p>
              ))}
            </div>
          ) : null}

          <p className="mt-3 rounded-lg bg-surface px-2 py-1 text-xs">
            {citationLine({
              retailerId: best.retailerId,
              flyerPage: best.flyerPage,
              validFrom: best.validFrom,
              validTo: best.validTo,
              hasPageImage: true,
            })}
          </p>

          {best.confirmedAt === null ? (
            <p className="mt-1 text-xs text-warn">
              Not yet confirmed against the page — check it before showing
              anyone.
            </p>
          ) : null}

          <FlyerPage offer={best} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The page itself, fetched only when somebody opens the card.
 *
 * A citation a cashier cannot see is an assertion. This is the picture the
 * shopper holds up, so it is worth a request — but only for the row they
 * actually opened.
 */
function FlyerPage({ offer }: { offer: StoredOffer }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");

  useEffect(() => {
    let live = true;
    flyerPageUrl(offer.flyerId, offer.flyerPage)
      .then((found) => {
        if (!live) return;
        setUrl(found);
        setState(found ? "ready" : "missing");
      })
      .catch(() => live && setState("missing"));
    return () => {
      live = false;
    };
  }, [offer.flyerId, offer.flyerPage]);

  if (state === "loading") {
    return <p className="mt-3 text-xs text-muted">Loading the page…</p>;
  }
  if (state === "missing" || !url) {
    return (
      <p className="mt-3 text-xs text-muted">
        The page image was not kept for this flyer. The citation above still
        names the page, so it can be checked in the paper copy.
      </p>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mt-3 block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={`Flyer page ${offer.flyerPage}`}
        className="w-full rounded-xl border border-line"
      />
      <span className="mt-1 block text-xs text-muted">
        Tap to open full size.
      </span>
    </a>
  );
}

/** A File as base64 without the data: prefix, which is what the API wants. */
async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
