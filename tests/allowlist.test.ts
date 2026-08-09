/**
 * Per-app allowlist.
 *
 * Supabase Auth is project-scoped, so without this a valid session for ANY app
 * on the project is a valid session for CartMatch. These tests pin the two
 * halves of the contract: unset admits everyone (so a forgotten variable
 * cannot lock the owner out), and set admits exactly the listed addresses.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  allowedEmails,
  allowlistActive,
  emailAllowed,
  isPublicPath,
} from "@/lib/auth/config";

const ORIGINAL = process.env.CARTMATCH_ALLOWED_EMAILS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CARTMATCH_ALLOWED_EMAILS;
  else process.env.CARTMATCH_ALLOWED_EMAILS = ORIGINAL;
});

function setList(value: string | undefined) {
  if (value === undefined) delete process.env.CARTMATCH_ALLOWED_EMAILS;
  else process.env.CARTMATCH_ALLOWED_EMAILS = value;
}

describe("when no allowlist is configured", () => {
  it("is reported as inactive so the UI can warn about it", () => {
    setList(undefined);
    expect(allowlistActive()).toBe(false);
    expect(allowedEmails()).toEqual([]);
  });

  it("admits any authenticated user rather than locking the owner out", () => {
    setList(undefined);
    expect(emailAllowed("owner@example.com")).toBe(true);
    expect(emailAllowed("someone-else@example.com")).toBe(true);
  });

  it("treats an empty or whitespace value as unset", () => {
    setList("");
    expect(allowlistActive()).toBe(false);
    setList("   ,  , ");
    expect(allowlistActive()).toBe(false);
    expect(emailAllowed("anyone@example.com")).toBe(true);
  });
});

describe("when an allowlist is configured", () => {
  it("admits a listed address and refuses an unlisted one", () => {
    setList("owner@example.com,trusted@example.com");
    expect(allowlistActive()).toBe(true);
    expect(emailAllowed("owner@example.com")).toBe(true);
    expect(emailAllowed("trusted@example.com")).toBe(true);
    // The exact scenario this feature exists for: a real, confirmed user of
    // ANOTHER app on the same Supabase project.
    expect(emailAllowed("contractor-on-another-app@example.com")).toBe(false);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    setList("  Owner@Example.COM ,  trusted@example.com  ");
    expect(emailAllowed("owner@example.com")).toBe(true);
    expect(emailAllowed("OWNER@EXAMPLE.COM")).toBe(true);
    expect(emailAllowed(" owner@example.com ")).toBe(true);
  });

  it("refuses an account with no email address", () => {
    setList("owner@example.com");
    expect(emailAllowed(null)).toBe(false);
    expect(emailAllowed(undefined)).toBe(false);
    expect(emailAllowed("")).toBe(false);
  });

  it("does not admit on a partial or substring match", () => {
    setList("owner@example.com");
    expect(emailAllowed("owner@example.com.attacker.test")).toBe(false);
    expect(emailAllowed("not-owner@example.com")).toBe(false);
    expect(emailAllowed("owner@example.co")).toBe(false);
  });

  it("handles a single-entry list, the common case", () => {
    setList("owner@example.com");
    expect(allowedEmails()).toEqual(["owner@example.com"]);
    expect(emailAllowed("owner@example.com")).toBe(true);
    expect(emailAllowed("anyone@example.com")).toBe(false);
  });
});

describe("denial route reachability", () => {
  it("keeps /not-authorized public so a denied user does not loop", () => {
    // If this were gated, the middleware would redirect a denied user to a
    // page that itself redirects them, forever.
    expect(isPublicPath("/not-authorized")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
  });

  it("still gates the real app routes", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/scan")).toBe(false);
    expect(isPublicPath("/admin")).toBe(false);
    expect(isPublicPath("/api/pipeline")).toBe(false);
  });
});
