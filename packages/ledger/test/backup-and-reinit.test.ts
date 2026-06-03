/**
 * Unit tests for FsLedgerStore.backupAndReinit (T94).
 *
 * The helper is private; we access it via `(store as any)` — a standard
 * pattern for testing private methods without widening the public API.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, readdir, stat, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  CANONICAL_LEDGERS,
  MILESTONES_LEDGER,
  serializeRegistry,
} from "../src/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function makeStore(
  opts: { seedRegistry?: boolean; now?: () => string } = {},
): Promise<{ store: FsLedgerStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-backup-"));
  dirs.push(root);
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  if (opts.seedRegistry) {
    // Write a minimal registry so the store can init().
    await writeFile(
      path.join(docsDir, "ledgers.yaml"),
      serializeRegistry({ version: 1, ledgers: CANONICAL_LEDGERS.map((c) => ({ name: c.name, schema: c.schema })) }),
      "utf8",
    );
  }
  const storeOpts: ConstructorParameters<typeof FsLedgerStore>[0] = { root };
  if (opts.now !== undefined) storeOpts.now = opts.now;
  const store = new FsLedgerStore(storeOpts);
  return { store, root };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callBackupAndReinit(store: FsLedgerStore): Promise<string> {
  // Access private method via `any` cast — test-only pattern.
  return (store as unknown as Record<string, () => Promise<string>>)["backupAndReinit"]!();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FsLedgerStore.backupAndReinit", () => {
  it("creates docs/.backup/<sanitized-ts>/ directory", async () => {
    const fixedTs = "2026-06-01T12:34:56.000Z";
    const { store, root } = await makeStore({ now: () => fixedTs });
    const docsDir = path.join(root, "docs");
    await mkdir(docsDir, { recursive: true });

    await callBackupAndReinit(store);

    // Colons replaced with '-': "2026-06-01T12-34-56.000Z"
    const expectedDirName = fixedTs.replace(/:/g, "-");
    const backupDir = path.join(docsDir, ".backup", expectedDirName);
    const s = await stat(backupDir);
    expect(s.isDirectory()).toBe(true);
  });

  it("copies ledgers.yaml into backup dir if it exists, tolerates ENOENT", async () => {
    const fixedTs = "2026-06-01T00:00:00.000Z";
    const { store, root } = await makeStore({ now: () => fixedTs, seedRegistry: true });

    await callBackupAndReinit(store);

    const expectedDirName = fixedTs.replace(/:/g, "-");
    const backupDir = path.join(root, "docs", ".backup", expectedDirName);
    const files = await readdir(backupDir);
    expect(files).toContain("ledgers.yaml");
  });

  it("tolerates ENOENT for ledger files that do not yet exist", async () => {
    const fixedTs = "2026-06-01T01:00:00.000Z";
    // No seedRegistry=true — docs/ has no files at all; all ENOENT.
    const { store, root } = await makeStore({ now: () => fixedTs });
    const docsDir = path.join(root, "docs");
    await mkdir(docsDir, { recursive: true });

    // Must not throw despite no files to copy; returns the backup dir path.
    const expectedDirName = fixedTs.replace(/:/g, "-");
    const backupDir = path.join(docsDir, ".backup", expectedDirName);
    await expect(callBackupAndReinit(store)).resolves.toBe(backupDir);

    const s = await stat(backupDir);
    expect(s.isDirectory()).toBe(true);
  });

  it("writes fresh canonical registry to docs/ledgers.yaml after backup", async () => {
    const fixedTs = "2026-06-01T02:00:00.000Z";
    const { store, root } = await makeStore({ now: () => fixedTs, seedRegistry: true });

    await callBackupAndReinit(store);

    const registryText = await readFile(path.join(root, "docs", "ledgers.yaml"), "utf8");
    // All canonical ledger names should appear in the fresh registry.
    for (const c of CANONICAL_LEDGERS) {
      expect(registryText).toContain(c.name);
    }
  });

  it("writes fresh milestones.md with bootstrap group and M-AMBIENT", async () => {
    const fixedTs = "2026-06-01T03:00:00.000Z";
    const { store, root } = await makeStore({ now: () => fixedTs });
    const docsDir = path.join(root, "docs");
    await mkdir(docsDir, { recursive: true });

    await callBackupAndReinit(store);

    const milestonesPath = path.join(docsDir, `${MILESTONES_LEDGER}.md`);
    const text = await readFile(milestonesPath, "utf8");
    expect(text).toContain("## active");
    expect(text).toContain("M-AMBIENT");
  });

  it("writes fresh canonical ledger files for all CANONICAL_LEDGERS entries", async () => {
    const fixedTs = "2026-06-01T04:00:00.000Z";
    const { store, root } = await makeStore({ now: () => fixedTs });
    const docsDir = path.join(root, "docs");
    await mkdir(docsDir, { recursive: true });

    await callBackupAndReinit(store);

    for (const c of CANONICAL_LEDGERS) {
      const filePath = path.join(docsDir, `${c.name}.md`);
      const text = await readFile(filePath, "utf8");
      // Each file should name its ledger.
      expect(text).toContain(c.name);
    }
  });

  it("emits a WARNING to stderr naming the backup path", async () => {
    const fixedTs = "2026-06-01T05:00:00.000Z";
    const { store, root } = await makeStore({ now: () => fixedTs });
    const docsDir = path.join(root, "docs");
    await mkdir(docsDir, { recursive: true });

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return originalWrite(chunk);
    };
    try {
      await callBackupAndReinit(store);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = originalWrite;
    }

    const combined = stderrChunks.join("");
    expect(combined).toContain("WARNING");
    const expectedDirName = fixedTs.replace(/:/g, "-");
    const backupDir = path.join(docsDir, ".backup", expectedDirName);
    expect(combined).toContain(backupDir);
  });
});
