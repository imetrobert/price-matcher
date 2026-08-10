/**
 * Adapter registry — the single place that decides which implementation
 * serves a given retailer.
 *
 * Failure isolation (spec §36) lives here: `safeHealth` and the pipeline only
 * ever talk to adapters through this module, so one broken retailer degrades
 * that retailer's row and nothing else.
 */

import { env } from "@/config/env";
import { RETAILER_IDS, enabledRetailers, getRetailer } from "@/config/retailers";
import { LiveRetailerAdapter } from "@/services/retailers/liveAdapter";
import { MockRetailerAdapter } from "@/services/retailers/mockAdapter";
import type {
  AdapterHealth,
  DataMode,
  RetailerAdapter,
  RetailerId,
} from "@/types";

const liveCache = new Map<RetailerId, RetailerAdapter>();
const mockCache = new Map<RetailerId, RetailerAdapter>();

export function getAdapter(
  retailerId: RetailerId,
  mode: DataMode = env.dataMode,
): RetailerAdapter {
  if (mode === "MOCK") {
    let a = mockCache.get(retailerId);
    if (!a) {
      a = new MockRetailerAdapter(retailerId);
      mockCache.set(retailerId, a);
    }
    return a;
  }
  let a = liveCache.get(retailerId);
  if (!a) {
    a = new LiveRetailerAdapter(retailerId);
    liveCache.set(retailerId, a);
  }
  return a;
}

export function allAdapters(mode: DataMode = env.dataMode): RetailerAdapter[] {
  return enabledRetailers().map((r) => getAdapter(r.id, mode));
}

/**
 * health() that can never throw. A retailer whose adapter blows up is reported
 * as UNAVAILABLE with the thrown message, not propagated up the stack.
 */
export async function safeHealth(
  adapter: RetailerAdapter,
): Promise<AdapterHealth> {
  try {
    return await adapter.health();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      retailerId: adapter.retailerId,
      status: "UNAVAILABLE",
      reason: `${getRetailer(adapter.retailerId).displayName} price service temporarily unavailable — ${message}`,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

/** Health for every configured retailer, probed in parallel. */
export async function healthReport(
  mode: DataMode = env.dataMode,
): Promise<AdapterHealth[]> {
  const results = await Promise.all(
    RETAILER_IDS.map((id) => safeHealth(getAdapter(id, mode))),
  );
  return results;
}
