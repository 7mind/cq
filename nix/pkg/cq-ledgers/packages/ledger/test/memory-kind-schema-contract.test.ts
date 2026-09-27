/**
 * G192/T6627 — exact schema fixtures for the memory-kind contract.
 *
 * `kind` is the ONLY new memories field; the lifecycle statuses stay the only
 * activity signal; no redundant state or migration-provenance field exists in
 * the canonical, generated, wire, or backup schema; and the table-column
 * arrays are exact.
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  InMemoryLedgerStore,
  MEMORIES_LEDGER,
  MEMORIES_SCHEMA,
  MEMORY_KINDS,
  MEMORY_KIND_FIELD,
  DEFAULT_MEMORY_KIND,
  buildBackupDump,
  createLedgerMcpTools,
  defaultColumns,
  eligibleColumnFields,
  parseRegistry,
  type FetchedLedger,
  type LedgerSchema,
} from "../src/index.js";

const GENERATED_REGISTRY = path.resolve(import.meta.dir, "../../../docs/ledgers.yaml");

const EXPECTED_MEMORIES_SCHEMA: LedgerSchema = {
  statusValues: ["active", "superseded", "forgotten"],
  terminalStatuses: ["superseded", "forgotten"],
  idPrefix: "MEM",
  transitions: {
    active: ["superseded", "forgotten"],
    superseded: [],
    forgotten: [],
  },
  fields: {
    title: { type: "string", required: true },
    content: { type: "string", required: true },
    kind: { type: "string", required: false },
    tags: { type: "string[]", required: false },
    sourceRefs: { type: "string[]", required: false },
    worksetOwnerRef: { type: "string", required: false },
    worksetOwnerEdgeKind: { type: "string", required: false },
  },
};

/** Redundant activity state and migration provenance the contract forbids. */
const FORBIDDEN_FIELDS = [
  "active",
  "isActive",
  "legacy",
  "isLegacy",
  "state",
  "activity",
  "schemaVersion",
  "migratedAt",
  "migratedFrom",
  "migrationSource",
  "kindSource",
  "kindMigratedAt",
] as const;

function assertExactMemoriesSchema(schema: LedgerSchema | undefined): void {
  expect(schema).toEqual(EXPECTED_MEMORIES_SCHEMA);
  expect(Object.keys(schema?.fields ?? {})).toEqual(
    Object.keys(EXPECTED_MEMORIES_SCHEMA.fields),
  );
  for (const forbidden of FORBIDDEN_FIELDS) {
    expect(schema?.fields[forbidden]).toBeUndefined();
  }
}

describe("memory-kind closed contract", () => {
  it("exports exactly fact | rule | environment with fact as the default", () => {
    expect([...MEMORY_KINDS]).toEqual(["fact", "rule", "environment"]);
    expect(MEMORY_KIND_FIELD).toBe("kind");
    expect(DEFAULT_MEMORY_KIND).toBe("fact");
  });
});

describe("memories schema fixtures", () => {
  it("canonical schema adds only the optional scalar kind directly after content", () => {
    assertExactMemoriesSchema(MEMORIES_SCHEMA);
    const names = Object.keys(MEMORIES_SCHEMA.fields);
    expect(names[names.indexOf("content") + 1]).toBe("kind");
  });

  it("keeps the lifecycle statuses as the only activity signal", () => {
    expect(MEMORIES_SCHEMA.statusValues).toEqual(["active", "superseded", "forgotten"]);
    expect(MEMORIES_SCHEMA.terminalStatuses).toEqual(["superseded", "forgotten"]);
  });

  it("generated docs/ledgers.yaml carries the exact canonical memories schema", async () => {
    const registry = parseRegistry(await readFile(GENERATED_REGISTRY, "utf8"));
    const entry = registry.ledgers.find(({ name }) => name === MEMORIES_LEDGER);
    assertExactMemoriesSchema(entry?.schema);
  });

  it("the fetch_ledger wire response carries the exact canonical memories schema", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    try {
      const tool = createLedgerMcpTools(store).find(({ name }) => name === "fetch_ledger");
      if (tool === undefined) throw new Error("fetch_ledger tool missing");
      const result = (await tool.handler(
        { ledger_id: MEMORIES_LEDGER, projection: "full" } as never,
        null,
      )) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]?.text;
      if (text === undefined) throw new Error("fetch_ledger returned no text block");
      const wire = JSON.parse(text) as { ledger: FetchedLedger };
      assertExactMemoriesSchema(wire.ledger.schema);
    } finally {
      await store.dispose();
    }
  });

  it("the backup registry carries the exact canonical memories schema", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    try {
      const dump = await buildBackupDump(store, null);
      const registryFile = dump.find(({ path: relPath }) => relPath === "ledgers.yaml");
      if (registryFile === undefined) throw new Error("backup dump lacks ledgers.yaml");
      const entry = parseRegistry(registryFile.content).ledgers.find(
        ({ name }) => name === MEMORIES_LEDGER,
      );
      assertExactMemoriesSchema(entry?.schema);
    } finally {
      await store.dispose();
    }
  });

  it("offers kind as an opt-in short column with no default columns", () => {
    expect(eligibleColumnFields(MEMORIES_SCHEMA)).toEqual(["kind", "tags", "sourceRefs"]);
    expect(defaultColumns(MEMORIES_LEDGER)).toEqual([]);
  });
});
