/** @type {import('next').NextConfig} */

/**
 * Static export, for GitHub Pages.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COSTS, AND WHERE THE SECURITY WENT
 * ---------------------------------------------------------------------------
 * GitHub Pages serves files. There is no server, so `output: "export"` rules
 * out middleware, route handlers and any server-side secret. The auth
 * middleware that used to gate every request is gone.
 *
 * That is not a loss of security so much as a relocation of it. On a static
 * site, hiding a page in JavaScript protects nothing — the bundle is
 * downloadable and readable. So the boundary moved to where it actually holds:
 *
 *   - Secrets (Gemini) live in Supabase Edge Functions, which verify the
 *     caller's JWT before doing any work.
 *   - Data lives behind Supabase Row Level Security, enforced by Postgres.
 *   - The client-side AuthGuard is UX only: it stops a signed-out person
 *     seeing an empty app. It is NOT a security control, and the code says so
 *     wherever it appears.
 *
 * Nothing in the published bundle is worth stealing: the only key it carries
 * is the Supabase publishable key, which is designed to be public and is
 * powerless without a session.
 *
 * NOTE ON HEADERS: `headers()` does not run under `output: "export"`, and
 * GitHub Pages cannot set custom response headers at all. The security headers
 * this project used to send (HSTS, X-Frame-Options, Permissions-Policy) are
 * therefore not available on Pages. Pages does serve HTTPS with HSTS of its
 * own for github.io; for a custom domain, enforce HTTPS in the Pages settings.
 */
const nextConfig = {
  reactStrictMode: true,

  output: "export",

  // No server means no on-demand image optimisation.
  images: { unoptimized: true },

  // Pages serves /path/ as /path/index.html; trailing slashes keep deep links
  // working when someone refreshes on, say, /checkout.
  trailingSlash: true,

  // Only needed when serving from https://<user>.github.io/<repo>/ rather than
  // a custom domain. With pricecheck.imetrobert.com this must stay unset —
  // setting it would break every asset path.
  ...(process.env.NEXT_PUBLIC_BASE_PATH
    ? {
        basePath: process.env.NEXT_PUBLIC_BASE_PATH,
        assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH,
      }
    : {}),
};

export default nextConfig;
