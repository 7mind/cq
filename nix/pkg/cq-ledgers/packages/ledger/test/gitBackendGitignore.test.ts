/**
 * T354: ensureGitBackendGitignore ↔ removeGitBackendGitignore round-trip.
 *
 * The `cq move-ledger` reversibility invariant: adding then removing the
 * marker-guarded git-backend block restores `.gitignore` byte-for-byte (and an
 * absent file is restored as absent). Throwaway dirs via mkdtemp.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ensureGitBackendGitignore,
  removeGitBackendGitignore,
  GIT_BACKEND_GITIGNORE_MARKER,
  GIT_BACKEND_GITIGNORE_BLOCK,
} from "../src/store/gitBackendGitignore.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "cq-gi-"));
  dirs.push(d);
  return d;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("git-backend .gitignore add/remove round-trip", () => {
  it("absent file: add creates it, remove deletes it (back to absent)", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");
    expect(await exists(gi)).toBe(false);

    expect(await ensureGitBackendGitignore(root)).toBe(true);
    expect((await readFile(gi, "utf8")).includes(GIT_BACKEND_GITIGNORE_MARKER)).toBe(true);

    expect(await removeGitBackendGitignore(root)).toBe(true);
    expect(await exists(gi)).toBe(false);
  });

  it("pre-existing content: add appends, remove restores byte-for-byte", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");
    const original = "node_modules/\ndist/\n*.log\n";
    await writeFile(gi, original, "utf8");

    expect(await ensureGitBackendGitignore(root)).toBe(true);
    const withBlock = await readFile(gi, "utf8");
    expect(withBlock.includes(GIT_BACKEND_GITIGNORE_MARKER)).toBe(true);
    expect(withBlock.startsWith(original)).toBe(true);

    expect(await removeGitBackendGitignore(root)).toBe(true);
    expect(await readFile(gi, "utf8")).toBe(original);
  });

  it("remove is a no-op when the marker is absent", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");
    await writeFile(gi, "dist/\n", "utf8");
    expect(await removeGitBackendGitignore(root)).toBe(false);
    expect(await readFile(gi, "utf8")).toBe("dist/\n");
  });

  it("remove returns false when no .gitignore exists", async () => {
    const root = await tmp();
    expect(await removeGitBackendGitignore(root)).toBe(false);
  });

  it("ensureGitBackendGitignore writes a block containing 'docs/logs/'", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");

    expect(await ensureGitBackendGitignore(root)).toBe(true);
    const content = await readFile(gi, "utf8");
    expect(content.includes("docs/logs/")).toBe(true);
    expect(GIT_BACKEND_GITIGNORE_BLOCK.includes("docs/logs/")).toBe(true);
  });

  // D66 repro — test.failing() today because ensureGitBackendGitignore no-ops when the
  // marker is present (gitBackendGitignore.ts:56-58), leaving a stale pre-T402 block
  // that is missing "docs/logs/".  T434 fixes the function; flip this to test() then.
  it.failing(
    "D66 repro: stale pre-T402 block (no docs/logs/) is refreshed by ensureGitBackendGitignore",
    async () => {
      const root = await tmp();
      const gi = path.join(root, ".gitignore");

      // Build the legacy pre-T402 block: marker + 3 original lines, NO docs/logs/.
      // Intentionally NOT using GIT_BACKEND_GITIGNORE_BLOCK (which already has docs/logs/).
      const legacyBlock = [
        GIT_BACKEND_GITIGNORE_MARKER,
        "docs/*.md",
        "docs/ledgers.yaml",
        "docs/.locks/",
      ].join("\n");
      await writeFile(gi, `${legacyBlock}\n`, "utf8");

      await ensureGitBackendGitignore(root);

      const content = await readFile(gi, "utf8");
      // Today this assertion fails: the function no-ops on marker presence, so
      // docs/logs/ stays absent.  T434 will make it pass.
      expect(content).toContain("docs/logs/");
    },
  );
});
