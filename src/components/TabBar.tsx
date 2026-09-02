"use client";

/**
 * The app's three destinations, always reachable: Cart (scanning and
 * uploading flyers — where the shopping actually happens), Settings
 * (postal code, current store, minimum savings), and Search (product name
 * across every source).
 *
 * ---------------------------------------------------------------------------
 * TOP, NOT BOTTOM — AND WHY IT LOOKS LIKE THIS
 * ---------------------------------------------------------------------------
 * Originally a slim fixed bar at the bottom of the screen, in the same
 * spot every native app puts tab navigation. Moved to the top and given a
 * solid, high-contrast pill for the active tab on request — the subtle
 * bottom-bar version was easy to miss entirely on a first look. A
 * segmented-control look (one rounded container, one filled pill) reads as
 * "you are here" at a glance in a way three quiet text links in a row do
 * not.
 *
 * Deliberately not on every screen. The scan flow, checkout mode (shown
 * directly to a cashier), the deals comparison, saved carts, and the
 * confirm-prices queue are all reached FROM the Cart tab, not siblings of
 * it — tabs on top of an in-progress scan or a cashier-facing screen would
 * compete with the one thing that screen exists to do. Present this only
 * on the three tab destinations themselves: page.tsx, setup/page.tsx,
 * search/page.tsx — and at the TOP of each, before anything else, since
 * that is the whole point of moving it.
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
      className="mb-4 flex gap-1 rounded-2xl bg-line/60 p-1"
      aria-label="Main"
    >
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex-1 rounded-xl py-2.5 text-center text-sm font-bold transition ${
              active
                ? "bg-good text-white shadow-sm"
                : "text-ink/70 active:bg-line"
            }`}
            aria-current={active ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
