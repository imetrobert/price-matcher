/**
 * What the flyer fetcher will and will not go and get.
 *
 * These are the rules of a server-side fetch of a URL somebody typed, which is
 * the shape most likely to be turned into a request forger. Every refusal
 * below is a thing that must stay refused; every acceptance is a thing a
 * shopper legitimately needs to import their week's flyers.
 */

import { describe, expect, it } from "vitest";

import { splitUrls } from "@/services/flyers/fetchByUrl";
import {
  FLYER_HOSTS,
  MAX_PDF_BYTES,
  checkPdfUrl,
  filenameFromUrl,
  looksLikePdf,
} from "@shared/pdfUrl";

describe("addresses that must never be fetched", () => {
  // Admin is passed as TRUE throughout: these must be refused for everybody,
  // and testing them as a member would prove only that the host list works.
  const forbidden = [
    "https://localhost/flyer.pdf",
    "https://something.localhost/flyer.pdf",
    "https://printer.local/flyer.pdf",
    "https://127.0.0.1/flyer.pdf",
    "https://10.0.0.5/flyer.pdf",
    "https://192.168.1.1/flyer.pdf",
    "https://172.16.4.4/flyer.pdf",
    "https://172.31.255.255/flyer.pdf",
    // The one that matters most: cloud instance metadata.
    "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "https://[::1]/flyer.pdf",
    "https://internal/flyer.pdf",
  ];

  for (const url of forbidden) {
    it(`refuses ${url}`, () => {
      expect(checkPdfUrl(url, true).ok).toBe(false);
    });
  }

  it("still allows a public IP literal, which some blob hosts use", () => {
    expect(checkPdfUrl("https://93.184.216.34/flyer.pdf", true).ok).toBe(true);
  });

  it("allows 172.15 and 172.32, which are outside the private range", () => {
    // The off-by-one either side of 172.16–172.31. Getting this wrong quietly
    // blocks legitimate hosts or quietly permits private ones.
    expect(checkPdfUrl("https://172.15.0.1/f.pdf", true).ok).toBe(true);
    expect(checkPdfUrl("https://172.32.0.1/f.pdf", true).ok).toBe(true);
  });
});

describe("schemes and shapes", () => {
  it("refuses http, which is what a redirect inward looks like", () => {
    expect(checkPdfUrl("http://raddar.ca/f.pdf", true).ok).toBe(false);
  });

  it("refuses file: and data: outright", () => {
    expect(checkPdfUrl("file:///etc/passwd", true).ok).toBe(false);
    expect(checkPdfUrl("data:application/pdf;base64,AAAA", true).ok).toBe(false);
  });

  it("refuses credentials embedded in the URL", () => {
    expect(checkPdfUrl("https://user:pw@raddar.ca/f.pdf", true).ok).toBe(false);
  });

  it("refuses something that is not a URL at all", () => {
    expect(checkPdfUrl("raddar.ca/flyer.pdf", true).ok).toBe(false);
    expect(checkPdfUrl("", true).ok).toBe(false);
  });
});

describe("who may fetch from where", () => {
  it("lets any member fetch from the known flyer sites", () => {
    expect(checkPdfUrl("https://raddar.ca/flyers/maxi.pdf", false).ok).toBe(true);
    expect(checkPdfUrl("https://www.raddar.ca/x.pdf", false).ok).toBe(true);
  });

  it("refuses a member an unknown host, and says what to do instead", () => {
    const verdict = checkPdfUrl("https://example.com/flyer.pdf", false);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // The refusal has to leave somebody a way forward, or they conclude the
    // feature is broken rather than restricted.
    expect(verdict.reason).toMatch(/admin|download/i);
  });

  it("lets an admin fetch an unlisted host", () => {
    expect(checkPdfUrl("https://example.com/flyer.pdf", true).ok).toBe(true);
  });

  it("matches hosts case-insensitively but never by suffix", () => {
    expect(checkPdfUrl("https://RADDAR.CA/f.pdf", false).ok).toBe(true);
    // The classic allow-list hole: a host somebody else controls that merely
    // ends with a permitted name.
    expect(checkPdfUrl("https://raddar.ca.evil.com/f.pdf", false).ok).toBe(false);
    expect(checkPdfUrl("https://notraddar.ca/f.pdf", false).ok).toBe(false);
  });

  it("lists raddar, which is where the flyers actually come from", () => {
    expect(FLYER_HOSTS).toContain("raddar.ca");
  });
});

describe("naming the fetched file", () => {
  // The import reads the store and the week out of the filename before it
  // renders a page, so a good name arrives already identified.

  it("keeps a usable pdf name from the path", () => {
    expect(filenameFromUrl(new URL("https://raddar.ca/f/maxi-wk33-2026.pdf"))).toBe(
      "maxi-wk33-2026.pdf",
    );
  });

  it("adds the extension when the path has none", () => {
    expect(filenameFromUrl(new URL("https://raddar.ca/download/metro-week"))).toBe(
      "metro-week.pdf",
    );
  });

  it("falls back to the host rather than to nothing", () => {
    expect(filenameFromUrl(new URL("https://raddar.ca/"))).toBe("raddar.ca.pdf");
  });

  it("decodes escapes and drops characters a filename should not carry", () => {
    expect(
      filenameFromUrl(new URL("https://raddar.ca/f/super%20c%20wk33.pdf")),
    ).toBe("super c wk33.pdf");
    expect(filenameFromUrl(new URL("https://raddar.ca/f/%2Fetc%2Fpasswd"))).toBe(
      "etc passwd.pdf",
    );
  });

  it("ignores the query string, which is not part of the name", () => {
    expect(
      filenameFromUrl(new URL("https://raddar.ca/f/iga.pdf?v=99&token=abc")),
    ).toBe("iga.pdf");
  });
});

describe("is it really a PDF", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const html = new TextEncoder().encode("<!doctype html><html>Not found");

  it("accepts something beginning %PDF-", () => {
    expect(looksLikePdf(pdf)).toBe(true);
  });

  it("rejects a courteous HTML error page served with status 200", () => {
    // The failure this exists for: the import would otherwise try to render an
    // error page as a flyer and report something incomprehensible.
    expect(looksLikePdf(html)).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(looksLikePdf(new Uint8Array())).toBe(false);
  });

  it("caps the size at something a weekly flyer never exceeds", () => {
    expect(MAX_PDF_BYTES).toBeGreaterThan(5 * 1024 * 1024);
    expect(MAX_PDF_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});

describe("splitting what somebody pasted", () => {
  it("takes one link per line", () => {
    expect(splitUrls("https://a.ca/1.pdf\nhttps://b.ca/2.pdf")).toEqual([
      "https://a.ca/1.pdf",
      "https://b.ca/2.pdf",
    ]);
  });

  it("copes with spaces, blank lines and trailing whitespace", () => {
    expect(
      splitUrls("  https://a.ca/1.pdf   https://b.ca/2.pdf \n\n "),
    ).toHaveLength(2);
  });

  it("drops a link pasted twice rather than fetching it twice", () => {
    // Losing your place in a list of six is ordinary. Spending two fetches and
    // two duplicate imports on it is not a useful consequence.
    expect(splitUrls("https://a.ca/1.pdf https://a.ca/1.pdf")).toEqual([
      "https://a.ca/1.pdf",
    ]);
  });

  it("stops at the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://a.ca/${i}.pdf`).join("\n");
    expect(splitUrls(many)).toHaveLength(6);
    expect(splitUrls(many, 2)).toHaveLength(2);
  });

  it("returns nothing for an empty box", () => {
    expect(splitUrls("   \n  ")).toEqual([]);
  });
});
