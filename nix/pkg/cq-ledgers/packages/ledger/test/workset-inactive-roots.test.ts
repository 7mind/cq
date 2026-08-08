/**
 * T1952 — restrictive inactive roots.
 *
 * A non-empty configuration whose roots later leave the active snapshot
 * remains restrictive, reports inactive roots, derives no action until
 * exact-root unarchive or explicit set([]).
 */

import { describe, expect, it } from "bun:test";
import {
  buildWorksetActiveState,
  closeWorkset,
  isRestrictiveInactiveWorkset,
  WorksetRootError,
  type Item,
} from "../src/index.js";

const NOW = "2026-08-08T12:00:00.000Z";

function task(id: string, headline: string): Item {
  return {
    id,
    milestoneId: "M1",
    status: "planned",
    fields: { headline },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("workset-inactive-roots", () => {
  it("reports inactive roots and derives no nodes when all configured roots are inactive", () => {
    // Active snapshot no longer contains the configured root (archived).
    const state = buildWorksetActiveState([
      { ledger: "tasks", items: [task("T99", "unrelated live work")] },
    ]);
    const graph = closeWorkset(["tasks:T1", "tasks:T2"], state);
    expect(graph.roots).toEqual(["tasks:T1", "tasks:T2"]);
    expect(graph.inactiveRoots).toEqual(["tasks:T1", "tasks:T2"]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.restrictive).toBe(true);
    expect(isRestrictiveInactiveWorkset(graph)).toBe(true);
    // Must NOT widen to unrestricted execution (empty roots).
    expect(graph.roots.length).toBeGreaterThan(0);
  });

  it("mixes active and inactive roots without widening", () => {
    const state = buildWorksetActiveState([
      { ledger: "tasks", items: [task("T1", "still live")] },
    ]);
    const graph = closeWorkset(["tasks:T1", "tasks:T-gone"], state);
    expect(graph.roots).toEqual(["tasks:T1", "tasks:T-gone"]);
    expect(graph.inactiveRoots).toEqual(["tasks:T-gone"]);
    expect(graph.nodes.map((n) => n.ref)).toEqual(["tasks:T1"]);
    expect(graph.restrictive).toBe(true);
    expect(isRestrictiveInactiveWorkset(graph)).toBe(false);
  });

  it("unarchive recovery: same root becomes active on next derivation", () => {
    const empty = buildWorksetActiveState([{ ledger: "tasks", items: [] }]);
    const before = closeWorkset(["tasks:T1"], empty);
    expect(before.inactiveRoots).toEqual(["tasks:T1"]);
    expect(before.nodes).toEqual([]);

    const restored = buildWorksetActiveState([
      { ledger: "tasks", items: [task("T1", "back")] },
    ]);
    const after = closeWorkset(["tasks:T1"], restored);
    expect(after.inactiveRoots).toEqual([]);
    expect(after.nodes.map((n) => n.ref)).toEqual(["tasks:T1"]);
    expect(after.restrictive).toBe(true);
  });

  it("explicit set([]) clears restriction", () => {
    const state = buildWorksetActiveState([
      { ledger: "tasks", items: [task("T1", "x")] },
    ]);
    const graph = closeWorkset([], state);
    expect(graph.restrictive).toBe(false);
    expect(graph.roots).toEqual([]);
    expect(graph.inactiveRoots).toEqual([]);
    expect(graph.nodes).toEqual([]);
  });

  it("set/fetch validateLiveRoots rejects inactive roots", () => {
    const state = buildWorksetActiveState([{ ledger: "tasks", items: [] }]);
    expect(() =>
      closeWorkset(["tasks:T1"], state, { validateLiveRoots: true }),
    ).toThrow(WorksetRootError);
  });

  it("does not treat inactive configuration as empty-root unrestricted work", () => {
    const live = task("T50", "should not auto-include");
    const state = buildWorksetActiveState([{ ledger: "tasks", items: [live] }]);
    const graph = closeWorkset(["milestones:M404"], state);
    expect(graph.restrictive).toBe(true);
    expect(graph.nodes.map((n) => n.ref)).not.toContain("tasks:T50");
    expect(isRestrictiveInactiveWorkset(graph)).toBe(true);
  });
});
