/**
 * Unit tests for the pure schema → graph-model adapter (T5, migrated to the elk
 * renderer in T203).
 *
 * Asserts the model's node colors come from the shared statusBucket→BUCKET_HEX
 * palette (so the diagram matches the badges), that every transition pair
 * produces a directed edge (INCLUDING self-loops, which the old computeDagLayout
 * model dropped), and that a schema without a `transitions` map is edgeless. The
 * adapter is layout-free now — positioning is elk's job (layoutDiagram).
 */

import { describe, it, expect } from "bun:test";
import { computeStateMachine } from "../src/stateMachine";
import { BUCKET_HEX, statusBucket } from "../src/status";
import type { LedgerSchema } from "../src/types";

const guarded: LedgerSchema = {
  statusValues: ["open", "wip", "closed"],
  terminalStatuses: ["closed"],
  fields: { headline: { type: "string", required: true } },
  transitions: { open: ["wip", "closed"], wip: ["closed", "open"], closed: [] },
};

const selfLooping: LedgerSchema = {
  statusValues: ["open", "wip", "closed"],
  terminalStatuses: ["closed"],
  fields: { headline: { type: "string", required: true } },
  // `wip -> wip` is a self-loop the old computeDagLayout model dropped.
  transitions: { open: ["wip"], wip: ["wip", "closed"], closed: [] },
};

const unguarded: LedgerSchema = {
  statusValues: ["open", "closed"],
  terminalStatuses: ["closed"],
  fields: { headline: { type: "string", required: true } },
};

describe("computeStateMachine", () => {
  it("colors every node via statusBucket + BUCKET_HEX", () => {
    const m = computeStateMachine(guarded);
    expect(m.nodes.map((n) => n.id).sort()).toEqual(["closed", "open", "wip"]);
    for (const n of m.nodes) {
      expect(n.label).toBe(n.id);
      expect(n.fill).toBe(BUCKET_HEX[statusBucket(n.id, guarded)]);
    }
    // terminal flag tracks terminalStatuses.
    expect(m.nodes.find((n) => n.id === "closed")!.terminal).toBe(true);
    expect(m.nodes.find((n) => n.id === "open")!.terminal).toBe(false);
  });

  it("emits one directed edge per transition pair", () => {
    const m = computeStateMachine(guarded);
    const pairs = m.edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(pairs).toEqual(["open->closed", "open->wip", "wip->closed", "wip->open"].sort());
  });

  it("keeps self-loop transitions (the old layout dropped them)", () => {
    const m = computeStateMachine(selfLooping);
    const pairs = m.edges.map((e) => `${e.from}->${e.to}`);
    expect(pairs).toContain("wip->wip");
  });

  it("renders nodes-only (no edges) for a schema without transitions", () => {
    const m = computeStateMachine(unguarded);
    expect(m.edges).toHaveLength(0);
    expect(m.nodes).toHaveLength(2);
    expect(m.nodes[0]!.fill).toBe(BUCKET_HEX[statusBucket("open", unguarded)]);
  });
});
