import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The offer parser lives here because the scheduled worker runs it too.
      // Tests exercise the same file both runtimes use, not a copy of it.
      "@shared": path.resolve(__dirname, "./supabase/functions/_shared"),
      // `server-only` throws when imported outside a React Server Component.
      // Tests exercise the pure domain logic directly, so it is stubbed out.
      "server-only": path.resolve(__dirname, "./tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
