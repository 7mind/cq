/**
 * loadDagData test — builds the milestone graph + reference counts from a
 * LedgerClient (no DOM). Verifies edge direction (dep → dependent), that both
 * dependsOn and blockedBy contribute edges, and cross-ledger ref tallies.
 */

import { describe, it, expect } from "bun:test";
import { loadDagData } from "../src/dagData.js";
import { DagFakeClient } from "./helpers/dagFake.js";

describe("loadDagData", () => {
  it("derives the milestones DAG: dependency edges + cross-ledger ref counts", async () => {
    const data = await loadDagData(new DagFakeClient(), "milestones");

    expect(data.ledgerId).toBe("milestones");
    expect(data.nodes.map((m) => m.id).sort()).toEqual(["M1", "M2", "M3"]);

    // dependsOn (M2→via M1) and blockedBy (M3→via M2) both yield edges
    // pointing from the prerequisite to the dependent.
    const edgeSet = new Set(data.edges.map((e) => `${e.from}->${e.to}`));
    expect(edgeSet.has("M1->M2")).toBe(true);
    expect(edgeSet.has("M2->M3")).toBe(true);
    expect(data.edges).toHaveLength(2);

    const byId = new Map(data.nodes.map((m) => [m.id, m]));
    // milestone sublabels are cross-ledger reference counts
    expect(byId.get("M1")!.sublabel).toBe("2 items");
    expect(byId.get("M2")!.sublabel).toBe("1 items");
    expect(byId.get("M3")!.sublabel).toBe("0 items");
    expect(byId.get("M1")!.title).toBe("Foundations");
    expect(byId.get("M3")!.status).toBe("blocked");
  });

  it("scopes the DAG to a non-milestones ledger (item deps + @milestone sublabel)", async () => {
    const data = await loadDagData(new DagFakeClient(), "bugs");

    expect(data.ledgerId).toBe("bugs");
    expect(data.nodes.map((n) => n.id).sort()).toEqual(["D1", "D2", "D3"]);
    // D2 dependsOn D1 → edge D1→D2 (intra-ledger).
    expect(data.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["D1->D2"]);
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    expect(byId.get("D1")!.sublabel).toBe("@M1");
    expect(byId.get("D3")!.sublabel).toBe("@M2");
  });
});
