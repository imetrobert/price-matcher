/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Server-only secrets are never added to `env` here on purpose — they are
  // read from process.env inside server code only (see src/config/env.ts).
  // Only NEXT_PUBLIC_* values reach the browser, and the only one that does is
  // the Supabase anon key, which is designed to be public.

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The app is a personal tool behind a login; there is no reason for
          // it to be embeddable anywhere.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            // Camera is needed for cart photos. Everything else is off.
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(), payment=()",
          },
          {
            // Only meaningful over HTTPS; harmless on localhost.
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        // Never let a proxy or browser cache a price comparison.
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
};

export default nextConfig;
