/**
 * D-LED-01 — path-traversal hardening (msunify shape).
 *
 * Three layers of defence:
 *   1. `applyCreateItem` (and via it, the milestone auto-create path)
 *      rejects ids that don't match `/^[A-Za-z0-9_-]+$/` (InvalidIdError).
 *   2. `FsLedgerStore.archiveMilestone` refuses to write outside `docsDir`
 *      even when the in-memory state has been forged with a bad id.
 *   3. `FsLedgerStore.fetchArchive` refuses to read outside `docsDir` even
 *      when the in-memory `archivePointers` entry has been forged with a
 *      relative path that resolves outside.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  InvalidIdError,
  LedgerError,
  serializeRegistry,
  type Ledger,
  type LedgerSchema,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
} from "../src/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

const schema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { note: { type: "string", required: false } },
};

async function setupFs(): Promise<{ store: FsLedgerStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-trav-"));
  dirs.push(root);
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(
    path.join(docsDir, "ledgers.yaml"),
    serializeRegistry({
      version: 1,
      ledgers: [
        { name: MILESTONES_LEDGER, schema: MILESTONES_SCHEMA },
        { name: "xenos", schema },
      ],
    }),
    "utf8",
  );
  const store = new FsLedgerStore({ root });
  await store.init();
  return { store, root };
}

describe("D-LED-01 — id validation in core helpers", () => {
  const badIds = ["../etc/passwd", "a/b", "a b", "", "..", ".", "a.b", "a/../b"];

  it.each(badIds)("createMilestone (milestones ledger) rejects id %p", async (badId) => {
    const store = new InMemoryLedgerStore();
    await store.init();
    await expect(
      store.createMilestone({ id: badId, title: "x" }),
    ).rejects.toThrow(InvalidIdError);
  });

  it.each(badIds)("createItem rejects unsafe explicit id %p", async (badId) => {
    const store = new InMemoryLedgerStore({ seed: [{ name: "xenos", schema }] });
    await store.init();
    const m = await store.createMilestone({ title: "m" });
    await expect(
      store.createItem("xenos", m.id, { id: badId, status: "open", fields: {} }),
    ).rejects.toThrow(InvalidIdError);
  });

  it.each(badIds)("createItem rejects unsafe milestoneId %p (auto-create path)", async (badId) => {
    const store = new InMemoryLedgerStore({ seed: [{ name: "xenos", schema }] });
    await store.init();
    // milestone existence check happens before the auto-create validation
    // — either way the call must throw with a typed error (most badIds
    // also fail strict-existence). For ".." / "" we rely on the
    // strict-existence check.
    await expect(
      store.createItem("xenos", badId, { status: "open", fields: {} }),
    ).rejects.toThrow();
  });

  it("safe, prefix-matching ids are accepted (positive control)", async () => {
    const store = new InMemoryLedgerStore({ seed: [{ name: "xenos", schema }] });
    await store.init();
    // Caller-supplied ids must match the ledger's `^<prefix>\d+$` (§8a):
    // milestones prefix M, the seeded `xenos` ledger prefix X.
    const m = await store.createMilestone({ id: "M7", title: "x" });
    expect(m.id).toBe("M7");
    const it = await store.createItem("xenos", "M7", {
      id: "X42",
      status: "open",
      fields: {},
    });
    expect(it.id).toBe("X42");
  });
});

describe("D-LED-01 — FsLedgerStore defense-in-depth", () => {
  it("archiveMilestone refuses to write outside docsDir for a forged in-memory milestone id", async () => {
    const { store, root } = await setupFs();
    const internalLedgers = (store as unknown as { ledgers: Map<string, Ledger> })
      .ledgers;
    const todos = internalLedgers.get("xenos");
    const milestones = internalLedgers.get(MILESTONES_LEDGER);
    if (todos === undefined || milestones === undefined) throw new Error("test bug: not seeded");
    // Use enough `..` segments to escape `<docs>/archive/<ledger>/` AND
    // `docsDir` itself — i.e. ≥3 levels above `archive/todos/`.
    const forgedId = "../../../../tmp/pwned";
    // Forge a depth-2 group in todos with the bad id (no items so the
    // terminal check passes).
    todos.milestones.push({
      id: forgedId,
      title: "",
      description: "",
      items: [],
    });
    // Forge a milestone-item in the milestones ledger so phase-3 reaches
    // the archive write step (otherwise it'd throw `absent` before the
    // path check).
    const m0 = milestones.milestones[0];
    if (m0 === undefined) throw new Error("missing M0");
    m0.items.push({
      id: forgedId,
      milestoneId: "M0",
      status: "done",
      fields: { title: "forged" },
      createdAt: "2026-05-28T20:30:00.000Z",
      updatedAt: "2026-05-28T20:30:00.000Z",
    });

    await expect(
      store.archiveMilestone(forgedId, "summary"),
    ).rejects.toThrow(LedgerError);

    const escaped = path.resolve(
      path.join(root, "docs", "archive", "xenos"),
      `${forgedId}.md`,
    );
    expect(escaped.startsWith(path.join(root, "docs") + path.sep)).toBe(false);
    await expect(stat(escaped)).rejects.toBeDefined();
  });

  it("fetchArchive refuses to read outside docsDir for a forged archive pointer", async () => {
    const { store, root } = await setupFs();
    const outsidePath = path.join(root, "secret.md");
    await writeFile(outsidePath, "---\nschemaVersion: 1\n---\n# leaked\n", "utf8");

    const internalLedgers = (store as unknown as { ledgers: Map<string, Ledger> })
      .ledgers;
    const ledger = internalLedgers.get("xenos");
    if (ledger === undefined) throw new Error("test bug: todos not seeded");
    ledger.archivePointers.push({
      id: "leak",
      path: "../secret.md",
      summary: "forged",
      title: "",
      status: "",
    });

    await expect(store.fetchArchive("xenos", "leak")).rejects.toThrow(LedgerError);
  });
});
