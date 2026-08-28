"use client";

/**
 * Search this week's prices by product name, across every source at once.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE PAGE FROM THE CART SCANNER
 * ---------------------------------------------------------------------------
 * The cart scanner matches a PHOTOGRAPHED item against offers using a scoring
 * function built for that — same brand, same size, same everything, because
 * the photo is specific and getting the match wrong would misprice a real
 * item in a real trolley. A search box is the opposite kind of question:
 * "what does the word 'yogurt' turn up anywhere this week", deliberately
 * loose. Reusing the strict matcher here would hide results a shopper is
 * plainly asking for; a plain substring match is the honest tool for this.
 *
 * ---------------------------------------------------------------------------
 * WHY NOTHING HERE IS EVER SUBTRACTED
 * ---------------------------------------------------------------------------
 * This page never computes a saving — it lists every match, at every store,
 * from every source, and lets a shopper compare them by eye. That is a
 * deliberate difference from the cart scanner and the deals screen, both of
 * which do arithmetic on a specific item at a specific store. A free-text
 * search matches too loosely for arithmetic to be trustworthy — "yogurt"
 * matches a two-litre tub and a 100g single cup alike, and subtracting across
 * those would be comparing two different things and calling it a saving.
 */

import { useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { PageHeader, Notice, Spinner } from "@/components/ui";
import { TabBar } from "@/components/TabBar";
import { ActiveFlyerPeriod } from "@/components/ActiveFlyerPeriod";
import { FlyerPageProof } from "@/components/FlyerPageProof";
import {
  loadCurrentOffers,
  loadCurrentFlippOffers,
  type StoredOffer,
} from "@/services/flyers/storage";
import { citationLine } from "@/services/flyers/citation";
import { currentWeekWindow, looksLikeCurrentWeek } from "@/services/flyers/status";
import { describeBasis } from "@/types/flyer";
import { RETAILERS } from "@/config/retailers";
import type { RetailerId } from "@/types";
import { formatCents } from "@/lib/money";

export default function SearchPage() {
  return (
    <AuthGuard>
      <PriceSearch />
    </AuthGuard>
  );
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * English/French grocery category pairs, so a search for "fromage" also
 * finds "cheese" and vice versa — without needing a second, French-language
 * copy of Flipp's data. Flipp is called with locale=en-CA only; fetching a
 * French copy too would roughly double the import function's upstream
 * calls, which are already close to the execution-time ceiling fetching
 * everything once, concurrently (see cartmatch-flipp-import's own
 * comments). This also covers scanned flyers, which are often bilingual or
 * French-primary in Quebec — something a second English-only Flipp call
 * would never have helped with anyway.
 *
 * Deliberately excludes short or ambiguous words where the languages
 * collide badly — "thé" (tea) vs "the" being the obvious one. Every entry
 * here is a word unambiguous enough in either language that a false match
 * is unlikely. Not exhaustive; add pairs as gaps come up in practice.
 */
const CATEGORY_SYNONYMS: string[][] = [
  ["fromage", "fromages", "cheese"],
  ["biscuit", "biscuits", "cookie", "cookies"],
  ["lait", "milk"],
  ["pain", "bread"],
  ["oeuf", "oeufs", "egg", "eggs"],
  ["poulet", "chicken"],
  ["boeuf", "beef"],
  ["porc", "pork"],
  ["poisson", "fish"],
  ["yogourt", "yaourt", "yogurt"],
  ["beurre", "butter"],
  ["pomme", "pommes", "apple", "apples"],
  ["legume", "legumes", "vegetable", "vegetables"],
  ["fruit", "fruits"],
  ["cereale", "cereales", "cereal", "cereals"],
  ["cafe", "coffee"],
  ["jus", "juice"],
  ["soupe", "soupes", "soup"],
  ["pates", "pasta"],
  ["riz", "rice"],
  ["confiture", "confitures", "jam"],
  ["chocolat", "chocolats", "chocolate"],
  ["biere", "bieres", "beer"],
  ["savon", "savons", "soap"],
  ["shampooing", "shampoo"],
  ["dentifrice", "toothpaste"],
  ["couches", "diapers", "diaper"],
  ["surgele", "surgeles", "congele", "congeles", "frozen"],
  ["viande", "viandes", "meat"],
  ["dinde", "turkey"],
  ["saumon", "salmon"],
  ["crevette", "crevettes", "shrimp"],
  ["creme glacee", "ice cream"],
  ["farine", "flour"],
  ["sucre", "sugar"],
  ["sel", "salt"],
  ["huile", "oil"],
  ["vinaigre", "vinegar"],
  ["nouilles", "noodles"],
  ["saucisse", "saucisses", "sausage", "sausages"],
  ["jambon", "ham"],
  ["noix", "nuts"],
  ["arachide", "arachides", "peanut", "peanuts"],
  ["raisin", "raisins", "grape", "grapes"],
  ["orange", "oranges"],
  ["citron", "citrons", "lemon", "lemons"],
  ["carotte", "carottes", "carrot", "carrots"],
  ["patate", "patates", "pomme de terre", "potato", "potatoes"],
  ["oignon", "oignons", "onion", "onions"],
  ["tomate", "tomates", "tomato", "tomatoes"],
  ["laitue", "lettuce"],
  ["concombre", "cucumber"],
  ["mouchoirs", "tissues"],
  ["essuie-tout", "paper towel", "paper towels"],
  ["papier hygienique", "toilet paper"],
  ["detersif", "detergent"],
  ["nettoyant", "cleaner"],
  ["desinfectant", "disinfectant"],
];

/**
 * Given a typed query, every extra term worth also checking — the query
 * itself plus every word from any synonym group it partially matches.
 * "fromage" partially matches ["fromage","fromages","cheese"], so all three
 * become search terms; a query that matches no group is unaffected.
 */
function expandQuery(term: string): string[] {
  const normalized = normalize(term);
  const terms = new Set([normalized]);
  for (const group of CATEGORY_SYNONYMS) {
    const normGroup = group.map(normalize);
    const hits = normGroup.some(
      (word) => word.includes(normalized) || normalized.includes(word),
    );
    if (hits) normGroup.forEach((word) => terms.add(word));
  }
  return [...terms];
}

function PriceSearch() {
  const [query, setQuery] = useState("");
  const [offers, setOffers] = useState<StoredOffer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Default true on purpose: an offer's OWN valid_from/valid_to is not
  // always a one-week window — some Flipp banners run a longer promotion or
  // catalog alongside their weekly circular, on the same feed. "This week
  // only" is the calendar's Thursday-to-Wednesday week, checked directly,
  // not trusted from whatever the widest matching offer happens to claim.
  const [thisWeekOnly, setThisWeekOnly] = useState(true);

  useEffect(() => {
    let live = true;
    Promise.all([loadCurrentOffers(), loadCurrentFlippOffers(new Date(), { thisWeekOnly: false })])
      .then(([scanned, flipp]) => {
        if (!live) return;
        setOffers([...scanned, ...flipp]);
      })
      .catch((err) => {
        if (live) {
          setLoadError(
            err instanceof Error ? err.message : "Could not load this week's prices.",
          );
        }
      });
    return () => {
      live = false;
    };
  }, []);

  // Grouped by store, cheapest first within a store, matching how a shopper
  // actually reads this: "what's my price at each place", not one flat list.
  const grouped = useMemo(() => {
    if (offers === null) return null;
    const term = normalize(query.trim());
    if (term.length < 2) return null;

    const week = currentWeekWindow();
    const scoped = thisWeekOnly ? offers.filter((o) => looksLikeCurrentWeek(o, week)) : offers;

    const searchTerms = expandQuery(query.trim());
    const matched = scoped.filter((o) => {
      const haystack = normalize(`${o.brand ?? ""} ${o.advertisedText}`);
      return searchTerms.some((t) => haystack.includes(t));
    });

    const byRetailer = new Map<RetailerId, StoredOffer[]>();
    for (const offer of matched) {
      const list = byRetailer.get(offer.retailerId) ?? [];
      list.push(offer);
      byRetailer.set(offer.retailerId, list);
    }
    for (const list of byRetailer.values()) {
      list.sort((a, b) => a.price - b.price);
    }

    return [...byRetailer.entries()].sort(([a], [b]) =>
      (RETAILERS[a]?.displayName ?? a).localeCompare(RETAILERS[b]?.displayName ?? b),
    );
  }, [offers, query, thisWeekOnly]);

  // Just for the "also searching" note below the input — recomputed the same
  // way as inside the memo above, cheap enough not to bother sharing.
  const extraSearchTerms =
    query.trim().length >= 2
      ? expandQuery(query.trim()).filter((t) => t !== normalize(query.trim()))
      : [];

  return (
    <>
      <main className="mx-auto max-w-[900px]">
        <PageHeader
          title="Search this week's prices"
          subtitle="Every matching price, at every store, from every source — nothing here is ever subtracted."
          backHref="/"
        />

        <ActiveFlyerPeriod />

      {loadError ? (
        <Notice tone="warn" title="Could not load this week's prices">
          {loadError} Reload the page before trusting an empty result.
        </Notice>
      ) : null}

      <div className="card mb-4">
        <label htmlFor="search-query" className="text-sm font-semibold">
          Product name
        </label>
        <input
          id="search-query"
          type="search"
          inputMode="search"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. yogurt, Chapman's, 2 L"
          className="mt-2 w-full rounded-md border border-line bg-transparent px-3 py-2 text-base"
        />
        <p className="mt-1 text-xs text-muted">
          Partial words work — &ldquo;yog&rdquo; finds &ldquo;yogurt&rdquo;.
          At least 2 letters to search.
        </p>
        {extraSearchTerms.length > 0 ? (
          <p className="mt-1 text-xs text-muted">
            Also searching: {extraSearchTerms.join(", ")}
          </p>
        ) : null}

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={thisWeekOnly}
            onChange={(e) => setThisWeekOnly(e.target.checked)}
          />
          This week only
        </label>
        {!thisWeekOnly ? (
          <p className="mt-1 text-xs text-muted">
            Showing everything currently valid, including longer-running
            promotions that extend past this week.
          </p>
        ) : null}
      </div>

      {offers === null && !loadError ? (
        <section className="card">
          <Spinner label="Loading this week's prices…" />
        </section>
      ) : null}

      {offers !== null && query.trim().length >= 2 && grouped !== null ? (
        grouped.length === 0 ? (
          <Notice tone="info" title="No matches">
            Nothing this week, from a scanned flyer or Flipp, matched
            &ldquo;{query.trim()}&rdquo;.
          </Notice>
        ) : (
          <div className="space-y-4">
            {grouped.map(([retailerId, list]) => (
              <section key={retailerId} className="card">
                <p className="font-bold">
                  {RETAILERS[retailerId]?.displayName ?? retailerId}
                </p>
                <div className="mt-2 space-y-3">
                  {list.map((offer) => {
                    const isPartnerFeed = offer.condition === "SOURCE_UNCERTAIN";
                    return (
                      <div key={offer.id} className="border-t border-line pt-2 first:border-t-0 first:pt-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold leading-tight">
                              {offer.advertisedText}
                            </p>
                            {offer.brand ? (
                              <p className="text-xs text-muted">{offer.brand}</p>
                            ) : null}
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="font-bold">
                              {formatCents(offer.price)}
                              {offer.basis !== "PER_ITEM" && offer.basis !== "UNKNOWN" ? (
                                <span className="ml-1 text-xs font-normal text-muted">
                                  {describeBasis(offer.basis)}
                                </span>
                              ) : null}
                            </p>
                            <p className="text-[11px] font-semibold text-muted">
                              {isPartnerFeed ? "via Flipp" : "scanned"}
                            </p>
                          </div>
                        </div>

                        <div className="mt-2 flex items-start gap-2">
                          {isPartnerFeed && offer.partnerImageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={offer.partnerImageUrl}
                              alt=""
                              className="h-12 w-12 shrink-0 rounded object-cover"
                            />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <p className="rounded-md bg-surface px-2 py-1 text-xs">
                              {citationLine({
                                retailerId: offer.retailerId,
                                flyerPage: offer.flyerPage,
                                validFrom: offer.validFrom,
                                validTo: offer.validTo,
                                hasPageImage: true,
                                isPartnerFeed,
                              })}
                            </p>
                            {!isPartnerFeed ? (
                              <FlyerPageProof
                                flyerId={offer.flyerId}
                                page={offer.flyerPage}
                                box={offer.box}
                              />
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )
      ) : null}

      {offers !== null && query.trim().length > 0 && query.trim().length < 2 ? (
        <p className="text-sm text-muted">Keep typing — at least 2 letters.</p>
      ) : null}

      <div className="h-16" aria-hidden />
      </main>

      <TabBar />
    </>
  );
}
