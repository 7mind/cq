/**
 * T354: ensureGitBackendGitignore ↔ removeGitBackendGitignore round-trip.
 *
 * The `cq move-ledger` reversibility invariant: adding then removing the
 * marker-guarded git-backend block restores `.gitignore` byte-for-byte (and an
 * absent file is restored as absent). Throwaway dirs via mkdtemp.
 *
 * T434 (D66 fix): span-based refresh of stale blocks, legacy-format migration,
 * idempotency on current blocks, and legacy-remove coverage.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ensureGitBackendGitignore,
  removeGitBackendGitignore,
  GIT_BACKEND_GITIGNORE_MARKER,
  GIT_BACKEND_GITIGNORE_END_MARKER,
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

  // D66 repro — was test.failing() before T434 because ensureGitBackendGitignore
  // no-oped when the marker was present (gitBackendGitignore.ts:56-58), leaving a
  // stale pre-T402 block missing "docs/logs/". T434 fixes span-based refresh.
  it("D66 repro: stale pre-T402 block (no docs/logs/) is refreshed by ensureGitBackendGitignore", async () => {
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

    const wrote = await ensureGitBackendGitignore(root);
    expect(wrote).toBe(true);

    const content = await readFile(gi, "utf8");
    expect(content).toContain("docs/logs/");
    expect(content).toContain(GIT_BACKEND_GITIGNORE_END_MARKER);
    // The span should now equal the current block exactly.
    expect(content).toBe(`${GIT_BACKEND_GITIGNORE_BLOCK}\n`);
  });

  // (b) ensure on a CURRENT-format block is a no-op.
  it("(b) ensure on a current-format block is a no-op (returns false, bytes unchanged)", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");

    // First call: write the current block.
    expect(await ensureGitBackendGitignore(root)).toBe(true);
    const before = await readFile(gi, "utf8");

    // Second call: must be a no-op.
    expect(await ensureGitBackendGitignore(root)).toBe(false);
    const after = await readFile(gi, "utf8");
    expect(after).toBe(before);
  });

  // (c) removeGitBackendGitignore strips a LEGACY old-format (no-end-marker) block.
  it("(c) removeGitBackendGitignore strips a legacy (no-end-marker) block", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");

    const legacyBlock = [
      GIT_BACKEND_GITIGNORE_MARKER,
      "docs/*.md",
      "docs/ledgers.yaml",
      "docs/.locks/",
    ].join("\n");
    await writeFile(gi, `${legacyBlock}\n`, "utf8");

    expect(await removeGitBackendGitignore(root)).toBe(true);
    // File should be gone (was the only content).
    expect(await exists(gi)).toBe(false);
  });

  // (d) add → remove round-trip on the current format is byte-exact.
  it("(d) add → remove round-trip on current format is byte-exact (pre-existing content)", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");
    const original = "node_modules/\n*.env\n";
    await writeFile(gi, original, "utf8");

    await ensureGitBackendGitignore(root);
    await removeGitBackendGitignore(root);

    const restored = await readFile(gi, "utf8");
    expect(restored).toBe(original);
  });

  // (e) Edge cases for legacy-span bound.
  it("(e) legacy block with NO trailing newline: ensure refreshes to current format", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");

    // Legacy block written without a trailing newline.
    const legacyBlock = [
      GIT_BACKEND_GITIGNORE_MARKER,
      "docs/*.md",
      "docs/ledgers.yaml",
      "docs/.locks/",
    ].join("\n");
    await writeFile(gi, legacyBlock, "utf8"); // no trailing \n

    const wrote = await ensureGitBackendGitignore(root);
    expect(wrote).toBe(true);
    const content = await readFile(gi, "utf8");
    expect(content).toContain("docs/logs/");
    expect(content).toContain(GIT_BACKEND_GITIGNORE_END_MARKER);
  });

  it("(e) legacy block with content after it (blank-line separated): migration must not swallow trailing lines", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");

    // Legacy block followed by a blank line and more content.
    const legacyBlock = [
      GIT_BACKEND_GITIGNORE_MARKER,
      "docs/*.md",
      "docs/ledgers.yaml",
      "docs/.locks/",
    ].join("\n");
    const trailing = "# user content\nbuild/\n";
    // The blank line separates the legacy block from trailing content.
    await writeFile(gi, `${legacyBlock}\n\n${trailing}`, "utf8");

    await ensureGitBackendGitignore(root);
    const content = await readFile(gi, "utf8");

    // The trailing user content must be preserved.
    expect(content).toContain(trailing);
    // The block must now include docs/logs/ and the end marker.
    expect(content).toContain("docs/logs/");
    expect(content).toContain(GIT_BACKEND_GITIGNORE_END_MARKER);
  });
});
