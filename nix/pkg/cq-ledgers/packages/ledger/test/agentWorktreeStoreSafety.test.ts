/**
 * defects:D404 x decisions:D170 — the store-safety guard after the cutover.
 *
 * D170's guard refuses to resolve a project key for a repository root inside an
 * agent worktree: a worktree shares the main checkout's object database, so the
 * first-commit SHA resolves the SAME out-of-tree store, and a divergent open
 * once destroyed 1147 active and 2278 archived items.
 *
 * D404 moved CQ's own managed placement to `.cq/worktrees`. If the guard had
 * kept matching only `.claude/worktrees`, every freshly created CQ worktree
 * would have become invisible to it — reopening exactly that hole. This pins
 * both parents, and pins that the segment match is still on whole segments.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_WORKTREE_SEGMENTS, isInsideAgentWorktree } from "../src/projectKey.js";

const UUID = "0192f3a1-7c2b-7e10-9a44-2f5b6c7d8e9f";

describe("D404/D170 agent worktree detection", () => {
  test("names both managed parents", () => {
    expect([...AGENT_WORKTREE_SEGMENTS]).toEqual([".cq/worktrees", ".claude/worktrees"]);
  });

  test("detects a root inside either parent", () => {
    expect(isInsideAgentWorktree(`/repo/.cq/worktrees/${UUID}`)).toBe(true);
    expect(isInsideAgentWorktree(`/repo/.claude/worktrees/${UUID}`)).toBe(true);
    // Nested deeper still counts: the guard is about being anywhere inside.
    expect(isInsideAgentWorktree(`/repo/.cq/worktrees/${UUID}/packages/x`)).toBe(true);
    expect(isInsideAgentWorktree(`C:\\repo\\.cq\\worktrees\\${UUID}`)).toBe(true);
  });

  test("the main checkout and lookalike directories are not worktrees", () => {
    expect(isInsideAgentWorktree("/repo")).toBe(false);
    expect(isInsideAgentWorktree("/repo/.cq")).toBe(false);
    // Whole-segment matching: a directory merely NAMED like the segment must
    // not be mistaken for one, or the guard would refuse legitimate roots.
    expect(isInsideAgentWorktree("/repo/my.cq/worktrees-notes")).toBe(false);
    expect(isInsideAgentWorktree("/repo/my.claude/worktrees-notes")).toBe(false);
    expect(isInsideAgentWorktree("/repo/.cq/worktrees-archive")).toBe(false);
  });
});
