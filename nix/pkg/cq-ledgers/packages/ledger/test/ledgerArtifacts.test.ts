/**
 * T401: ledgerTreePaths includes logs/** in the portable tree; .locks/.backup
 * are excluded. removeLedgerArtifacts still removes ALL of logs/.locks/.backup.
 * T446: ledgerTreePaths returns storage-relative paths when called with a
 * LEDGER_STORAGE_DIRNAME (.cq/) base; absolute paths under .cq/ are correct.
 */

import { describe, it, expect, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ledgerTreePaths, removeLedgerArtifacts } from "../src/store/ledgerArtifacts.js";
import { LEDGER_STORAGE_DIRNAME } from "../src/constants.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * Create a temp root and return the LEDGER_STORAGE_DIRNAME (.cq/) dir within it.
 * All ledger artifacts should live here; the function name is preserved for
 * minimal diff but the returned path is now .cq/ not docs/.
 */
async function makeDocsDir(): Promise<{ root: string; storageDir: string }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "cq-artifacts-"));
  dirs.push(root);
  const storageDir = path.join(root, LEDGER_STORAGE_DIRNAME);
  await fs.mkdir(storageDir, { recursive: true });
  return { root, storageDir };
}

describe("ledgerTreePaths", () => {
  it("(a) includes logs/a.md and logs/raw/b.jsonl alongside ledgers.yaml and <name>.md", async () => {
    const { storageDir } = await makeDocsDir();

    // Seed a minimal ledger registry + one ledger file.
    await fs.writeFile(path.join(storageDir, "ledgers.yaml"), "version: 1\nledgers:\n  - tasks\n");
    await fs.writeFile(path.join(storageDir, "tasks.md"), "# tasks\n");

    // Seed archive/** so we can confirm it is also included.
    await fs.mkdir(path.join(storageDir, "archive", "tasks"), { recursive: true });
    await fs.writeFile(path.join(storageDir, "archive", "tasks", "M1.md"), "# M1\n");

    // Seed logs/** — the portable runtime content.
    await fs.mkdir(path.join(storageDir, "logs", "raw"), { recursive: true });
    await fs.writeFile(path.join(storageDir, "logs", "a.md"), "log entry\n");
    await fs.writeFile(path.join(storageDir, "logs", "raw", "b.jsonl"), '{"x":1}\n');

    // Seed ephemeral dirs that must NOT appear in ledgerTreePaths.
    await fs.mkdir(path.join(storageDir, ".locks"), { recursive: true });
    await fs.writeFile(path.join(storageDir, ".locks", "writer.lock"), "pid=1\n");
    await fs.mkdir(path.join(storageDir, ".backup", "20260101-000000"), { recursive: true });
    await fs.writeFile(path.join(storageDir, ".backup", "20260101-000000", "tasks.md"), "# backup\n");

    const paths = await ledgerTreePaths(storageDir);

    // Portable tree must include logs/** entries.
    expect(paths).toContain("logs/a.md");
    expect(paths).toContain("logs/raw/b.jsonl");

    // Portable tree must include the standard ledger artifacts.
    expect(paths).toContain("ledgers.yaml");
    expect(paths).toContain("tasks.md");
    expect(paths).toContain("archive/tasks/M1.md");

    // Ephemeral dirs must NOT appear.
    expect(paths.some((p) => p.startsWith(".locks"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".backup"))).toBe(false);

    // Result is sorted.
    expect(paths).toEqual([...paths].sort());
  });

  it("(a') logs/ absent → ledgerTreePaths still works and returns no logs/** entries", async () => {
    const { storageDir } = await makeDocsDir();
    await fs.writeFile(path.join(storageDir, "ledgers.yaml"), "version: 1\nledgers:\n  - tasks\n");
    await fs.writeFile(path.join(storageDir, "tasks.md"), "# tasks\n");

    const paths = await ledgerTreePaths(storageDir);
    expect(paths).toContain("ledgers.yaml");
    expect(paths).toContain("tasks.md");
    expect(paths.some((p) => p.startsWith("logs"))).toBe(false);
  });

  it(`(T446) ledgerTreePaths called with ${LEDGER_STORAGE_DIRNAME}/ base returns storage-relative paths; absolute files are under .cq/`, async () => {
    // Unit assertion: when the caller constructs storageDir as
    // path.join(root, LEDGER_STORAGE_DIRNAME), the returned paths are relative
    // to .cq/ (e.g. "ledgers.yaml", "tasks.md") — NOT prefixed with "docs/".
    // Verifies callers (cq erase via removeLedgerArtifacts, cq move-ledger via
    // ledgerTreePaths) get .cq/-rooted absolute paths.
    const { root, storageDir } = await makeDocsDir();

    // The storageDir must be <root>/.cq/.
    expect(storageDir).toBe(path.join(root, LEDGER_STORAGE_DIRNAME));

    await fs.writeFile(path.join(storageDir, "ledgers.yaml"), "version: 1\nledgers:\n  - tasks\n");
    await fs.writeFile(path.join(storageDir, "tasks.md"), "# tasks\n");
    await fs.mkdir(path.join(storageDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(storageDir, "logs", "session.md"), "# log\n");

    const relPaths = await ledgerTreePaths(storageDir);

    // Returned paths are STORAGE-RELATIVE (no .cq/ prefix).
    expect(relPaths).toContain("ledgers.yaml");
    expect(relPaths).toContain("tasks.md");
    expect(relPaths).toContain("logs/session.md");
    // No path starts with "docs/" or ".cq/".
    expect(relPaths.some((p) => p.startsWith("docs/"))).toBe(false);
    expect(relPaths.some((p) => p.startsWith(".cq/"))).toBe(false);

    // When joined with storageDir, each path resolves to a file under .cq/.
    for (const rel of relPaths) {
      const abs = path.join(storageDir, rel);
      expect(abs.startsWith(path.join(root, LEDGER_STORAGE_DIRNAME))).toBe(true);
      // Verify the file actually exists under .cq/.
      await fs.stat(abs); // throws if missing — test will fail.
    }
  });
});

describe("removeLedgerArtifacts", () => {
  it("(b) still removes logs/, .locks/, and .backup/ (erase behaviour unchanged)", async () => {
    const { storageDir } = await makeDocsDir();

    await fs.writeFile(path.join(storageDir, "ledgers.yaml"), "version: 1\nledgers:\n  - tasks\n");
    await fs.writeFile(path.join(storageDir, "tasks.md"), "# tasks\n");
    await fs.mkdir(path.join(storageDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(storageDir, "logs", "session.log"), "log\n");
    await fs.mkdir(path.join(storageDir, ".locks"), { recursive: true });
    await fs.writeFile(path.join(storageDir, ".locks", "writer.lock"), "pid=1\n");
    await fs.mkdir(path.join(storageDir, ".backup", "snap"), { recursive: true });
    await fs.writeFile(path.join(storageDir, ".backup", "snap", "tasks.md"), "# bak\n");

    const result = await removeLedgerArtifacts(storageDir);

    // All three runtime dirs removed.
    async function exists(p: string): Promise<boolean> {
      try {
        await fs.stat(p);
        return true;
      } catch {
        return false;
      }
    }
    expect(await exists(path.join(storageDir, "logs"))).toBe(false);
    expect(await exists(path.join(storageDir, ".locks"))).toBe(false);
    expect(await exists(path.join(storageDir, ".backup"))).toBe(false);

    // Standard ledger artifacts removed too.
    expect(await exists(path.join(storageDir, "ledgers.yaml"))).toBe(false);
    expect(await exists(path.join(storageDir, "tasks.md"))).toBe(false);

    // Result records the removals.
    expect(result.removed.length).toBeGreaterThan(0);
  });
});
