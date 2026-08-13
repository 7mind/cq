import { describe, expect, it } from "bun:test";
import { CANONICAL_LEDGERS } from "@cq/ledger/constants";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanItemReferences } from "../src/itemReferences.js";

describe("scanItemReferences", () => {
  it("recognizes canonical, bare, and multi-letter-prefix references", () => {
    expect(scanItemReferences("tasks:T1464 reviews:R1040 researches:RS42 HO7 OA12")).toEqual([
      { kind: "reference", text: "tasks:T1464", reference: { ledger: "tasks", id: "T1464" } },
      { kind: "text", text: " " },
      { kind: "reference", text: "reviews:R1040", reference: { ledger: "reviews", id: "R1040" } },
      { kind: "text", text: " " },
      { kind: "reference", text: "researches:RS42", reference: { ledger: "researches", id: "RS42" } },
      { kind: "text", text: " " },
      { kind: "reference", text: "HO7", reference: { ledger: "handoffs", id: "HO7" } },
      { kind: "text", text: " " },
      { kind: "reference", text: "OA12", reference: { ledger: "operatorActions", id: "OA12" } },
    ]);
  });

  it("recognizes every canonical ledger name, including camelCase names", () => {
    const text = CANONICAL_LEDGERS
      .map(({ name, schema }) => `${name}:${schema.idPrefix}12`)
      .join(" ");
    expect(scanItemReferences(text).filter((span) => span.kind === "reference")).toEqual(
      CANONICAL_LEDGERS.map(({ name, schema }) => ({
        kind: "reference",
        text: `${name}:${schema.idPrefix}12`,
        reference: { ledger: name, id: `${schema.idPrefix}12` },
      })),
    );
    expect(scanItemReferences("operatorActions:OA12")).toEqual([
      {
        kind: "reference",
        text: "operatorActions:OA12",
        reference: { ledger: "operatorActions", id: "OA12" },
      },
    ]);
  });

  it("preserves input exactly while rejecting unknown, lowercase, URL, and path noise", () => {
    const text = "T1, ZZ9 t2 https://example.test/tasks:T3 /tmp/T4 ./T5 tasks:T6.";
    const spans = scanItemReferences(text);
    expect(spans.map((span) => span.text).join("")).toBe(text);
    expect(spans.filter((span) => span.kind === "reference").map((span) => span.text)).toEqual([
      "T1",
      "tasks:T6",
    ]);
  });

  it("imports browser-safe leaves rather than the ledger root barrel", () => {
    const source = readFileSync(join(import.meta.dir, "../src/itemReferences.ts"), "utf8");
    expect(source).toContain('from "@cq/ledger/refs"');
    expect(source).toContain('from "@cq/ledger/constants"');
    expect(source).not.toMatch(/from ["']@cq\/ledger["']/);
  });
});
