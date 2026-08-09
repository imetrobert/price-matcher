/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Server-only secrets are never added to `env` here on purpose — they are read
  // from process.env inside server code only (see src/config/env.ts).
};

export default nextConfig;
