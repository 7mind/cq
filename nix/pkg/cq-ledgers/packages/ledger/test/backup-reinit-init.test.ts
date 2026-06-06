/**
 * Integration tests for FsLedgerStore.init() divergence handling (T96).
 *
 * Exercises four scenarios driven by a seeded tmpdir and injected now():
 *   (1) divergence → backup+reinit (DEFAULT policy)
 *   (2) divergence + abort opt-out (onSchemaDivergence:'abort')
 *   (3) regression — no divergence: files and items unchanged, no backup
 *   (4) regression — empty dir: canonical set created, no backup
 *
 * See T94 (backupAndReinit helper) and T95 (init() rewire) for the
 * implementation under test.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, stat, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  CANONICAL_LEDGERS,
  GOALS_LEDGER,
  GOALS_SCHEMA,
  MILESTONES_LEDGER,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_AMBIENT_ID,
  BootstrapViolationError,
  serializeRegistry,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs)
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh tmpdir with an (optionally seeded) docs/ subdirectory. */
async function makeTmpDir(): Promise<{ root: string; docsDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-bri-"));
  dirs.push(root);
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  return { root, docsDir };
}

/**
 * Build a canonical registry YAML where every entry is the canonical schema
 * EXCEPT the given ledger name, whose statusValues has an extra value appended.
 */
function divergentRegistryYaml(divergentLedger: string): string {
  const ledgers = CANONICAL_LEDGERS.map((c) => {
    if (c.name !== divergentLedger) return { name: c.name, schema: c.schema };
    return {
      name: c.name,
      schema: { ...c.schema, statusValues: [...c.schema.statusValues, "extra-status"] },
    };
  });
  return serializeRegistry({ version: 1, ledgers });
}

/**
 * Minimal (but syntactically valid) .md content for a goals ledger that
 * includes at least one item — used to verify byte-for-byte backup.
 *
 * The counters/schema here don't need to match the divergent schema; we only
 * care that the file survives backup unchanged.
 */
const PRIOR_GOALS_MD = `---
ledger: goals
counters:
  milestone: 0
  item: 1
archives: []
---

# goals

## M-AMBIENT

### G1 — open

- createdAt: 2026-01-01T00:00:00.000Z
- updatedAt: 2026-01-01T00:00:00.000Z
- headline: a prior goal
`;

/**
 * Capture everything written to process.stderr during the execution of `fn`.
 * Restores the original write implementation even on throw.
 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return orig(chunk);
  };
  try {
    await fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = orig;
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// §1 — divergence → backup+reinit (default policy)
// ---------------------------------------------------------------------------

describe("FsLedgerStore.init() divergence → backup+reinit (default)", () => {
  const FIXED_TS = "2026-06-02T10:00:00.000Z";
  const SANITIZED_TS = FIXED_TS.replace(/:/g, "-");

  it("init() resolves without throwing", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, now: () => FIXED_TS });

    await expect(store.init()).resolves.toBeUndefined();
    await store.dispose();
  });

  it("creates docs/.backup/<sanitized-ts>/ directory", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, now: () => FIXED_TS });
    await store.init();
    await store.dispose();

    const backupDir = path.join(docsDir, ".backup", SANITIZED_TS);
    const s = await stat(backupDir);
    expect(s.isDirectory()).toBe(true);
  });

  it("backup contains byte-for-byte copy of the prior ledgers.yaml", async () => {
    const { root, docsDir } = await makeTmpDir();
    const originalRegistryYaml = divergentRegistryYaml(GOALS_LEDGER);
    await writeFile(path.join(docsDir, "ledgers.yaml"), originalRegistryYaml, "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, now: () => FIXED_TS });
    await store.init();
    await store.dispose();

    const backupDir = path.join(docsDir, ".backup", SANITIZED_TS);
    const backedUpRegistry = await readFile(path.join(backupDir, "ledgers.yaml"), "utf8");
    expect(backedUpRegistry).toBe(originalRegistryYaml);
  });

  it("backup contains byte-for-byte copy of the prior divergent ledger .md", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, now: () => FIXED_TS });
    await store.init();
    await store.dispose();

    const backupDir = path.join(docsDir, ".backup", SANITIZED_TS);
    const backedUpMd = await readFile(path.join(backupDir, `${GOALS_LEDGER}.md`), "utf8");
    expect(backedUpMd).toBe(PRIOR_GOALS_MD);
  });

  it("live on-disk goals.md is fresh-canonical (no prior items)", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, now: () => FIXED_TS });
    await store.init();
    await store.dispose();

    const liveMd = await readFile(path.join(docsDir, `${GOALS_LEDGER}.md`), "utf8");
    expect(liveMd).not.toContain("a prior goal");
    expect(liveMd).toContain(GOALS_LEDGER);
  });

  it("live on-disk ledgers.yaml uses the canonical GOALS_SCHEMA (no extra-status)", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, now: () => FIXED_TS });
    await store.init();
    await store.dispose();

    const liveRegistry = await readFile(path.join(docsDir, "ledgers.yaml"), "utf8");
    expect(liveRegistry).not.toContain("extra-status");
    for (const c of CANONICAL_LEDGERS) {
      expect(liveRegistry).toContain(c.name);
    }
  });

  it("in-memory goals ledger has canonical schema statusValues", async () => {
    const { root } = await makeTmpDir();
    const docsDir = path.join(root, "docs");
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, now: () => FIXED_TS });
    await store.init();

    const fetched = store.fetch(GOALS_LEDGER);
    expect(fetched.schema.statusValues).toEqual(GOALS_SCHEMA.statusValues);
    expect(fetched.schema.statusValues).not.toContain("extra-status");

    await store.dispose();
  });

  it("in-memory goals ledger has no prior items", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, now: () => FIXED_TS });
    await store.init();

    const fetched = store.fetch(GOALS_LEDGER);
    const allItems = fetched.milestones.flatMap((m) => m.items);
    expect(allItems).toHaveLength(0);

    await store.dispose();
  });

  it("milestones ledger has bootstrap group and M-AMBIENT after reinit", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, now: () => FIXED_TS });
    await store.init();

    const milestones = store.fetch(MILESTONES_LEDGER);
    const activeGroup = milestones.milestones.find((m) => m.id === MILESTONES_ACTIVE_GROUP_ID);
    expect(activeGroup).toBeDefined();
    const ambientItem = activeGroup!.items.find((it) => it.id === MILESTONES_AMBIENT_ID);
    expect(ambientItem).toBeDefined();

    await store.dispose();
  });

  it("emits exactly one WARNING to stderr naming the backup path", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, now: () => FIXED_TS });

    const stderr = await captureStderr(() => store.init());
    await store.dispose();

    const backupDir = path.join(docsDir, ".backup", SANITIZED_TS);
    expect(stderr).toContain("WARNING");
    expect(stderr).toContain(backupDir);
    const warningCount = (stderr.match(/WARNING/g) ?? []).length;
    expect(warningCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §2 — abort opt-out: divergence throws, no backup created
// ---------------------------------------------------------------------------

describe("FsLedgerStore.init() divergence + onSchemaDivergence:'abort'", () => {
  it("init() rejects with BootstrapViolationError", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, onSchemaDivergence: "abort" });

    await expect(store.init()).rejects.toThrow(BootstrapViolationError);
  });

  it("init() rejection message matches /different schema/", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, onSchemaDivergence: "abort" });

    await expect(store.init()).rejects.toThrow(/different schema/);
  });

  it("no backup dir is created on abort", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, onSchemaDivergence: "abort" });

    await store.init().catch(() => undefined);

    const backupParent = path.join(docsDir, ".backup");
    let exists = false;
    try {
      await stat(backupParent);
      exists = true;
    } catch {
      // ENOENT expected
    }
    expect(exists).toBe(false);
  });

  it("on-disk ledgers.yaml is untouched on abort", async () => {
    const { root, docsDir } = await makeTmpDir();
    const originalYaml = divergentRegistryYaml(GOALS_LEDGER);
    await writeFile(path.join(docsDir, "ledgers.yaml"), originalYaml, "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, onSchemaDivergence: "abort" });

    await store.init().catch(() => undefined);

    const afterYaml = await readFile(path.join(docsDir, "ledgers.yaml"), "utf8");
    expect(afterYaml).toBe(originalYaml);
  });

  it("on-disk ledger .md is untouched on abort", async () => {
    const { root, docsDir } = await makeTmpDir();
    await writeFile(path.join(docsDir, "ledgers.yaml"), divergentRegistryYaml(GOALS_LEDGER), "utf8");
    await writeFile(path.join(docsDir, `${GOALS_LEDGER}.md`), PRIOR_GOALS_MD, "utf8");
    const store = new FsLedgerStore({ root, onSchemaDivergence: "abort" });

    await store.init().catch(() => undefined);

    const afterMd = await readFile(path.join(docsDir, `${GOALS_LEDGER}.md`), "utf8");
    expect(afterMd).toBe(PRIOR_GOALS_MD);
  });
});

// ---------------------------------------------------------------------------
// §3 — regression: no-divergence — files + items unchanged, no backup
// ---------------------------------------------------------------------------

describe("FsLedgerStore.init() regression — no divergence", () => {
  /**
   * Prime an empty canonical store (storeA.init() with no items created),
   * dispose, then re-init from those files. Verifies byte-for-byte idempotence:
   * no backup directory is created and no files are modified by the second init.
   */
  it("init() leaves files unchanged when schemas match", async () => {
    const { root, docsDir } = await makeTmpDir();

    // Write a valid canonical registry (no divergence).
    const canonicalRegistryYaml = serializeRegistry({
      version: 1,
      ledgers: CANONICAL_LEDGERS.map((c) => ({ name: c.name, schema: c.schema })),
    });
    await writeFile(path.join(docsDir, "ledgers.yaml"), canonicalRegistryYaml, "utf8");

    // Prime canonical files with M-AMBIENT seeded, then re-init from them.
    const storeA = new FsLedgerStore({ root });
    await storeA.init();
    await storeA.dispose();

    const registryAfterFirstInit = await readFile(path.join(docsDir, "ledgers.yaml"), "utf8");
    const goalsAfterFirstInit = await readFile(path.join(docsDir, `${GOALS_LEDGER}.md`), "utf8");

    const storeB = new FsLedgerStore({ root });
    await storeB.init();
    await storeB.dispose();

    const registryAfterSecondInit = await readFile(path.join(docsDir, "ledgers.yaml"), "utf8");
    const goalsAfterSecondInit = await readFile(path.join(docsDir, `${GOALS_LEDGER}.md`), "utf8");

    expect(registryAfterSecondInit).toBe(registryAfterFirstInit);
    expect(goalsAfterSecondInit).toBe(goalsAfterFirstInit);
  });

  it("no .backup dir is created when schemas match", async () => {
    const { root, docsDir } = await makeTmpDir();

    // Seed with a valid canonical registry (no divergence).
    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({
        version: 1,
        ledgers: CANONICAL_LEDGERS.map((c) => ({ name: c.name, schema: c.schema })),
      }),
      "utf8",
    );

    const store = new FsLedgerStore({ root });
    await store.init();
    await store.dispose();

    const backupParent = path.join(docsDir, ".backup");
    let exists = false;
    try {
      await stat(backupParent);
      exists = true;
    } catch {
      // ENOENT expected
    }
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4 — regression: empty dir — canonical set created, no backup
// ---------------------------------------------------------------------------

describe("FsLedgerStore.init() regression — empty dir", () => {
  it("creates canonical ledger files from scratch", async () => {
    const { root, docsDir } = await makeTmpDir();
    const store = new FsLedgerStore({ root });
    await store.init();
    await store.dispose();

    // Every canonical ledger must have a file on disk.
    for (const c of CANONICAL_LEDGERS) {
      const text = await readFile(path.join(docsDir, `${c.name}.md`), "utf8");
      expect(text).toContain(c.name);
    }
    // Registry must exist and name all canonical ledgers.
    const registry = await readFile(path.join(docsDir, "ledgers.yaml"), "utf8");
    for (const c of CANONICAL_LEDGERS) {
      expect(registry).toContain(c.name);
    }
  });

  it("milestones file has bootstrap group + M-AMBIENT", async () => {
    const { root, docsDir } = await makeTmpDir();
    const store = new FsLedgerStore({ root });
    await store.init();
    await store.dispose();

    const milestonesMd = await readFile(path.join(docsDir, `${MILESTONES_LEDGER}.md`), "utf8");
    expect(milestonesMd).toContain("## active");
    expect(milestonesMd).toContain(MILESTONES_AMBIENT_ID);
  });

  it("no .backup dir is created for an empty dir", async () => {
    const { root, docsDir } = await makeTmpDir();
    const store = new FsLedgerStore({ root });
    await store.init();
    await store.dispose();

    const backupParent = path.join(docsDir, ".backup");
    let exists = false;
    try {
      await stat(backupParent);
      exists = true;
    } catch {
      // ENOENT expected
    }
    expect(exists).toBe(false);
  });
});
