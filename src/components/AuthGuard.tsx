"use client";

/**
 * Client-side sign-in gate.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SECURITY CONTROL
 * ---------------------------------------------------------------------------
 * On a static site the bundle is public and every check in it can be skipped
 * by anyone who wants to. This component exists so a signed-out person sees a
 * sign-in prompt instead of an empty broken screen. It protects the experience,
 * not the data.
 *
 * What actually protects things, and cannot be bypassed from a browser:
 *   - Supabase Edge Functions verify the JWT before spending a Gemini call.
 *   - Row Level Security decides which rows a session may read or write.
 *
 * The practical consequence: never put anything sensitive into the bundle on
 * the assumption that this component is hiding it. It is not.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { Notice, Spinner } from "@/components/ui";
import { authConfigured } from "@/lib/auth/config";
import { checkAppAccess } from "@/lib/auth/access";
import { getSession, signOut, type SessionUser } from "@/lib/auth/session";

type State =
  | { status: "checking" }
  | { status: "open" }
  | { status: "signed-out" }
  | { status: "denied"; user: SessionUser }
  | { status: "unavailable"; user: SessionUser; reason: string }
  | { status: "allowed"; user: SessionUser };

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;

    // Not configured at all: local development. Let the app through, and the
    // home screen shows a loud banner saying it is unprotected.
    if (!authConfigured()) {
      setState({ status: "open" });
      return;
    }

    (async () => {
      const { user } = await getSession();
      if (cancelled) return;
      if (!user) {
        setState({ status: "signed-out" });
        return;
      }

      const access = await checkAppAccess();
      if (cancelled) return;

      // Three outcomes, not two. "The check could not run" is not the same as
      // "you are not allowed", and telling someone they lack access when the
      // access model simply is not deployed sends them to ask for a grant they
      // already have.
      if (access.status === "unavailable") {
        setState({ status: "unavailable", user, reason: access.reason });
        return;
      }
      setState(
        access.status === "granted"
          ? { status: "allowed", user }
          : { status: "denied", user },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "checking") {
    return (
      <main className="pt-16">
        <Spinner label="Checking your session…" />
      </main>
    );
  }

  if (state.status === "signed-out") {
    return (
      <main className="pt-10">
        <h1 className="text-3xl font-extrabold tracking-tight">CartMatch</h1>
        <p className="mb-5 mt-1 text-muted">Sign in to continue.</p>
        <Link href="/login/" className="btn-primary">
          Sign in
        </Link>
      </main>
    );
  }

  if (state.status === "denied") {
    return (
      <main className="pt-10">
        <h1 className="text-3xl font-extrabold tracking-tight">CartMatch</h1>
        <p className="mb-5 mt-1 text-muted">
          Access not enabled for this account.
        </p>
        <div className="card">
          <p className="text-sm">
            You are signed in as{" "}
            <span className="font-semibold">{state.user.email}</span>, but that
            account has not been given access to CartMatch.
          </p>
          <p className="mt-3 text-sm text-muted">
            Access to CartMatch is granted per app, separately from having a
            Supabase account. Ask the owner to add a grant for your address.
          </p>
          <p className="mt-3 text-xs text-muted">
            If you have more than one account, you may simply be signed in with
            the wrong one.
          </p>
          <button
            type="button"
            className="btn-primary mt-4"
            onClick={async () => {
              await signOut();
              window.location.href = "/login/";
            }}
          >
            Sign out and try another account
          </button>
        </div>
      </main>
    );
  }

  if (state.status === "unavailable") {
    return (
      <main className="pt-10">
        <h1 className="text-3xl font-extrabold tracking-tight">CartMatch</h1>
        <p className="mb-5 mt-1 text-muted">Could not check your access.</p>
        <div className="card">
          <p className="text-sm">
            Signed in as{" "}
            <span className="font-semibold">{state.user.email}</span>, but{" "}
            <code>has_app_access(&apos;cartmatch&apos;)</code> did not answer. This
            is a deployment problem, not a permissions one — the app is not
            saying you lack access.
          </p>
          <p className="mt-3 rounded-xl bg-bad/5 px-3 py-2 text-xs text-bad">
            {state.reason}
          </p>
          <p className="mt-3 text-xs text-muted">
            Usually means the platform access model has not been applied to this
            Supabase project.
          </p>
        </div>
      </main>
    );
  }

  if (state.status === "open") {
    return (
      <>
        <div className="mb-4 rounded-2xl border-2 border-bad/40 bg-bad/5 p-3">
          <p className="text-sm font-extrabold uppercase tracking-wide text-bad">
            Unprotected instance
          </p>
          <p className="mt-1 text-sm text-bad/90">
            Supabase is not configured, so there is no sign-in and no data
            store. Fine on localhost; never publish it this way.
          </p>
        </div>
        {children}
      </>
    );
  }

  return <>{children}</>;
}

/** Shows who is signed in, with sign-out. Rendered inside the guard. */
export function AuthBar() {
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    getSession().then((s) => setUser(s.user));
  }, []);

  if (!authConfigured()) return null;

  // The "open to everyone" banner is gone with the email allowlist. It warned
  // about a state that can no longer occur: access is a row in app_access, and
  // absent means denied. There is no configuration to forget.
  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3 text-sm">
        <span className="truncate text-muted">
          {user?.email ? `Signed in as ${user.email}` : "Not signed in"}
        </span>
        {user ? (
          <button
            type="button"
            className="shrink-0 font-semibold text-brand underline-offset-2 hover:underline"
            onClick={async () => {
              await signOut();
              window.location.href = "/login/";
            }}
          >
            Sign out
          </button>
        ) : null}
      </div>
    </>
  );
}

export function NotConfiguredNotice() {
  if (authConfigured()) return null;
  return (
    <Notice tone="warn" title="Supabase not configured">
      Sign-in, photo recognition and the audit trail all need Supabase. The app
      runs in mock mode without it.
    </Notice>
  );
}
