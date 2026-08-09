"use client";

/**
 * Sign-in with the same Supabase credentials as your other apps on the project.
 *
 * Email + password only. There is deliberately no sign-up form: accounts are
 * created in your Supabase dashboard (or already exist from another app), and
 * a public sign-up on a personal tool is an invitation to strangers.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Notice } from "@/components/ui";
import { createClient } from "@/lib/auth/client";
import { authConfigured } from "@/lib/auth/config";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = authConfigured();

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) {
        // Supabase returns a deliberately vague message for bad credentials;
        // pass it through rather than inventing a friendlier but less accurate one.
        setError(signInError.message);
        return;
      }
      // Full navigation so the middleware sees the new cookie.
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pt-10">
      <header className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight">CartMatch</h1>
        <p className="mt-1 text-muted">Sign in to continue.</p>
      </header>

      {!configured ? (
        <Notice tone="error" title="Sign-in is not configured">
          This deployment has no Supabase auth keys. Set
          <code className="mx-1">NEXT_PUBLIC_SUPABASE_URL</code> and
          <code className="mx-1">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>.
        </Notice>
      ) : (
        <form onSubmit={signIn} className="card space-y-3">
          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="field"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="field"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error ? (
            <p className="rounded-xl bg-bad/5 px-3 py-2 text-sm text-bad">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>

          <p className="text-xs text-muted">
            Uses the same account as your other apps on this Supabase project.
            Accounts are managed in the Supabase dashboard.
          </p>
        </form>
      )}
    </main>
  );
}
