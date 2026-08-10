"use client";

/**
 * Postal code and nearby-store lookups, via the cartmatch-location Edge
 * Function.
 *
 * The browser never talks to OpenStreetMap directly: Nominatim's usage policy
 * requires an identifying User-Agent, which fetch forbids a page from setting,
 * and routing through the function means OSM sees Supabase's address rather
 * than the shopper's.
 *
 * Coordinates are used and dropped. `locatePostalCode()` holds a position just
 * long enough to exchange it for a postal code and never returns, stores or
 * logs it — the postal code is what the app needs, and a kept coordinate would
 * be location history.
 */

import { edgeFunctionUrl, supabaseConfigured } from "@/config/env";
import { getAccessToken } from "@/lib/auth/session";
import { env } from "@/config/env";

export interface NearbyStore {
  id: string;
  name: string;
  brand: string | null;
  address: string | null;
  distanceM: number;
}

export type LocationOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

/** GPS permission takes a moment; anything longer than this is a hang. */
const GEO_TIMEOUT_MS = 12_000;

async function call<T>(body: unknown): Promise<LocationOutcome<T>> {
  if (!supabaseConfigured()) {
    return { ok: false, error: "Supabase is not configured." };
  }
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, error: "Sign in first." };
  }

  try {
    const res = await fetch(edgeFunctionUrl("cartmatch-location"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        apikey: env.supabaseAnonKey,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        code: data?.code,
        error: data?.error ?? `Lookup failed (HTTP ${res.status}).`,
      };
    }
    return { ok: true, data: data as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Lookup failed.",
    };
  }
}

/**
 * Ask the device where it is, and return only the postal code.
 *
 * Every failure here is ordinary — permission refused, indoors with no fix,
 * a spot OSM has no postcode for — so each one says what to do instead rather
 * than reporting an error the user cannot act on. Typing six characters is
 * always available and always works.
 */
export async function locatePostalCode(): Promise<LocationOutcome<string>> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return { ok: false, error: "This browser cannot report a location." };
  }

  let position: GeolocationPosition;
  try {
    position = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        // A postal code is a neighbourhood. Demanding a high-accuracy fix
        // would drain battery and stall indoors for precision that is then
        // immediately thrown away.
        enableHighAccuracy: false,
        timeout: GEO_TIMEOUT_MS,
        maximumAge: 5 * 60 * 1000,
      });
    });
  } catch (err) {
    const code = (err as GeolocationPositionError)?.code;
    if (code === 1) {
      return {
        ok: false,
        error:
          "Location permission was refused. Type your postal code instead, or allow location for this site in your browser settings.",
      };
    }
    if (code === 3) {
      return {
        ok: false,
        error: "Locating timed out — common indoors. Type your postal code instead.",
      };
    }
    return {
      ok: false,
      error: "Could not get a location fix. Type your postal code instead.",
    };
  }

  const result = await call<{ postalCode: string }>({
    action: "reverse",
    lat: position.coords.latitude,
    lon: position.coords.longitude,
  });
  // `position` goes out of scope here and is never stored anywhere.

  return result.ok
    ? { ok: true, data: result.data.postalCode }
    : { ok: false, error: result.error, code: result.code };
}

export interface NearbyStoresResult {
  stores: NearbyStore[];
  attribution: string;
}

export async function nearbyStores(
  postalCode: string,
): Promise<LocationOutcome<NearbyStoresResult>> {
  const result = await call<NearbyStoresResult>({
    action: "stores",
    postalCode,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    data: {
      stores: result.data.stores ?? [],
      // Never blank. ODbL requires attribution wherever this data is shown,
      // so the fallback is the licence text rather than an empty string.
      attribution: result.data.attribution || "© OpenStreetMap contributors",
    },
  };
}

/** "1.2 km" / "450 m" — for a list you read while walking. */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${metres} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
