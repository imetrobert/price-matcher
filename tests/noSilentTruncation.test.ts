/**
 * Every read of a growing table must say how it avoids the row cap.
 *
 * ---------------------------------------------------------------------------
 * WHY A TEST AND NOT A CODE REVIEW
 * ---------------------------------------------------------------------------
 * PostgREST truncates at `max-rows` — 1000 by default — and reports nothing
 * when it does. There is no error to catch, no flag to check, no difference in
 * the response between "these are all the rows" and "these are the first
 * thousand of some larger number". A query written without pagination looks
 * correct, tests correct on small data, works for months, and then quietly
 * drops a whole store from a comparison the week the data crosses the line.
 *
 * That happened here in August 2026. It cost a store on the deals screen and
 * an evening finding out why, and the only reason it was ever found is that
 * the totals on screen added to exactly 1000.
 *
 * A reviewer cannot reliably catch the next one: the missing thing is absent
 * code, in a chain that reads perfectly well. So the rule is enforced instead
 * of remembered — every read of a table that grows must either slice, count on
 * the server, or carry a written reason it is safe.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST FAILS
 * ---------------------------------------------------------------------------
 * You have added a query to one of these tables. Choose one:
 *
 *   1. Route it through `fetchAllRows` with `.order(<unique column>)` and
 *      `.range(from, to)`. This is right for anything that grows.
 *
 *   2. Count on the server: `.select("id", { count: "exact", head: true })`.
 *      No rows cross the wire, so nothing can be truncated.
 *
 *   3. If it genuinely cannot exceed the cap, write why on the line above:
 *      `// bounded: one flyer's pages, and no flyer has 500`
 *      The marker is the point — it forces the question to be answered rather
 *      than not asked.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/** Tables whose row count grows with ordinary weekly use. */
const GROWING_TABLES = [
  "cartmatch_flyer_offers",
  "cartmatch_flyer_pages",
  "cartmatch_flyers",
  "cartmatch_api_usage",
];

/** Where queries against those tables are allowed to live. */
const SOURCES = ["src/services/flyers/storage.ts"];

/** A query and the text of the statement it belongs to. */
interface Query {
  table: string;
  line: number;
  statement: string;
  /** The two lines above it, where a `bounded:` note is written. */
  preamble: string;
}

/**
 * The source with every comment blanked out, character for character.
 *
 * Written the first time this checker ran and reported a false positive: a
 * comment inside a query chain ended a sentence with a semicolon, the finder
 * took that for the end of the statement, and a properly sliced query was
 * called unsafe. Spaces rather than deletion so every index still lines up
 * with the real file, and the line numbers it reports stay true.
 */
function maskComments(source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // Not `://`, so a URL in a string survives.
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

/**
 * Pull out each `.from("<table>") … ;` statement.
 *
 * Crude on purpose. A real parser would be more precise and would also be a
 * second thing that can be wrong; this only has to find the start of a chain
 * and the semicolon that ends it, and the file is written in one style.
 *
 * Boundaries and safety come from the masked copy, so nothing written in prose
 * can pass or fail a query. The `bounded:` marker is looked for in the real
 * text, because it IS a comment.
 */
function findQueries(source: string): Query[] {
  const masked = maskComments(source);
  const found: Query[] = [];
  for (const table of GROWING_TABLES) {
    const needle = `.from("${table}")`;
    let at = masked.indexOf(needle);
    while (at !== -1) {
      const semi = masked.indexOf(";", at);
      const end = semi === -1 ? masked.length : semi + 1;
      const before = source.slice(0, at).split("\n");
      // Everything back to the last blank line: that is the comment block
      // attached to this statement, however long somebody's reason runs, and
      // it stops before the previous statement's. A fixed number of lines was
      // tried first and silently ignored a four-line note.
      //
      // The walk starts one line up. The last entry is whatever sits between
      // the previous newline and `.from(` — for a chained call that is only
      // indentation, which is blank, which stopped the walk before it began.
      let start = Math.max(before.length - 1, 0);
      while (start > 0 && before[start - 1]!.trim() !== "") start -= 1;
      found.push({
        table,
        line: before.length,
        statement: masked.slice(at, end),
        // The real text either side: the note may sit above the chain or
        // inside it, and both read the same to somebody writing one.
        preamble: before.slice(start).join("\n") + source.slice(at, end),
      });
      at = masked.indexOf(needle, at + needle.length);
    }
  }
  return found;
}

/** A read is any chain that brings rows back. Writes are not at risk. */
function isRead(statement: string): boolean {
  return statement.includes(".select(");
}

/** The three acceptable answers, in the order the failure message lists them. */
function isSafe(query: Query): boolean {
  const { statement, preamble } = query;
  if (statement.includes(".range(")) return true;
  if (statement.includes("head: true")) return true;
  return /\/\/\s*bounded:/.test(preamble);
}

const files = SOURCES.map((path) => ({
  path,
  text: readFileSync(resolve(process.cwd(), path), "utf8"),
}));

describe("no query can be silently truncated", () => {
  it("finds the queries at all, so a passing run means something", () => {
    // A regex that matches nothing passes every assertion below it. Pin the
    // finder against the file before trusting what it says about the file.
    const all = files.flatMap((f) => findQueries(f.text));
    expect(all.length).toBeGreaterThan(8);
    expect(all.filter((q) => isRead(q.statement)).length).toBeGreaterThan(3);
  });

  it("every read either slices, counts on the server, or says why it is safe", () => {
    const unsafe = files.flatMap((f) =>
      findQueries(f.text)
        .filter((q) => isRead(q.statement))
        .filter((q) => !isSafe(q))
        .map((q) => `${f.path}:${q.line} reads ${q.table}`),
    );

    expect(unsafe).toEqual([]);
  });

  it("recognises each of the three ways of being safe", () => {
    // The checker itself, tested. A guard that quietly accepts everything is
    // worse than no guard, because it is also reassuring.
    const sliced = {
      table: "x",
      line: 1,
      preamble: "",
      statement: '.from("x").select("*").order("id").range(from, to);',
    };
    const counted = {
      table: "x",
      line: 1,
      preamble: "",
      statement: '.from("x").select("id", { count: "exact", head: true });',
    };
    const explained = {
      table: "x",
      line: 1,
      preamble: "  // bounded: one flyer's pages\n.from(\"x\").select(\"status\");",
      statement: '.from("x").select("status");',
    };
    const naked = {
      table: "x",
      line: 1,
      preamble: "  // fetch the rows",
      statement: '.from("x").select("*");',
    };

    expect(isSafe(sliced)).toBe(true);
    expect(isSafe(counted)).toBe(true);
    expect(isSafe(explained)).toBe(true);
    expect(isSafe(naked)).toBe(false);
  });

  it("does not demand anything of a write", () => {
    expect(isRead('.from("x").delete().eq("flyer_id", id);')).toBe(false);
    expect(isRead('.from("x").insert(rows);')).toBe(false);
    expect(isRead('.from("x").select("*");')).toBe(true);
  });

  it("keeps these queries in one file, where the rule can be enforced", () => {
    // The rule is only as good as its coverage. If a screen starts querying
    // these tables directly, this test stops seeing it — so that is a failure
    // too, and the fix is to add the file to SOURCES or move the query here.
    const strays: string[] = [];
    const dir = resolve(process.cwd(), "src");
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = `${path}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const rel = full.slice(resolve(process.cwd()).length + 1);
          if (SOURCES.includes(rel)) continue;
          const text = readFileSync(full, "utf8");
          if (GROWING_TABLES.some((t) => text.includes(`.from("${t}")`))) {
            strays.push(rel);
          }
        }
      }
    };
    walk(dir);
    expect(strays).toEqual([]);
  });
});
