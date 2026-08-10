/**
 * Central retailer configuration. Adding a retailer = adding an entry here
 * plus an adapter in src/services/retailers/. Nothing else in the app
 * hard-codes a retailer name.
 *
 * ---------------------------------------------------------------------------
 * HONESTY NOTE — READ BEFORE CHANGING `priceReliability`
 * ---------------------------------------------------------------------------
 * Every retailer below is `UNKNOWN`. That is not laziness: this codebase was
 * developed in an environment where outbound HTTPS to all six retailer domains
 * is refused by egress policy (HTTP 403 on CONNECT), so no adapter has ever
 * completed a live request. A reliability rating is a claim about observed
 * behaviour, and no behaviour has been observed.
 *
 * Promote a retailer to LOW/MEDIUM/HIGH only after its adapter has actually
 * fetched and parsed live product pages, and record what you measured in
 * `reliabilityNote`.
 */

import type { RetailerConfig, RetailerId } from "@/types";

export const RETAILERS: Record<RetailerId, RetailerConfig> = {
  maxi: {
    id: "maxi",
    name: "maxi",
    displayName: "Maxi",
    enabled: true,
    region: "Quebec",
    homepage: "https://www.maxi.ca",
    supportsProductPages: true,
    supportsOnlinePricing: true,
    supportsStoreContext: true,
    priceReliability: "UNKNOWN",
    reliabilityNote:
      "No live request has ever succeeded from the development environment (egress blocked). Capability flags reflect the publicly known existence of an online grocery catalogue, not measured adapter behaviour.",
  },
  superc: {
    id: "superc",
    name: "superc",
    displayName: "Super C",
    enabled: true,
    region: "Quebec",
    homepage: "https://www.superc.ca",
    supportsProductPages: true,
    supportsOnlinePricing: true,
    supportsStoreContext: true,
    priceReliability: "UNKNOWN",
    reliabilityNote:
      "No live request has ever succeeded from the development environment (egress blocked).",
  },
  walmart: {
    id: "walmart",
    name: "walmart",
    displayName: "Walmart",
    enabled: true,
    region: "Canada",
    homepage: "https://www.walmart.ca",
    supportsProductPages: true,
    supportsOnlinePricing: true,
    supportsStoreContext: true,
    priceReliability: "UNKNOWN",
    reliabilityNote:
      "No live request has ever succeeded from the development environment (egress blocked).",
  },
  metro: {
    id: "metro",
    name: "metro",
    displayName: "Metro",
    enabled: true,
    region: "Quebec",
    homepage: "https://www.metro.ca",
    supportsProductPages: true,
    supportsOnlinePricing: true,
    supportsStoreContext: true,
    priceReliability: "UNKNOWN",
    reliabilityNote:
      "No live request has ever succeeded from the development environment (egress blocked).",
  },
  iga: {
    id: "iga",
    name: "iga",
    displayName: "IGA",
    enabled: true,
    region: "Quebec",
    // iga.ca, verified from a real product URL supplied by the owner:
    //   https://www.iga.ca/products/oikos-fat-free-0--greek-yogurt-high-protein-plain-650-g
    // This previously said iga.net, which was an assumption nobody had checked.
    // Note the product path carries no article number, only a slug — unlike
    // Loblaw, whose URLs end in /p/<id>_EA. A slug cannot be constructed from
    // product attributes, so IGA product URLs must come from a search result
    // rather than being built.
    homepage: "https://www.iga.ca",
    supportsProductPages: true,
    supportsOnlinePricing: true,
    supportsStoreContext: true,
    priceReliability: "UNKNOWN",
    reliabilityNote:
      "No live request has ever succeeded from the development environment (egress blocked).",
  },
  provigo: {
    id: "provigo",
    name: "provigo",
    displayName: "Provigo",
    enabled: true,
    region: "Quebec",
    homepage: "https://www.provigo.ca",
    supportsProductPages: true,
    supportsOnlinePricing: true,
    supportsStoreContext: true,
    priceReliability: "UNKNOWN",
    reliabilityNote:
      "No live request has ever succeeded from the development environment (egress blocked).",
  },
};

export const RETAILER_IDS = Object.keys(RETAILERS) as RetailerId[];

export function getRetailer(id: RetailerId): RetailerConfig {
  const r = RETAILERS[id];
  if (!r) throw new Error(`Unknown retailer: ${id}`);
  return r;
}

export function enabledRetailers(): RetailerConfig[] {
  return RETAILER_IDS.map((id) => RETAILERS[id]).filter((r) => r.enabled);
}

/** Competitors = every enabled retailer except the one you are standing in. */
export function competitorsFor(current: RetailerId): RetailerConfig[] {
  return enabledRetailers().filter((r) => r.id !== current);
}

export function isRetailerId(value: string): value is RetailerId {
  return Object.prototype.hasOwnProperty.call(RETAILERS, value);
}
