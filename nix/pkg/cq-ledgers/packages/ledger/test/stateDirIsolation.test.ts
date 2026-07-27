/**
 * D170 regression guard — the test suite must NEVER be able to resolve the
 * developer's real out-of-tree ledger store.
 *
 * Reproduce-first history: with XDG_STATE_HOME unset (which is what `bun test`
 * saw before `bunfig.toml`'s preload existed), `resolveStateDirBase(<repo key>)`
 * returns exactly `~/.local/state/cq/projects/<repo key>` — the live store.
 * A subagent running in a worktree consequently wiped it (1147 active + 2278
 * archived items replaced by one bootstrap milestone), because projectKey is the
 * repo's first-commit SHA and is identical across every worktree by design
 * (Q246). These assertions fail if the preload is removed, mis-pathed, or
 * silently stops taking effect.
 */
import { describe, it, expect } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveStateDirBase } from "../src/stateDir.js";

/** The real store root the suite must never resolve to. */
const REAL_STATE_ROOT = join(homedir(), ".local", "state", "cq");

describe("D170: test runs are isolated from the real ledger store", () => {
  it("preload set XDG_STATE_HOME to an absolute throwaway path", () => {
    const xdg = process.env.XDG_STATE_HOME;
    expect(xdg, "XDG_STATE_HOME must be set by the bunfig preload").toBeDefined();
    expect(xdg!.trim()).not.toBe("");
    expect(isAbsolute(xdg!)).toBe(true);
    // Must live under the OS temp root, not the user's state dir.
    expect(xdg!.startsWith(tmpdir())).toBe(true);
  });

  it("does not resolve to the real ~/.local/state/cq store for ANY project key", () => {
    // Includes this repo's own production key — the exact path that was wiped.
    for (const key of [
      "9faab3c136afe411b16a43206b14f834382ed440",
      "some-other-project",
      "a",
    ]) {
      const resolved = resolveStateDirBase(key);
      expect(
        resolved.startsWith(REAL_STATE_ROOT),
        `resolveStateDirBase(${key}) escaped isolation: ${resolved}`,
      ).toBe(false);
      expect(resolved.startsWith(process.env.XDG_STATE_HOME!)).toBe(true);
    }
  });

  it("the isolated root is NOT the real state root even by coincidence", () => {
    expect(process.env.XDG_STATE_HOME).not.toBe(join(homedir(), ".local", "state"));
    expect(resolveStateDirBase("k")).not.toBe(join(REAL_STATE_ROOT, "projects", "k"));
  });
});
