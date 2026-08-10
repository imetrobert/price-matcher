/**
 * Per-app access, read from public.app_access.
 *
 * Supabase Auth is project-scoped and six apps share this project, so a valid
 * session proves only that someone has an account SOMEWHERE — not that they
 * belong in CartMatch. These tests pin the part that is easy to get wrong: the
 * three-way outcome. A failed check must never read as either granted or
 * denied, because collapsing it in one direction opens the app and in the other
 * tells someone with a valid grant to go ask for one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/lib/auth/client", () => ({
  createClient: () => ({ rpc }),
}));

vi.mock("@/config/env", () => ({
  supabaseConfigured: () => configured,
}));

let configured = true;

const { checkAppAccess, APP_NAME } = await import("@/lib/auth/access");

beforeEach(() => {
  rpc.mockReset();
  configured = true;
});

/** has_app_access resolves first, app_role second. */
function respond(
  access: { data: unknown; error?: { message: string } | null },
  role: { data: unknown } = { data: "member" },
) {
  rpc
    .mockResolvedValueOnce({ error: null, ...access })
    .mockResolvedValueOnce({ error: null, ...role });
}

describe("a granted account", () => {
  it("is allowed, and reports its role", async () => {
    respond({ data: true }, { data: "app_admin" });
    await expect(checkAppAccess()).resolves.toEqual({
      status: "granted",
      role: "app_admin",
    });
  });

  it("asks about this app by name", async () => {
    respond({ data: true });
    await checkAppAccess();
    expect(rpc).toHaveBeenCalledWith("has_app_access", {
      app_name: APP_NAME,
    });
  });

  it("falls back to 'member' when the role cannot be read", async () => {
    // A missing role is not a reason to lock someone out of an app they have
    // been granted; it only costs them the admin-only widening of reads.
    respond({ data: true }, { data: null });
    await expect(checkAppAccess()).resolves.toEqual({
      status: "granted",
      role: "member",
    });
  });
});

describe("an account with no grant", () => {
  it("is denied", async () => {
    respond({ data: false });
    await expect(checkAppAccess()).resolves.toEqual({ status: "denied" });
  });

  it("is denied when the function returns null rather than false", async () => {
    respond({ data: null });
    await expect(checkAppAccess()).resolves.toEqual({ status: "denied" });
  });

  it("requires exactly true — a truthy value is not a grant", async () => {
    // PostgREST hands back whatever the function returned. Anything other than
    // a real boolean true means something unexpected happened, and unexpected
    // must not read as permission.
    respond({ data: "true" });
    await expect(checkAppAccess()).resolves.toEqual({ status: "denied" });
    rpc.mockReset();
    respond({ data: 1 });
    await expect(checkAppAccess()).resolves.toEqual({ status: "denied" });
  });
});

describe("when the check itself cannot run", () => {
  it("is unavailable, not denied, when the function is missing", async () => {
    respond({
      data: null,
      error: { message: 'function public.has_app_access(text) does not exist' },
    });
    const result = await checkAppAccess();
    expect(result.status).toBe("unavailable");
    expect(result).not.toEqual({ status: "denied" });
  });

  it("is unavailable, not granted, when the call throws", async () => {
    rpc.mockRejectedValueOnce(new Error("network down"));
    const result = await checkAppAccess();
    expect(result.status).toBe("unavailable");
    // The failure that would matter: an outage silently admitting everyone.
    expect(result.status).not.toBe("granted");
  });

  it("carries the reason so the UI can say what actually broke", async () => {
    respond({ data: null, error: { message: "permission denied for schema" } });
    const result = await checkAppAccess();
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "permission denied for schema",
    });
  });

  it("does not call the database when Supabase is unconfigured", async () => {
    configured = false;
    const result = await checkAppAccess();
    expect(result.status).toBe("unavailable");
    expect(rpc).not.toHaveBeenCalled();
  });
});
