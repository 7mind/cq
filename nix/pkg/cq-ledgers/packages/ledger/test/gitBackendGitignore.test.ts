/**
 * T354: ensureGitBackendGitignore ↔ removeGitBackendGitignore round-trip.
 *
 * The `cq move-ledger` reversibility invariant: adding then removing the
 * marker-guarded git-backend block restores `.gitignore` byte-for-byte (and an
 * absent file is restored as absent). Throwaway dirs via mkdtemp.
 *
 * T434 (D66 fix): span-based refresh of stale blocks, legacy-format migration,
 * idempotency on current blocks, and legacy-remove coverage.
 *
 * T445 (G58): block entries use LEDGER_STORAGE_DIRNAME (.cq/) not docs/; old
 * docs/... managed block is self-migrated to .cq/... on next ensure run.
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

  it("ensureGitBackendGitignore writes a block containing '.cq/logs/' (not 'docs/logs/')", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");

    expect(await ensureGitBackendGitignore(root)).toBe(true);
    const content = await readFile(gi, "utf8");
    expect(content.includes(".cq/logs/")).toBe(true);
    expect(content.includes("docs/logs/")).toBe(false);
    expect(GIT_BACKEND_GITIGNORE_BLOCK.includes(".cq/logs/")).toBe(true);
    expect(GIT_BACKEND_GITIGNORE_BLOCK.includes("docs/logs/")).toBe(false);
  });

  // D66 repro — was test.failing() before T434 because ensureGitBackendGitignore
  // no-oped when the marker was present (gitBackendGitignore.ts:56-58), leaving a
  // stale pre-T402 block missing "docs/logs/". T434 fixes span-based refresh.
  // T445: the current block now uses .cq/ — the old docs/ block is still stale
  // (different path prefix) and must be replaced by the current .cq/ block.
  it("D66 repro: stale pre-T402 block (old docs/... entries) is refreshed by ensureGitBackendGitignore to .cq/...", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");

    // Build the legacy pre-T402 block: marker + 3 original lines, old docs/ paths.
    // Intentionally NOT using GIT_BACKEND_GITIGNORE_BLOCK (which now has .cq/ paths).
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
    expect(content).toContain(".cq/logs/");
    expect(content).not.toContain("docs/logs/");
    expect(content).not.toContain("docs/*.md");
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
    expect(content).toContain(".cq/logs/");
    expect(content).not.toContain("docs/logs/");
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
    // The block must now include .cq/logs/ (not docs/logs/) and the end marker.
    expect(content).toContain(".cq/logs/");
    expect(content).not.toContain("docs/logs/");
    expect(content).toContain(GIT_BACKEND_GITIGNORE_END_MARKER);
  });

  // T445 acceptance tests.

  it("T445 (a): GIT_BACKEND_GITIGNORE_BLOCK contains four .cq/ lines and no docs/ lines", () => {
    const lines = GIT_BACKEND_GITIGNORE_BLOCK.split("\n");
    // Exact expected entries (excluding markers).
    expect(lines).toContain(".cq/*.md");
    expect(lines).toContain(".cq/ledgers.yaml");
    expect(lines).toContain(".cq/.locks/");
    expect(lines).toContain(".cq/logs/");
    // None of the old docs/ entries must appear.
    expect(lines).not.toContain("docs/*.md");
    expect(lines).not.toContain("docs/ledgers.yaml");
    expect(lines).not.toContain("docs/.locks/");
    expect(lines).not.toContain("docs/logs/");
  });

  it("T445 (b): OLD docs/... managed block is self-migrated to .cq/... on next ensure, second run is no-op", async () => {
    const root = await tmp();
    const gi = path.join(root, ".gitignore");

    // Write the old docs/... managed block (current-format with end marker, as it
    // would have existed before T445).
    const oldBlock = [
      GIT_BACKEND_GITIGNORE_MARKER,
      "docs/*.md",
      "docs/ledgers.yaml",
      "docs/.locks/",
      "docs/logs/",
      GIT_BACKEND_GITIGNORE_END_MARKER,
    ].join("\n");
    await writeFile(gi, `${oldBlock}\n`, "utf8");

    // First ensure: must rewrite the stale docs/ block to the new .cq/ block.
    const wrote1 = await ensureGitBackendGitignore(root);
    expect(wrote1).toBe(true);

    const content1 = await readFile(gi, "utf8");
    // Must contain .cq/ entries.
    expect(content1).toContain(".cq/*.md");
    expect(content1).toContain(".cq/ledgers.yaml");
    expect(content1).toContain(".cq/.locks/");
    expect(content1).toContain(".cq/logs/");
    // Must not contain docs/ entries.
    expect(content1).not.toContain("docs/*.md");
    expect(content1).not.toContain("docs/ledgers.yaml");
    expect(content1).not.toContain("docs/.locks/");
    expect(content1).not.toContain("docs/logs/");
    // File must equal the current block exactly.
    expect(content1).toBe(`${GIT_BACKEND_GITIGNORE_BLOCK}\n`);

    // Second ensure: must be a no-op (block is already current).
    const wrote2 = await ensureGitBackendGitignore(root);
    expect(wrote2).toBe(false);

    const content2 = await readFile(gi, "utf8");
    expect(content2).toBe(content1);
  });
});
