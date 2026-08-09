/**
 * POST /api/auth/signout — clear the Supabase session cookie.
 *
 * POST rather than GET so a prefetch or a link crawler cannot sign the user
 * out by accident.
 */

import { NextResponse } from "next/server";

import { createServerSupabase } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  if (supabase) {
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", request.url), {
    status: 303,
  });
}
