/**
 * T1955 — filesystem WorksetStore leg of the shared Blackbox contract.
 *
 * Runs {@link runWorksetStoreContract} against a real temporary directory via
 * {@link createFsWorksetStore}. Classification is Good-Communication because
 * the adapter crosses the filesystem boundary.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createFsWorksetStore,
  FsLedgerStore,
  readWorksetRootsEpoch,
  serializeRegistry,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";
import {
  runWorksetStoreContract,
  type WorksetStoreContractFactory,
} from "./worksetStoreContract.js";

const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

async function freshRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "workset-store-fs-"));
  dirs.push(dir);
  return dir;
}

const fsWorksetStoreFactory: WorksetStoreContractFactory = {
  name: "filesystem",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async build(options) {
    const root = await freshRoot();
    return createFsWorksetStore({
      root,
      ...(options?.hooks !== undefined ? { hooks: options.hooks } : {}),
      ...(options?.validateReplacement !== undefined
        ? { validateReplacement: options.validateReplacement }
        : {}),
      ...(options?.isTargetAdmitted !== undefined
        ? { isTargetAdmitted: options.isTargetAdmitted }
        : {}),
    });
  },
};

runWorksetStoreContract(fsWorksetStoreFactory);

describe("workset store filesystem specifics [T1955]", () => {
  it("createFsWorksetStore requires an absolute root", () => {
    expect(() => createFsWorksetStore({ root: "relative/path" })).toThrow(
      /absolute/,
    );
  });

  it("FsLedgerStore.createWorksetStore binds the same project root", async () => {
    const root = await freshRoot();
    const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({
        version: 1,
        ledgers: [{ name: MILESTONES_LEDGER, schema: MILESTONES_SCHEMA }],
      }),
      "utf8",
    );
    const ledger = new FsLedgerStore({ root });
    await ledger.init();
    try {
      const store = ledger.createWorksetStore();
      await store.setRoots(["goals:G-bound"]);
      expect(await readWorksetRootsEpoch(store)).toEqual({
        roots: ["goals:G-bound"],
        epoch: 1,
      });
      const rootsFile = path.join(docsDir, "workset", "roots.json");
      const text = await fs.readFile(rootsFile, "utf8");
      const parsed = JSON.parse(text) as { roots: string[]; epoch: number };
      expect(parsed.roots).toEqual(["goals:G-bound"]);
      expect(parsed.epoch).toBe(1);
    } finally {
      await ledger.dispose();
    }
  });
});
