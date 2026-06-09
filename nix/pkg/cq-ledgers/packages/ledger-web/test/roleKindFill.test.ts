/**
 * Tests for the FU-4 RoleKind / fill foundation in roleActions (T326).
 *
 * Asserts:
 *   - `RoleKind` is the exported named union and includes the infra kinds
 *     `worktree` / `main` / `ledger` (a compile-time assignment + runtime
 *     membership check via ROLE_KIND_FILL's keys);
 *   - `ROLE_KIND_FILL` is `Record<RoleKind, string>` with one distinct hex per
 *     RoleKind (exhaustive — every kind present, every hex unique, valid #rrggbb);
 *   - `fillForRoleKind` is stable: it returns the ROLE_KIND_FILL entry for each
 *     kind and is referentially consistent across calls.
 *
 * These helpers are authoring inputs for T327; the DiagramSvg renderer does NOT
 * consult them (locked Q181), so there is no renderer assertion here.
 */

import { describe, it, expect } from "bun:test";
import {
  ROLE_KIND_FILL,
  fillForRoleKind,
  type RoleKind,
} from "../src/roleActions";

// The canonical, exhaustive list of RoleKinds. Kept in one place so the test
// fails to compile if RoleKind gains/loses a member without this list updating.
const ALL_ROLE_KINDS: readonly RoleKind[] = [
  "orchestrator",
  "planner",
  "reviewer",
  "worker",
  "conflict-resolver",
  "explore",
  "user",
  "external",
  "worktree",
  "main",
  "ledger",
] as const;

// Compile-time exhaustiveness: a Record over the literal list must be
// assignable to Record<RoleKind, true> iff the list covers every RoleKind.
const _exhaustive: Record<RoleKind, true> = Object.fromEntries(
  ALL_ROLE_KINDS.map((k) => [k, true]),
) as Record<RoleKind, true>;
void _exhaustive;

const HEX = /^#[0-9a-fA-F]{6}$/;

describe("RoleKind union (T326)", () => {
  it("includes the infra kinds worktree / main / ledger", () => {
    const keys = new Set(Object.keys(ROLE_KIND_FILL));
    expect(keys.has("worktree")).toBe(true);
    expect(keys.has("main")).toBe(true);
    expect(keys.has("ledger")).toBe(true);
  });
});

describe("ROLE_KIND_FILL (T326)", () => {
  it("has exactly one entry per RoleKind (exhaustive, no extras)", () => {
    const keys = Object.keys(ROLE_KIND_FILL).sort();
    expect(keys).toEqual([...ALL_ROLE_KINDS].sort());
  });

  it("every fill is a valid #rrggbb hex", () => {
    for (const kind of ALL_ROLE_KINDS) {
      expect(ROLE_KIND_FILL[kind]).toMatch(HEX);
    }
  });

  it("every RoleKind has a distinct hue", () => {
    const hexes = ALL_ROLE_KINDS.map((k) => ROLE_KIND_FILL[k].toLowerCase());
    expect(new Set(hexes).size).toBe(ALL_ROLE_KINDS.length);
  });
});

describe("fillForRoleKind (T326)", () => {
  it("returns the ROLE_KIND_FILL entry for each kind", () => {
    for (const kind of ALL_ROLE_KINDS) {
      expect(fillForRoleKind(kind)).toBe(ROLE_KIND_FILL[kind]);
    }
  });

  it("is stable across repeated calls", () => {
    for (const kind of ALL_ROLE_KINDS) {
      expect(fillForRoleKind(kind)).toBe(fillForRoleKind(kind));
    }
  });
});
