/**
 * What may be fetched, and what may not.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE WITH ITS OWN TESTS
 * ---------------------------------------------------------------------------
 * An Edge Function that fetches a URL somebody typed is a request-forger's
 * favourite shape: it runs on somebody else's network, with that network's
 * routing table, and it will happily fetch things a browser could never reach
 * — a metadata endpoint, a private address, another service inside the same
 * infrastructure. Requiring a signed-in account narrows who can ask; it does
 * not change what the fetch can reach.
 *
 * So the rules live here as pure functions, compiled by both Deno and Node,
 * and tested. A rule nobody can run is a rule nobody can check.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is not a defence against a determined attacker who controls DNS: a name
 * that resolves to a private address at connection time will pass these checks,
 * because the checks happen before the lookup. It raises the floor against
 * mistakes and casual probing, which is what it is for. The people who can
 * reach this function are the owner and the accounts they granted access to.
 */

/**
 * Hosts any member may fetch from.
 *
 * Kept short and specific. raddar.ca is where this app's flyers actually come
 * from; the rest are the blob hosts the retailers' own sites serve PDFs from,
 * observed while measuring them. Anything else needs app_admin.
 */
export const FLYER_HOSTS = [
  "raddar.ca",
  "www.raddar.ca",
  "cdn.raddar.ca",
  "flyers.raddar.ca",
  // Loblaw family (Maxi, Provigo) — the PDFs sit on plain blob storage.
  "storage.flipp.com",
  "f.wishabi.net",
  "images.wishabi.com",
  // Metro / Super C.
  "metro.ca",
  "www.metro.ca",
  "superc.ca",
  "www.superc.ca",
  // IGA (Sobeys Quebec).
  "iga.net",
  "www.iga.net",
];

export type UrlVerdict =
  | { ok: true; url: string; filename: string }
  | { ok: false; reason: string };

/**
 * Addresses that must never be fetched, whoever is asking.
 *
 * Loopback, link-local (which is where cloud metadata lives), and the three
 * private ranges. Admin does not lift this: the point of an admin exception is
 * to reach a flyer on a host nobody listed, not to reach the inside of the
 * machine doing the fetching.
 */
function isForbiddenHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return true;
  }
  if (h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;

  // Bare IPv4. Anything in a private or link-local range is refused; a public
  // literal is allowed, since some blob hosts are addressed that way.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  // IPv6 literals are refused wholesale rather than parsed. No flyer host has
  // ever been one, and half-understanding an address format is how a range
  // gets missed.
  if (h.startsWith("[")) return true;

  // A host with no dot is a name only resolvable inside a private network.
  return !h.includes(".");
}

/**
 * Check a pasted link.
 *
 * `isAdmin` widens the host rule and nothing else — scheme, address and
 * filename rules apply to everybody.
 */
export function checkPdfUrl(input: string, isAdmin: boolean): UrlVerdict {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "Empty link." };
  if (trimmed.length > 2000) return { ok: false, reason: "That link is absurdly long." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That is not a URL. It must start with https://" };
  }

  // https only. http would send the request in clear and, more to the point,
  // is what a redirect to an internal service tends to look like.
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "Only https:// links can be fetched." };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "Links with credentials in them are refused." };
  }

  if (isForbiddenHost(parsed.hostname)) {
    return { ok: false, reason: "That address is not reachable from here." };
  }

  if (!isAdmin && !FLYER_HOSTS.includes(parsed.hostname.toLowerCase())) {
    return {
      ok: false,
      reason: `${parsed.hostname} is not one of the known flyer sites. An admin can fetch any link; ask them, or download the PDF and choose the file instead.`,
    };
  }

  return { ok: true, url: parsed.toString(), filename: filenameFromUrl(parsed) };
}

/**
 * A filename for the fetched bytes.
 *
 * This matters more than it looks. The import reads the store and the week out
 * of the filename before it renders a single page, so a link ending in
 * "maxi-wk33-2026.pdf" arrives already identified, exactly as the downloaded
 * file would have. A URL with nothing usable in it falls back to the host,
 * which is still better than "download.pdf" — and the cover page is read
 * either way.
 */
export function filenameFromUrl(parsed: URL): string {
  const last = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  const decoded = safeDecode(last);
  const cleaned = decoded.replace(/[^\w\-. ]+/g, " ").trim();

  if (cleaned !== "" && /\.pdf$/i.test(cleaned)) return cleaned.slice(0, 120);
  if (cleaned !== "") return `${cleaned.slice(0, 116)}.pdf`;
  return `${parsed.hostname.replace(/[^\w.-]/g, "")}.pdf`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The largest PDF worth accepting. A weekly flyer is single-digit megabytes. */
export const MAX_PDF_BYTES = 40 * 1024 * 1024;

/**
 * Is this actually a PDF?
 *
 * Content-Type is a claim, so the bytes are checked too: every PDF begins
 * "%PDF-". A site that answers a bad link with a courteous HTML error page
 * returns 200, and without this the import would try to render it as a flyer
 * and report something incomprehensible.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}
