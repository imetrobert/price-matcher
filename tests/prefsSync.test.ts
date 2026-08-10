/**
 * Preference sync between device and account.
 *
 * The rule under test is the conflict rule, because getting it backwards is
 * silent and infuriating: a postal code typed on the phone you are holding
 * must never be replaced by one saved from a laptop last week. Local wins, and
 * is pushed up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The suite runs in the `node` environment, which is fast and has no `window`.
 * prefs.ts touches exactly one browser API, so a five-line Map beats adding
 * jsdom as a dependency to every test run.
 */
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
      clear: () => memory.clear(),
    },
  },
});

const maybeSingle = vi.fn();
const upsert = vi.fn();
const getUser = vi.fn();

vi.mock("@/lib/auth/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ maybeSingle }),
      upsert,
    }),
    auth: { getUser },
  }),
}));

vi.mock("@/config/env", () => ({
  supabaseConfigured: () => configured,
}));

let configured = true;

const { reconcilePrefs, fetchRemotePrefs, pushRemotePrefs } = await import(
  "@/lib/prefsSync"
);
const { savePrefs, loadPrefs, DEFAULT_PREFS } = await import("@/lib/prefs");

function remoteReturns(row: unknown) {
  maybeSingle.mockResolvedValue({ data: row, error: null });
}

beforeEach(() => {
  window.localStorage.clear();
  maybeSingle.mockReset();
  upsert.mockReset().mockResolvedValue({ error: null });
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "user-1" } } });
  configured = true;
});

afterEach(() => {
  window.localStorage.clear();
});

describe("a device that already has a postal code", () => {
  it("keeps the local value even when the account disagrees", async () => {
    savePrefs({ ...DEFAULT_PREFS, postalCode: "H2X 1Y4" });
    remoteReturns({ postal_code: "H4A 1A1", language: "en", min_savings_cents: 50 });

    const result = await reconcilePrefs();

    expect(result.postalCode).toBe("H2X 1Y4");
  });

  it("pushes the local value up so other devices catch up", async () => {
    savePrefs({ ...DEFAULT_PREFS, postalCode: "H2X 1Y4" });
    remoteReturns({ postal_code: "H4A 1A1", language: "en", min_savings_cents: 50 });

    await reconcilePrefs();

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ postal_code: "H2X 1Y4", user_id: "user-1" }),
      expect.objectContaining({ onConflict: "user_id" }),
    );
  });

  it("does not push when the two already agree", async () => {
    savePrefs({ ...DEFAULT_PREFS, postalCode: "H4A 1A1" });
    remoteReturns({ postal_code: "H4A 1A1", language: "en", min_savings_cents: 50 });

    await reconcilePrefs();

    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("a device with nothing saved — the reason this feature exists", () => {
  it("adopts the account's postal code", async () => {
    remoteReturns({ postal_code: "H4A 1A1", language: "fr", min_savings_cents: 75 });

    const result = await reconcilePrefs();

    expect(result.postalCode).toBe("H4A 1A1");
    expect(result.language).toBe("fr");
    expect(result.minSavingsCents).toBe(75);
  });

  it("writes it to local storage so the next load is instant", async () => {
    remoteReturns({ postal_code: "H4A 1A1", language: "en", min_savings_cents: 50 });

    await reconcilePrefs();

    expect(loadPrefs().postalCode).toBe("H4A 1A1");
  });
});

describe("when the account has nothing either", () => {
  it("returns local untouched and asks for nothing", async () => {
    remoteReturns(null);

    const result = await reconcilePrefs();

    expect(result.postalCode).toBe("");
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("failure is never allowed to cost the user their settings", () => {
  it("treats a query error as 'nothing saved' rather than throwing", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(fetchRemotePrefs()).resolves.toBeNull();
  });

  it("keeps the local value when the remote read fails", async () => {
    savePrefs({ ...DEFAULT_PREFS, postalCode: "H2X 1Y4" });
    maybeSingle.mockRejectedValue(new Error("offline"));

    const result = await reconcilePrefs();

    expect(result.postalCode).toBe("H2X 1Y4");
  });

  it("swallows a failed push instead of breaking Save", async () => {
    upsert.mockResolvedValue({ error: { code: "42501", message: "denied" } });
    await expect(
      pushRemotePrefs({ ...DEFAULT_PREFS, postalCode: "H4A 1A1" }),
    ).resolves.toBeUndefined();
  });

  it("does nothing at all when Supabase is not configured", async () => {
    configured = false;
    await pushRemotePrefs({ ...DEFAULT_PREFS, postalCode: "H4A 1A1" });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("what gets sent to the database", () => {
  it("sends null rather than an empty string for an unset postal code", async () => {
    // The column has a format CHECK. An empty string is not a postal code and
    // would be rejected, failing every sync for someone who has not set one.
    await pushRemotePrefs({ ...DEFAULT_PREFS, postalCode: "" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ postal_code: null }),
      expect.anything(),
    );
  });

  it("never sends coordinates", async () => {
    await pushRemotePrefs({ ...DEFAULT_PREFS, postalCode: "H4A 1A1" });
    const sent = JSON.stringify(upsert.mock.calls[0]?.[0] ?? {});
    expect(sent).not.toMatch(/lat|lon|coord/i);
  });

  it("leaves updated_at to the database", async () => {
    // A trigger sets it from the database clock. Sending it from here would
    // record whatever the phone thinks the time is, chosen by code that anyone
    // with the publishable key can call.
    await pushRemotePrefs({ ...DEFAULT_PREFS, postalCode: "H4A 1A1" });
    expect(upsert.mock.calls[0]?.[0]).not.toHaveProperty("updated_at");
  });
});
