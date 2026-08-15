/**
 * Every function an Edge Function calls must actually exist in it.
 *
 * ---------------------------------------------------------------------------
 * WHY A TEST FOR SOMETHING A COMPILER SHOULD CATCH
 * ---------------------------------------------------------------------------
 * These files import from `jsr:@supabase/supabase-js`, which this project's
 * TypeScript build cannot resolve — so `tsc` never looks at them, and
 * `deno check` needs network access to the JSR registry. They are the only
 * source in this repository with no compiler watching it.
 *
 * That gap cost an evening. A refactor deleted three helpers from the worker,
 * one of them `json` — which is what the top-level catch uses to report a
 * failure. So the error handler threw while handling the error, and the
 * platform answered a bare "Internal Server Error" with no body: every
 * scheduled tick failed for hours while saying nothing about why. The file
 * still parsed, still deployed, still had balanced braces and no duplicate
 * names. Only running it could have found this, and the thing running it was
 * a cron job whose replies nobody could read.
 *
 * ---------------------------------------------------------------------------
 * PARSED, NOT PATTERN-MATCHED
 * ---------------------------------------------------------------------------
 * The first version of this test used regular expressions, and its
 * template-literal rule quietly swallowed a hundred lines of code — so it
 * reported functions missing that were plainly there. A test that cries wolf
 * about the thing it exists to detect is worse than no test.
 *
 * TypeScript's own parser is already a dependency and needs no module
 * resolution to build a syntax tree, so the tree is the source of truth here.
 * This still checks nothing about types. It checks that a called name exists,
 * which is the failure that actually happened.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const FUNCTIONS_DIR = join(process.cwd(), "supabase", "functions");

/** Provided by the runtime. Extended as the functions need more of it. */
const GLOBALS = new Set([
  "JSON", "Number", "String", "Boolean", "Array", "Object", "Set", "Map",
  "Date", "Math", "parseInt", "parseFloat", "isNaN", "isFinite", "RegExp",
  "Symbol", "Promise", "Error", "TypeError", "fetch", "btoa", "atob",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "console",
  "Response", "Request", "Headers", "AbortController", "URL", "URLSearchParams",
  "TextEncoder", "TextDecoder", "Uint8Array", "ArrayBuffer", "Blob",
  "encodeURIComponent", "decodeURIComponent", "structuredClone", "crypto",
  "Deno", "globalThis", "require",
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(FUNCTIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(FUNCTIONS_DIR, entry.name))) {
      if (file.endsWith(".ts")) out.push(join(FUNCTIONS_DIR, entry.name, file));
    }
  }
  return out.sort();
}

function collectBindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, into);
  }
}

function analyse(source: ts.SourceFile) {
  const declared = new Set<string>();
  const called = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) declared.add(node.name.text);
    if (ts.isClassDeclaration(node) && node.name) declared.add(node.name.text);
    if (ts.isVariableDeclaration(node)) collectBindingNames(node.name, declared);
    if (ts.isParameter(node)) collectBindingNames(node.name, declared);
    if (ts.isImportSpecifier(node)) declared.add(node.name.text);
    if (ts.isImportClause(node) && node.name) declared.add(node.name.text);
    if (ts.isNamespaceImport(node)) declared.add(node.name.text);
    if (ts.isFunctionExpression(node) && node.name) declared.add(node.name.text);

    // A call on a bare name — `json(...)`. Method calls are `foo.bar()`, whose
    // expression is a PropertyAccessExpression, and are not this test's
    // business: the object may come from anywhere.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      called.add(node.expression.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return { declared, called };
}

describe("the guard catches the failure it was written for", () => {
  it("reports a helper that is called and not defined", () => {
    // The worker, minus its json() helper — which is exactly what a refactor
    // did, and what nothing else in this repository would have noticed.
    const text = [
      'function handle() { return json({ ok: true }, 200); }',
      'Deno.serve(handle);',
    ].join(String.fromCharCode(10));
    const source = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
    const { declared, called } = analyse(source);
    expect(called.has("json")).toBe(true);
    expect(declared.has("json")).toBe(false);
  });

  it("does not flag a method call on an object it cannot see", () => {
    const text = 'const x = supabase.from("t").select("*");';
    const source = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
    expect(analyse(source).called.has("from")).toBe(false);
  });
});

describe("edge functions call only what they define or import", () => {
  const files = sourceFiles();

  it("finds the edge function sources", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const short = file.slice(file.indexOf("supabase/functions"));

    it(`${short} defines every helper it calls`, () => {
      const text = readFileSync(file, "utf8");
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const { declared, called } = analyse(source);

      const missing = [...called]
        .filter((name) => !declared.has(name) && !GLOBALS.has(name))
        .sort();

      // The exact failure this exists for: `json` called fifteen times and
      // defined nowhere, in a file that parsed and deployed cleanly.
      expect(missing).toEqual([]);
    });
  }
});
