/**
 * D222 regression — the web shares @cq/ledger's canonical summarize().
 *
 * App.tsx previously carried a private `summarize()` (+ `fieldToString` +
 * `SUMMARIZE_MAX`) duplicating packages/ledger/src/summarize.ts exactly. The
 * fix deletes those copies and imports the shared implementation via the
 * browser-safe `@cq/ledger/summarize` leaf subpath (the @cq/ledger index pulls
 * Node builtins, so it must not enter the browser bundle).
 *
 * This file pins the shared implementation's observable behavior so a future
 * local-copy regression fails the suite, plus a structural guard (matching the
 * relationships-cross-ui.test.ts precedent) that App.tsx carries no private
 * copy and consumes the leaf import.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { summarize, fieldToString } from "@cq/ledger/summarize";
import type { Item } from "../src/types.js";

const APP_SRC = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "App.tsx"),
  "utf8",
);

function item(fields: Item["fields"]): Item {
  return {
    id: "X1",
    milestoneId: "M1",
    status: "open",
    fields,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

describe("shared summarize() behavior (D222)", () => {
  it("prefers headline over title over question over summary", () => {
    expect(summarize(item({ headline: "H", title: "T", question: "Q", summary: "S" }))).toBe("H");
    expect(summarize(item({ title: "T", question: "Q", summary: "S" }))).toBe("T");
    expect(summarize(item({ question: "Q", summary: "S" }))).toBe("Q");
    expect(summarize(item({ summary: "S" }))).toBe("S");
  });

  it("falls back to the first criticism line when no summary source is defined", () => {
    expect(summarize(item({ criticism: ["first line\nsecond line"] }))).toBe("first line");
  });

  it("truncates the criticism fallback at 80 chars with an ellipsis", () => {
    const long = "a".repeat(81);
    expect(summarize(item({ criticism: [long] }))).toBe("a".repeat(80) + "…");
    expect(summarize(item({ criticism: ["a".repeat(80)] }))).toBe("a".repeat(80));
  });

  it("comma-joins array field values", () => {
    expect(fieldToString(["a", "b", "c"])).toBe("a, b, c");
    expect(summarize(item({ headline: ["a", "b"] }))).toBe("a, b");
  });
});

describe("App.tsx carries no private summarize copy (D222 structural guard)", () => {
  it("imports the shared helpers from the @cq/ledger/summarize leaf", () => {
    expect(APP_SRC).toContain('from "@cq/ledger/summarize"');
  });

  it("defines no local summarize / SUMMARIZE_MAX / fieldToString", () => {
    expect(APP_SRC).not.toContain("function summarize");
    expect(APP_SRC).not.toContain("const SUMMARIZE_MAX");
    expect(APP_SRC).not.toContain("function fieldToString");
  });
});
