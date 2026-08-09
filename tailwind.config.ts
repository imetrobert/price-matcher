import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b1220",
        surface: "#ffffff",
        muted: "#5b6577",
        line: "#e3e7ee",
        brand: "#0f766e",
        brandDark: "#0b5a54",
        good: "#116d3a",
        warn: "#8a5a00",
        bad: "#a01a1a",
        mock: "#6d28d9",
      },
      fontSize: {
        // Checkout Mode needs to be readable at arm's length in a store.
        checkout: ["2.75rem", { lineHeight: "1.05", fontWeight: "800" }],
      },
    },
  },
  plugins: [],
};

export default config;
