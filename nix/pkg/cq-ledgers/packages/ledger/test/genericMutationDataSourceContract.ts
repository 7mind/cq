import { describe, expect, test } from "bun:test";
import {
  GOALS_LEDGER,
  GOALS_SCHEMA,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
  QUESTIONS_LEDGER,
  QUESTIONS_SCHEMA,
  TASKS_LEDGER,
  TASKS_SCHEMA,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
  resolveGenericMutationClosure,
  type GenericMutationArchivedTarget,
  type GenericMutationDataSource,
  type GenericMutationLedgerMetadata,
  type Item,
} from "../src/index.js";

function item(id: string, milestoneId: string, status: string, fields: Item["fields"]): Item {
  return {
    id,
    milestoneId,
    status,
    fields,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export const GENERIC_MUTATION_DATA_SOURCE_LEDGERS: readonly GenericMutationLedgerMetadata[] = [
  { id: MILESTONES_LEDGER, schema: MILESTONES_SCHEMA, counters: { milestone: 2, item: 0 } },
  { id: GOALS_LEDGER, schema: GOALS_SCHEMA, counters: { milestone: 0, item: 1 } },
  { id: TASKS_LEDGER, schema: TASKS_SCHEMA, counters: { milestone: 0, item: 9 } },
  { id: QUESTIONS_LEDGER, schema: QUESTIONS_SCHEMA, counters: { milestone: 0, item: 1 } },
];

const finalizedManifest = JSON.stringify({
  revision: 1,
  milestones: [{ key: "delivery", id: "M1" }],
  tasks: [
    { key: "entry", id: "T1" },
    { key: "dependency", id: "T2" },
  ],
});

export const GENERIC_MUTATION_DATA_SOURCE_ACTIVE_ITEMS: readonly {
  readonly ledgerId: string;
  readonly item: Item;
}[] = [
  {
    ledgerId: MILESTONES_LEDGER,
    item: item("M1", MILESTONES_ACTIVE_GROUP_ID, "open", { title: "delivery" }),
  },
  {
    ledgerId: MILESTONES_LEDGER,
    item: item("M2", MILESTONES_ACTIVE_GROUP_ID, "open", { title: "explicit" }),
  },
  {
    ledgerId: GOALS_LEDGER,
    item: item("G1", "M1", "building", {
      title: "root",
      description: "root",
      planFinalizedManifest: finalizedManifest,
    }),
  },
  {
    ledgerId: TASKS_LEDGER,
    item: item("T1", "M1", "planned", {
      headline: "entry",
      dependsOn: [`${TASKS_LEDGER}:T2`],
    }),
  },
  {
    ledgerId: TASKS_LEDGER,
    item: item("T2", "M1", "planned", {
      headline: "dependency",
      [WORKSET_OWNER_REF_FIELD]: `${GOALS_LEDGER}:G1`,
      [WORKSET_OWNER_EDGE_KIND_FIELD]: "finalized-manifest",
    }),
  },
  {
    ledgerId: QUESTIONS_LEDGER,
    item: item("Q1", "M1", "open", {
      question: "gate?",
      [WORKSET_OWNER_REF_FIELD]: `${GOALS_LEDGER}:G1`,
      [WORKSET_OWNER_EDGE_KIND_FIELD]: "exact-gate-question",
    }),
  },
  {
    ledgerId: TASKS_LEDGER,
    item: item("T3", "M2", "planned", { headline: "live explicit member" }),
  },
  {
    ledgerId: TASKS_LEDGER,
    item: item("T4", "M2", "done", { headline: "terminal explicit member" }),
  },
  {
    ledgerId: TASKS_LEDGER,
    item: item("T8", "M2", "planned", { headline: "unrelated" }),
  },
];

export const GENERIC_MUTATION_DATA_SOURCE_ARCHIVED_ITEMS: readonly GenericMutationArchivedTarget[] =
  [
    {
      ledgerId: TASKS_LEDGER,
      pointerId: "M9",
      item: item("T9", "M9", "done", { headline: "archived reference target" }),
    },
  ];

export interface GenericMutationDataSourceContractFixture {
  readonly source: GenericMutationDataSource;
  dispose(): void | Promise<void>;
}

export function runGenericMutationDataSourceContract(input: {
  readonly name: string;
  readonly classification: string;
  build():
    GenericMutationDataSourceContractFixture | Promise<GenericMutationDataSourceContractFixture>;
}): void {
  describe(`generic mutation data source — ${input.name} [${input.classification}]`, () => {
    test("resolves roots, prerequisites, phase members, owned children, and archived candidates", async () => {
      const fixture = await input.build();
      try {
        const resolved = resolveGenericMutationClosure(fixture.source, [`${GOALS_LEDGER}:G1`], {
          candidateRefs: [`${TASKS_LEDGER}:T9`],
          incidentReferenceFields: [],
        });
        expect(resolved.graph.nodes.map(({ ref }) => ref).sort()).toEqual([
          `${GOALS_LEDGER}:G1`,
          `${MILESTONES_LEDGER}:M1`,
          `${QUESTIONS_LEDGER}:Q1`,
          `${TASKS_LEDGER}:T1`,
          `${TASKS_LEDGER}:T2`,
        ]);
        expect(resolved.archivedTargets.get(`${TASKS_LEDGER}:T9`)?.item.id).toBe("T9");
        expect(resolved.activeState.byRef.has(`${TASKS_LEDGER}:T8`)).toBe(false);
      } finally {
        await fixture.dispose();
      }
    });

    test("expands only live tasks for an explicit milestone root", async () => {
      const fixture = await input.build();
      try {
        const resolved = resolveGenericMutationClosure(
          fixture.source,
          [`${MILESTONES_LEDGER}:M2`],
          { candidateRefs: [], incidentReferenceFields: [] },
        );
        expect(resolved.graph.nodes.map(({ ref }) => ref).sort()).toEqual([
          `${MILESTONES_LEDGER}:M2`,
          `${TASKS_LEDGER}:T3`,
          `${TASKS_LEDGER}:T8`,
        ]);
        expect(resolved.activeState.byRef.has(`${TASKS_LEDGER}:T4`)).toBe(false);
      } finally {
        await fixture.dispose();
      }
    });
  });
}
