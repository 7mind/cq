import { describe, expect, it } from "bun:test";
import type { WorksetOperationClient } from "../mcp/worksetOperationClient.js";

export interface WorksetClientContractFixture {
  readonly client: WorksetOperationClient;
  close(): Promise<void>;
}

export interface WorksetClientContractFactory {
  readonly name: string;
  readonly classification: "Behavioral-Active Blackbox-Atomic";
  build(): WorksetClientContractFixture | Promise<WorksetClientContractFixture>;
}

/** Shared test-only contract for client-side workset state models. */
export function runWorksetClientContract(factory: WorksetClientContractFactory): void {
  describe(`${factory.name} [${factory.classification}]`, () => {
    it("routes get/fetch and increments duplicate, identical, and empty replacements", async () => {
      const fixture = await factory.build();
      try {
        expect(await fixture.client.workset({ op: "get", projection: "id" })).toEqual({
          op: "get",
          graph: {
            roots: [],
            inactiveRoots: [],
            nodes: [],
            edges: [],
            restrictive: false,
            projection: "id",
          },
        });
        expect(
          await fixture.client.workset({ op: "fetch", roots: ["T1"], projection: "id" }),
        ).toEqual({
          op: "fetch",
          graph: {
            roots: ["tasks:T1"],
            inactiveRoots: [],
            nodes: [{ ref: "tasks:T1" }],
            edges: [],
            restrictive: true,
            projection: "id",
          },
        });
        const complement = await fixture.client.workset({
          op: "fetch",
          roots: ["T1"],
          projection: "complement",
        });
        expect(complement.graph.projection).toBe("complement");
        expect(complement.graph.nodes[0]).toMatchObject({
          ref: "tasks:T1",
          item: { id: "T1", fields: expect.any(Object) },
        });
        expect(complement.graph.nodes[0]).not.toHaveProperty("item.status");
        expect(complement.graph.nodes[0]).not.toHaveProperty("item.fields.headline");
        expect(
          await fixture.client.workset({
            op: "set",
            roots: ["T1", "tasks:T1", "T1"],
          }),
        ).toEqual({
          op: "set",
          acknowledgement: { roots: ["tasks:T1"], epoch: 1 },
        });
        expect(await fixture.client.workset({ op: "set", roots: ["tasks:T1"] })).toEqual({
          op: "set",
          acknowledgement: { roots: ["tasks:T1"], epoch: 2 },
        });
        expect(await fixture.client.workset({ op: "set", roots: [] })).toEqual({
          op: "set",
          acknowledgement: { roots: [], epoch: 3 },
        });
      } finally {
        await fixture.close();
      }
    });

    it("rejects an invalid replacement without changing roots or epoch", async () => {
      const fixture = await factory.build();
      try {
        await fixture.client.workset({ op: "set", roots: ["T1"] });
        const before = await fixture.client.workset({ op: "get", projection: "id" });
        await expect(
          fixture.client.workset({ op: "set", roots: ["T-missing"] }),
        ).rejects.toThrow(/tasks:T-missing.*inactive/);
        expect(await fixture.client.workset({ op: "get", projection: "id" })).toEqual(before);
        expect(await fixture.client.workset({ op: "set", roots: ["T1"] })).toEqual({
          op: "set",
          acknowledgement: { roots: ["tasks:T1"], epoch: 2 },
        });
      } finally {
        await fixture.close();
      }
    });

    it("expands an explicit milestone root to live tasks, not sibling-ledger groups", async () => {
      const fixture = await factory.build();
      try {
        const result = await fixture.client.workset({
          op: "fetch",
          roots: ["M1"],
          projection: "id",
        });
        const refs = result.graph.nodes.map(({ ref }) => ref);
        expect(refs[0]).toBe("milestones:M1");
        expect(refs).toContain("tasks:T1");
        expect(refs.some((ref) => ref.startsWith("bugs:"))).toBe(false);
        expect(refs.some((ref) => ref.startsWith("questions:"))).toBe(false);
      } finally {
        await fixture.close();
      }
    });
  });
}
