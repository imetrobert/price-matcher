"use client";

/**
 * Shows who is signed in, or warns loudly when the instance is unprotected.
 *
 * The unprotected warning is not decoration: if this is ever visible on
 * pricecheck.imetrobert.com, anyone who finds the URL can use the app.
 */

import { useEffect, useState } from "react";

interface AuthStatus {
  configured: boolean;
  required: boolean;
  allowlistActive: boolean;
  email: string | null;
}

export function AuthBar() {
  const [status, setStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) =>
        setStatus({
          configured: Boolean(d?.auth?.configured),
          required: Boolean(d?.auth?.required),
          allowlistActive: Boolean(d?.auth?.allowlistActive),
          email: d?.auth?.email ?? null,
        }),
      )
      .catch(() => setStatus(null));
  }, []);

  if (!status) return null;

  if (!status.configured) {
    return (
      <div className="mb-4 rounded-2xl border-2 border-bad/40 bg-bad/5 p-3">
        <p className="text-sm font-extrabold uppercase tracking-wide text-bad">
          Unprotected instance
        </p>
        <p className="mt-1 text-sm text-bad/90">
          No sign-in is configured, so anyone who can reach this URL can use it.
          Fine on localhost; never deploy it this way.
        </p>
      </div>
    );
  }

  return (
    <>
      {!status.allowlistActive ? (
        <div className="mb-3 rounded-2xl border border-warn/30 bg-warn/5 p-3">
          <p className="text-sm font-bold text-warn">
            Open to everyone on the Supabase project
          </p>
          <p className="mt-1 text-sm text-warn/90">
            No CartMatch allowlist is set, so any confirmed user on this
            Supabase project can sign in — including anyone added later for a
            different app. Set <code>CARTMATCH_ALLOWED_EMAILS</code> to control
            it here.
          </p>
        </div>
      ) : null}

      <div className="mb-4 flex items-center justify-between gap-3 text-sm">
        <span className="truncate text-muted">
          {status.email ? `Signed in as ${status.email}` : "Signed in"}
        </span>
        <form action="/api/auth/signout" method="post">
          <button
            type="submit"
            className="shrink-0 font-semibold text-brand underline-offset-2 hover:underline"
          >
            Sign out
          </button>
        </form>
      </div>
    </>
  );
}
