/**
 * Auth gate.
 *
 * Runs before every request that is not a static asset. Two jobs:
 *   1. Refresh the Supabase session cookie (tokens are short-lived; without
 *      this, a tab left open in a store logs itself out mid-shop).
 *   2. Redirect anyone without a session to /login.
 *
 * FAIL CLOSED: if auth is required but not configured, this returns 503 rather
 * than serving the app. A missing environment variable on a deployment must
 * never quietly result in an open instance.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import {
  authRequired,
  emailAllowed,
  isPublicPath,
  publicAuthConfig,
} from "@/lib/auth/config";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const cfg = publicAuthConfig();
  const required = authRequired();

  if (!cfg) {
    if (required) {
      return new NextResponse(
        "CartMatch is configured to require sign-in, but Supabase auth is not set up. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
        { status: 503, headers: { "Content-Type": "text/plain" } },
      );
    }
    // Local development with no keys: the app runs unprotected and says so in
    // the UI (see the banner on the home screen).
    return NextResponse.next();
  }

  // This response object is what carries refreshed cookies back to the client.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(cfg.url, cfg.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Revalidates the token and refreshes it if needed. Do not remove.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublicPath(pathname)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    // Send the shopper back where they were once signed in.
    loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  // Signed in to the Supabase project, but not admitted to THIS app.
  //
  // Deliberately NOT a redirect to /login: the session is valid, so /login
  // would bounce straight back here and spin. It has to be a distinct terminal
  // state the person can actually read and act on.
  if (user && !emailAllowed(user.email)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Your account is not authorised for CartMatch. Ask the owner to add your email to CARTMATCH_ALLOWED_EMAILS.",
        },
        { status: 403 },
      );
    }
    if (pathname !== "/not-authorized") {
      const denied = request.nextUrl.clone();
      denied.pathname = "/not-authorized";
      denied.search = "";
      return NextResponse.redirect(denied);
    }
    return response;
  }

  // Already signed in and sitting on /login — go to the app.
  if (user && pathname === "/login") {
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    return NextResponse.redirect(home);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next.js internals and static files. Keeping images out
     * matters: running auth on every icon request would triple the round trips
     * on a phone in a store with poor signal.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
