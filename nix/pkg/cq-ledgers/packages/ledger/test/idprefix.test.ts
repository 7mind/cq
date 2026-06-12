/**
 * idPrefix + global prefix-uniqueness tests (canon cycle, §8a / Q-CANL-8).
 *
 * Runs against both adapters. Covers:
 *   - default prefix derivation (first uppercase letter of the ledger name)
 *   - explicit idPrefix override
 *   - DuplicatePrefixError on collision at createLedger
 *   - caller-supplied item id prefix-mismatch refused (CrossPrefixIdError)
 *   - global item-id uniqueness via prefix uniqueness
 *   - validateSchema idPrefix shape
 */

import { describe, it, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  serializeRegistry,
  validateSchema,
  type LedgerSchema,
  type LedgerStore,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";

const dirs: string[] = [];

interface Factory {
  name: string;
  build(seed: Array<{ name: string; schema: LedgerSchema }>): Promise<LedgerStore>;
}

const inMem: Factory = {
  name: "InMemoryLedgerStore",
  async build(seed) {
    const store = new InMemoryLedgerStore({ seed });
    await store.init();
    return store;
  },
};

const fs_: Factory = {
  name: "FsLedgerStore",
  async build(seed) {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-prefix-"));
    dirs.push(dir);
    const docsDir = path.join(dir, LEDGER_STORAGE_DIRNAME);
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({ version: 1, ledgers: seed }),
      "utf8",
    );
    const store = new FsLedgerStore({ root: dir });
    await store.init();
    return store;
  },
};

const plainSchema = (idPrefix?: string): LedgerSchema => ({
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { note: { type: "string", required: false } },
  ...(idPrefix === undefined ? {} : { idPrefix }),
});

import { afterAll } from "bun:test";
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

for (const factory of [inMem, fs_]) {
  describe(`idPrefix + prefix-uniqueness (${factory.name})`, () => {
    it("default prefix = first uppercase letter of the ledger name", async () => {
      const store = await factory.build([]);
      await store.createLedger("widgets", plainSchema());
      const m = await store.createMilestone({ title: "x" });
      const it = await store.createItem("widgets", m.id, { status: "open", fields: {} });
      expect(it.id).toBe("W1");
      await store.dispose();
    });

    it("explicit idPrefix override is honoured for auto-allocated ids", async () => {
      const store = await factory.build([]);
      await store.createLedger("widgets", plainSchema("WG"));
      const m = await store.createMilestone({ title: "x" });
      const it = await store.createItem("widgets", m.id, { status: "open", fields: {} });
      expect(it.id).toBe("WG1");
      await store.dispose();
    });

    it("DuplicatePrefixError on default-prefix collision", async () => {
      const store = await factory.build([]);
      await store.createLedger("widgets", plainSchema()); // W
      await expect(
        store.createLedger("wombats", plainSchema()), // also W
      ).rejects.toThrow(/already used by ledger "widgets"/);
      await store.dispose();
    });

    it("DuplicatePrefixError when an explicit prefix collides with a default", async () => {
      const store = await factory.build([]);
      await store.createLedger("widgets", plainSchema()); // W
      await expect(
        store.createLedger("zebras", plainSchema("W")), // explicit W collides
      ).rejects.toThrow(/DuplicatePrefixError|already used/);
      await store.dispose();
    });

    it("caller-supplied item id with the wrong prefix is refused (CrossPrefixIdError)", async () => {
      const store = await factory.build([]);
      await store.createLedger("widgets", plainSchema()); // prefix W
      const m = await store.createMilestone({ title: "x" });
      await expect(
        store.createItem("widgets", m.id, { status: "open", fields: {}, id: "D5" }),
      ).rejects.toThrow(/does not match ledger "widgets" prefix "W"/);
      // Matching prefix is accepted.
      const ok = await store.createItem("widgets", m.id, {
        status: "open",
        fields: {},
        id: "W42",
      });
      expect(ok.id).toBe("W42");
      await store.dispose();
    });

    it("global uniqueness: ids minted in two ledgers never collide (prefix guarantee)", async () => {
      const store = await factory.build([]);
      await store.createLedger("widgets", plainSchema()); // W
      await store.createLedger("alphas", plainSchema()); // A
      const m = await store.createMilestone({ title: "x" });
      const w = await store.createItem("widgets", m.id, { status: "open", fields: {} });
      const a = await store.createItem("alphas", m.id, { status: "open", fields: {} });
      expect(w.id).toBe("W1");
      expect(a.id).toBe("A1");
      expect(w.id).not.toBe(a.id);
      await store.dispose();
    });
  });
}

describe("validateSchema — idPrefix shape", () => {
  it("rejects a digits-only / symbol-bearing idPrefix", () => {
    expect(() =>
      validateSchema({ statusValues: ["open"], terminalStatuses: [], fields: {}, idPrefix: "1X" }),
    ).toThrow(/idPrefix/);
    expect(() =>
      validateSchema({ statusValues: ["open"], terminalStatuses: [], fields: {}, idPrefix: "X-" }),
    ).toThrow(/idPrefix/);
  });
  it("accepts a letter-led alphanumeric idPrefix", () => {
    expect(() =>
      validateSchema({ statusValues: ["open"], terminalStatuses: [], fields: {}, idPrefix: "WG" }),
    ).not.toThrow();
  });
});
