/**
 * Copy pdf.js's worker into public/ so a static export can serve it.
 *
 * pdf.js runs its parser in a Web Worker, and the worker is a separate file
 * that has to be reachable at a URL. With `output: "export"` there is no
 * bundler route to it, and loading it from a CDN is not an option — the app
 * ships no third-party script tags, and a flyer should still import on a
 * hotel wifi that blocks half the internet.
 *
 * Copied at build time rather than committed, so it cannot drift from the
 * installed pdfjs-dist version.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
const to = join(root, "public/pdf.worker.min.mjs");

await mkdir(dirname(to), { recursive: true });
await copyFile(from, to);
console.log(`pdf.js worker -> ${to}`);
