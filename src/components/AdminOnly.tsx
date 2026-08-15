"use client";

/**
 * The debug view, for people who hold app_admin and nobody else.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT
 * ---------------------------------------------------------------------------
 * It is a door, not a wall. Everything it hides is still reachable by anybody
 * who knows the URL and can defeat a client-side check, which is anybody who
 * can open the developer console. So this stops an ordinary member wandering
 * in; it does not stop a determined one.
 *
 * The wall is elsewhere and is the reason that is acceptable. Every row this
 * screen can display is governed by Row Level Security, and every Edge
 * Function it can call checks has_app_access('cartmatch') for itself. Somebody
 * who forces their way past this component sees their own data through a
 * screen with technical labels on it — untidy, not a breach.
 *
 * The one thing worth tightening beyond this is the retailer probe, which
 * fetches arbitrary URLs from an allow-list. That check belongs in the Edge
 * Function, where it cannot be bypassed, rather than here.
 *
 * ---------------------------------------------------------------------------
 * WHY IT NAMES THE ROLE IT FOUND
 * ---------------------------------------------------------------------------
 * A gate that says only "not allowed" to the person who built the app is a
 * gate that gets removed in frustration. Saying "you hold member" turns a
 * lockout into a one-line fix, and tells the truth about why.
 */

import { useEffect, useState } from "react";

import { checkAppAccess } from "@/lib/auth/access";

type Verdict =
  | { state: "checking" }
  | { state: "admin" }
  | { state: "refused"; role: string }
  | { state: "unavailable"; reason: string };

export function AdminOnly({ children }: { children: React.ReactNode }) {
  const [verdict, setVerdict] = useState<Verdict>({ state: "checking" });

  useEffect(() => {
    let live = true;
    checkAppAccess()
      .then((access) => {
        if (!live) return;
        if (access.status === "granted") {
          setVerdict(
            access.role === "app_admin"
              ? { state: "admin" }
              : { state: "refused", role: access.role },
          );
          return;
        }
        if (access.status === "denied") {
          setVerdict({ state: "refused", role: "no access to this app" });
          return;
        }
        // Could not ask. Refusing is the safe reading of an unanswered
        // question, and the reason is shown rather than swallowed.
        setVerdict({
          state: "unavailable",
          reason: access.reason ?? "The access check did not answer.",
        });
      })
      .catch((err) =>
        live &&
        setVerdict({
          state: "unavailable",
          reason: err instanceof Error ? err.message : "The access check failed.",
        }),
      );
    return () => {
      live = false;
    };
  }, []);

  if (verdict.state === "checking") {
    return <p className="text-sm text-muted">Checking your access…</p>;
  }

  if (verdict.state === "admin") return <>{children}</>;

  return (
    <section className="card border border-warn/40">
      <p className="font-bold text-warn">Developer view — admins only</p>
      <p className="mt-2 text-sm text-muted">
        {verdict.state === "refused"
          ? `This screen is limited to accounts holding app_admin on cartmatch. Yours holds: ${verdict.role}.`
          : `Your access could not be checked, so this screen stays closed. ${verdict.reason}`}
      </p>
      <p className="mt-2 text-xs text-muted">
        {/*
          Where the grant lives, not the SQL to change it. The app_access table
          belongs to the shared platform repository and this app does not own
          its shape — inventing an UPDATE for it here would be a guess printed
          as an instruction.
        */}
        Roles come from <code>public.app_access</code>, managed in the
        Supabase-platform repository. To see what your account holds, run{" "}
        <code>select * from public.app_access;</code> in the SQL editor.
      </p>
    </section>
  );
}
