import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "CartMatch",
  description: "Find grocery price matches before you pay — Montreal.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0f766e",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto min-h-dvh w-full max-w-[560px] px-4 pb-10 pt-4">
          {children}
        </div>
      </body>
    </html>
  );
}
