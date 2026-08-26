"use client";

/**
 * The app's three destinations, always reachable, always visible: Cart
 * (scanning and uploading flyers — where the shopping actually happens),
 * Settings (postal code, current store, minimum savings), and Search
 * (product name across every source).
 *
 * Deliberately not on every screen. The scan flow, checkout mode (shown
 * directly to a cashier), the deals comparison, saved carts, and the
 * confirm-prices queue are all reached FROM the Cart tab, not siblings of
 * it — a tab bar on top of an in-progress scan or a till-facing screen
 * would compete with the one thing that screen exists to do. Present this
 * only on the three tab destinations themselves: page.tsx, setup/page.tsx,
 * search/page.tsx.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Cart" },
  { href: "/setup", label: "Settings" },
  { href: "/search", label: "Search" },
] as const;

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-[#f6f7f9]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Main"
    >
      <div className="mx-auto flex max-w-[560px]">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex-1 py-3 text-center text-sm font-semibold ${
                active ? "text-good" : "text-muted"
              }`}
              aria-current={active ? "page" : undefined}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
