import { describe, expect, it } from "bun:test";
import type { WorksetOperationClient } from "../mcp/worksetOperationClient.js";
import type { WorksetProjectionRequest } from "../mcp/worksetTool.js";
import type { WorksetProjectedGraph } from "../worksetGraph.js";

export interface WorksetClientContractFixture {
  readonly client: WorksetOperationClient;
  close(): Promise<void>;
}

export interface WorksetClientContractFactory {
  readonly name: string;
  readonly classification:
    | "Behavioral-Active Blackbox-Atomic"
    | "Behavioral-Active Blackbox-Group";
  build(): WorksetClientContractFixture | Promise<WorksetClientContractFixture>;
}

const PROJECTIONS: readonly WorksetProjectionRequest[] = [
  "id",
  "compact",
  "full",
  "complement",
];

export const WORKSET_CLIENT_CONTRACT_SEED = {
  milestone: { id: "M101", title: "Workset contract" },
  task: {
    id: "T101",
    status: "planned",
    fields: {
      headline: "contract task",
      description: "complement-only narrative",
      suggestedModel: "opus",
      acceptance: "exact graph parity",
      tags: [],
      dependsOn: ["tasks:T102"],
    },
  },
  dependency: {
    id: "T102",
    status: "planned",
    fields: { headline: "contract dependency" },
  },
  defect: {
    id: "D101",
    status: "open",
    fields: { headline: "excluded sibling defect", severity: "medium" },
  },
  question: {
    id: "Q101",
    status: "open",
    fields: { question: "excluded sibling question" },
  },
} as const;

function itemOf(graph: WorksetProjectedGraph): Record<string, unknown> {
  const node = graph.nodes[0];
  if (node === undefined || !("item" in node)) {
    throw new Error(`Expected one projected item, received ${JSON.stringify(graph)}`);
  }
  return node.item as unknown as Record<string, unknown>;
}

function fieldsOf(item: Record<string, unknown>): Record<string, unknown> {
  const fields = item["fields"];
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new Error(`Expected projected item fields, received ${JSON.stringify(item)}`);
  }
  return fields as Record<string, unknown>;
}

/** Shared test-only contract for client-side workset state models. */
export function runWorksetClientContract(factory: WorksetClientContractFactory): void {
  describe(`${factory.name} (${factory.classification})`, () => {
    it("keeps fetch nonmutating and preserves exact graphs across every get projection", async () => {
      const fixture = await factory.build();
      try {
        expect(await fixture.client.workset({ op: "get", projection: "id" })).toEqual({
          op: "get",
          graph: {
            roots: [],
            inactiveRoots: [],
            restrictive: false,
            projection: "id",
            nodes: [],
            edges: [],
          },
        });

        const fetched = new Map<WorksetProjectionRequest, WorksetProjectedGraph>();
        for (const projection of PROJECTIONS) {
          const result = await fixture.client.workset({
            op: "fetch",
            roots: [WORKSET_CLIENT_CONTRACT_SEED.task.id],
            projection,
          });
          expect(result.op).toBe("fetch");
          expect(result.graph).toMatchObject({
            roots: ["tasks:T101"],
            inactiveRoots: [],
            restrictive: true,
            projection,
            edges: [
              {
                from: "tasks:T101",
                to: "tasks:T102",
                kind: "prerequisite",
              },
            ],
          });
          expect(result.graph.nodes).toHaveLength(2);
          fetched.set(projection, result.graph);
        }

        expect(await fixture.client.workset({ op: "get", projection: "id" })).toEqual({
          op: "get",
          graph: {
            roots: [],
            inactiveRoots: [],
            restrictive: false,
            projection: "id",
            nodes: [],
            edges: [],
          },
        });

        const idGraph = fetched.get("id");
        const compactGraph = fetched.get("compact");
        const fullGraph = fetched.get("full");
        const complementGraph = fetched.get("complement");
        if (
          idGraph === undefined ||
          compactGraph === undefined ||
          fullGraph === undefined ||
          complementGraph === undefined
        ) {
          throw new Error("Expected every workset projection");
        }

        expect(idGraph.nodes).toEqual([{ ref: "tasks:T101" }, { ref: "tasks:T102" }]);
        const compactItem = itemOf(compactGraph);
        const fullItem = itemOf(fullGraph);
        const complementItem = itemOf(complementGraph);
        const compactFields = fieldsOf(compactItem);
        const fullFields = fieldsOf(fullItem);
        const complementFields = fieldsOf(complementItem);
        expect(compactItem).toMatchObject({
          id: "T101",
          milestoneId: "M101",
          status: "planned",
        });
        expect(compactFields).toEqual({
          headline: "contract task",
          suggestedModel: "opus",
          tags: [],
          dependsOn: ["tasks:T102"],
        });
        expect(fullItem).toMatchObject({ id: "T101", milestoneId: "M101", status: "planned" });
        expect(fullFields).toEqual(WORKSET_CLIENT_CONTRACT_SEED.task.fields);
        expect(complementItem).toEqual({
          id: "T101",
          fields: {
            description: "complement-only narrative",
            acceptance: "exact graph parity",
          },
        });
        expect(complementFields).toEqual({
          description: "complement-only narrative",
          acceptance: "exact graph parity",
        });
        expect({ ...compactFields, ...complementFields }).toEqual(fullFields);

        expect(
          await fixture.client.workset({
            op: "set",
            roots: ["T101", "tasks:T101", "T101"],
          }),
        ).toEqual({
          op: "set",
          acknowledgement: { epoch: 1, roots: ["tasks:T101"] },
        });

        for (const projection of PROJECTIONS) {
          const result = await fixture.client.workset({ op: "get", projection });
          const expected = fetched.get(projection);
          if (expected === undefined) throw new Error(`Expected ${projection} projection`);
          expect(result.op).toBe("get");
          expect(result.graph).toEqual(expected);
        }

        expect(
          await fixture.client.workset({ op: "set", roots: ["tasks:T101"] }),
        ).toEqual({
          op: "set",
          acknowledgement: { epoch: 2, roots: ["tasks:T101"] },
        });
        expect(await fixture.client.workset({ op: "set", roots: [] })).toEqual({
          op: "set",
          acknowledgement: { epoch: 3, roots: [] },
        });
        expect(await fixture.client.workset({ op: "get", projection: "id" })).toEqual({
          op: "get",
          graph: {
            roots: [],
            inactiveRoots: [],
            restrictive: false,
            projection: "id",
            nodes: [],
            edges: [],
          },
        });
      } finally {
        await fixture.close();
      }
    });

    it("rejects an inactive root atomically without mutating roots or allocating an epoch", async () => {
      const fixture = await factory.build();
      try {
        expect(await fixture.client.workset({ op: "set", roots: ["T101"] })).toEqual({
          op: "set",
          acknowledgement: { epoch: 1, roots: ["tasks:T101"] },
        });
        const before = await fixture.client.workset({ op: "get", projection: "full" });

        await expect(
          fixture.client.workset({
            op: "fetch",
            roots: ["T999"],
            projection: "full",
          }),
        ).rejects.toThrow(/tasks:T999.*inactive/);
        await expect(
          fixture.client.workset({ op: "set", roots: ["T999"] }),
        ).rejects.toThrow(/tasks:T999.*inactive/);
        expect(await fixture.client.workset({ op: "get", projection: "full" })).toEqual(
          before,
        );
        expect(await fixture.client.workset({ op: "set", roots: ["T101"] })).toEqual({
          op: "set",
          acknowledgement: { epoch: 2, roots: ["tasks:T101"] },
        });
      } finally {
        await fixture.close();
      }
    });

    it("expands an explicit milestone to tasks without admitting sibling ledger items", async () => {
      const fixture = await factory.build();
      try {
        const result = await fixture.client.workset({
          op: "fetch",
          roots: [WORKSET_CLIENT_CONTRACT_SEED.milestone.id],
          projection: "id",
        });
        expect(result.op).toBe("fetch");
        expect(result.graph).toEqual({
          roots: ["milestones:M101"],
          inactiveRoots: [],
          nodes: [
            { ref: "milestones:M101" },
            { ref: "tasks:T101" },
            { ref: "tasks:T102" },
          ],
          edges: [
            { from: "tasks:T101", to: "tasks:T102", kind: "prerequisite" },
          ],
          restrictive: true,
          projection: "id",
        });
        expect(await fixture.client.workset({ op: "get", projection: "id" })).toMatchObject({
          op: "get",
          graph: { roots: [] },
        });
      } finally {
        await fixture.close();
      }
    });
  });
}
