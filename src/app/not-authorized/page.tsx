/**
 * Terminal state for someone with a valid Supabase session who is not on this
 * app's allowlist.
 *
 * Deliberately NOT a redirect back to /login: their session is perfectly good,
 * so /login would send them straight back here and the two would ping-pong.
 * This is a page they can read, showing which account was rejected (people
 * routinely have two) and offering the way out.
 *
 * Server-rendered so the email comes from Supabase's verified token rather
 * than anything the client could set.
 */

import Link from "next/link";

import { allowlistActive } from "@/lib/auth/config";
import { getSignedInIdentity } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function NotAuthorizedPage() {
  const identity = await getSignedInIdentity();

  return (
    <main className="pt-10">
      <header className="mb-5">
        <h1 className="text-3xl font-extrabold tracking-tight">CartMatch</h1>
        <p className="mt-1 text-muted">Access not enabled for this account.</p>
      </header>

      <div className="card">
        <p className="text-sm">
          You are signed in
          {identity?.email ? (
            <>
              {" "}
              as <span className="font-semibold">{identity.email}</span>
            </>
          ) : null}
          , but that account has not been given access to CartMatch.
        </p>

        {allowlistActive() ? (
          <p className="mt-3 text-sm text-muted">
            CartMatch keeps its own list of who may use it, separate from the
            Supabase project. Ask the owner to add your email address, then sign
            in again.
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted">
            No allowlist is currently configured, so this page should not have
            appeared. If you are the owner, check{" "}
            <code>CARTMATCH_ALLOWED_EMAILS</code>.
          </p>
        )}

        <p className="mt-3 text-xs text-muted">
          If you have more than one account, you may simply be signed in with
          the wrong one.
        </p>

        <form action="/api/auth/signout" method="post" className="mt-4">
          <button type="submit" className="btn-primary">
            Sign out and try another account
          </button>
        </form>

        <Link href="/login" className="btn-ghost mt-2">
          Back to sign-in
        </Link>
      </div>
    </main>
  );
}
