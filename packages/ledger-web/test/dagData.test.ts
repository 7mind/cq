/**
 * loadDagData test — builds the milestone graph + reference counts from a
 * LedgerClient (no DOM). Verifies edge direction (dep → dependent), that both
 * dependsOn and blockedBy contribute edges, and cross-ledger ref tallies.
 */

import { describe, it, expect } from "bun:test";
import { loadDagData } from "../src/dagData.js";
import { DagFakeClient } from "./helpers/dagFake.js";

describe("loadDagData", () => {
  it("derives milestone nodes, dependency edges, and reference counts", async () => {
    const data = await loadDagData(new DagFakeClient());

    expect(data.milestones.map((m) => m.id).sort()).toEqual(["M1", "M2", "M3"]);

    // dependsOn (M2→via M1) and blockedBy (M3→via M2) both yield edges
    // pointing from the prerequisite to the dependent.
    const edgeSet = new Set(data.edges.map((e) => `${e.from}->${e.to}`));
    expect(edgeSet.has("M1->M2")).toBe(true);
    expect(edgeSet.has("M2->M3")).toBe(true);
    expect(data.edges).toHaveLength(2);

    const byId = new Map(data.milestones.map((m) => [m.id, m]));
    expect(byId.get("M1")!.refCount).toBe(2);
    expect(byId.get("M2")!.refCount).toBe(1);
    expect(byId.get("M3")!.refCount).toBe(0);
    expect(byId.get("M1")!.title).toBe("Foundations");
    expect(byId.get("M3")!.status).toBe("blocked");
  });
});
