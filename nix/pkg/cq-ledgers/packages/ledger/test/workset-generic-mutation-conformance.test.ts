import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TASKS_LEDGER,
  IDEAS_LEDGER,
  QUESTIONS_LEDGER,
  WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES,
  WORKSET_GENERIC_MUTATION_OPERATION_KINDS,
  WorksetGenericMutationError,
  classifyGenericItemUpdate,
  effectiveGenericMutationDelta,
  createInMemoryGenericMutationDataSource,
  createInMemoryWorksetStore,
  createWorksetGenericMutationGateway,
  createInMemoryWorksetManagementLedger,
  InMemoryLedgerStore,
} from "../src/index.js";
import type { AdmittedGenericMutation, AdmittedGenericMutationBinding } from "../src/worksetGenericMutation.js";
import { PostgresOperationQueries } from "../src/store/postgres/operationAccess.js";
import { resolvePostgresGenericRows } from "../src/store/postgres/genericRowOperation.js";
import {
  GENERIC_MUTATION_DATA_SOURCE_ACTIVE_ITEMS,
  GENERIC_MUTATION_DATA_SOURCE_ARCHIVED_ITEMS,
  GENERIC_MUTATION_DATA_SOURCE_LEDGERS,
  runGenericMutationDataSourceContract,
} from "./genericMutationDataSourceContract.js";

runGenericMutationDataSourceContract({
  name: "in-memory",
  classification: "Behavioral-Active Blackbox-Atomic",
  build: () => ({
    source: createInMemoryGenericMutationDataSource({
      ledgers: GENERIC_MUTATION_DATA_SOURCE_LEDGERS,
      activeItems: GENERIC_MUTATION_DATA_SOURCE_ACTIVE_ITEMS,
      archivedItems: GENERIC_MUTATION_DATA_SOURCE_ARCHIVED_ITEMS,
    }),
    dispose: () => {},
  }),
});

describe("T1988 generic mutation conformance [Behavioral-Active Blackbox-Atomic]", () => {
  test("classifies every ordinary operation exactly once", () => {
    expect(WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES.map(({ kind }) => kind)).toEqual([
      ...WORKSET_GENERIC_MUTATION_OPERATION_KINDS,
    ]);
    expect(
      new Set(WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES.map(({ method }) => method)).size,
    ).toBe(WORKSET_GENERIC_MUTATION_OPERATION_KINDS.length);
  });

  test("exports the same ledger/semantic classification enforced by the gateway", () => {
    const question = {
      id: "Q1",
      milestoneId: "M1",
      status: "open",
      fields: { question: "Ship?", context: "unchanged", answer: "draft" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      effectiveGenericMutationDelta(question, {
        status: "answered",
        fields: { question: "Ship?", context: "unchanged", answer: "final" },
      }),
    ).toEqual({ statusChanged: true, changedFields: ["answer"] });
    expect(
      classifyGenericItemUpdate(QUESTIONS_LEDGER, question, {
        status: "answered",
        fields: { question: "Ship?", context: "unchanged", answer: "final" },
      }),
    ).toBe("pure-question-answer");
    expect(
      classifyGenericItemUpdate(QUESTIONS_LEDGER, question, {
        fields: { answer: "final", context: "changed" },
      }),
    ).toBe("ordinary");
    expect(classifyGenericItemUpdate(IDEAS_LEDGER, question, { status: "answered" })).toBe(
      "idea-only",
    );
    expect(
      WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES.find(({ kind }) => kind === "update-item")
        ?.exemptions,
    ).toEqual(["idea-only", "pure-question-answer"]);
  });

  test("recovers only an exact inactive root and preserves its archived sibling", async () => {
    const ledger = createInMemoryWorksetManagementLedger();
    await ledger.init();
    try {
      const milestone = await ledger.mutations.createMilestone({ title: "inactive recovery" });
      const selected = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: { headline: "selected archived task" },
      });
      const sibling = await ledger.mutations.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: { headline: "sibling archived task" },
      });
      await ledger.mutations.updateItem(TASKS_LEDGER, selected.id, { status: "done" });
      await ledger.mutations.updateItem(TASKS_LEDGER, sibling.id, { status: "done" });
      await ledger.mutations.updateMilestone(milestone.id, { status: "done" });
      await ledger.mutations.archiveMilestone(milestone.id, "complete");

      await ledger.setRoots([`${TASKS_LEDGER}:${selected.id}`]);
      const before = await ledger.snapshotRoots();
      const restored = await ledger.mutations.unarchiveItem(
        TASKS_LEDGER,
        milestone.id,
        selected.id,
      );
      expect(restored.id).toBe(selected.id);
      await expect(
        ledger.mutations.unarchiveItem(TASKS_LEDGER, milestone.id, sibling.id),
      ).rejects.toBeInstanceOf(WorksetGenericMutationError);
      expect(await ledger.snapshotRoots()).toEqual(before);
      expect(ledger.fetchItem(TASKS_LEDGER, selected.id).id).toBe(selected.id);
      expect(() => ledger.fetchItem(TASKS_LEDGER, sibling.id)).toThrow();
      expect(ledger.activeAdmissionCount()).toBe(0);
    } finally {
      await ledger.dispose();
    }
  });
});

describe("T6569 PostgreSQL semantic admission binding [Contract-Active Whitebox-Group]", () => {
  test("D442 keeps semantic admission targets separate from the exact PostgreSQL row scope", async () => {
    const rawStore = new InMemoryLedgerStore();
    const worksetStore = createInMemoryWorksetStore();
    const foreignWorksetStore = createInMemoryWorksetStore();
    await rawStore.init();
    const foreignAdmission = await foreignWorksetStore.admitLedgerMutation({
      kind: "generic-write",
      targets: [],
    });
    const fakeSql = (context: AdmittedGenericMutation): SQL =>
      ({
        array: (values: readonly string[]) => values,
        unsafe: async (statement: string) => {
          if (statement.includes("FROM workset_admissions")) {
            return [
              {
                form: "ledger-mutation",
                kind: context.admission.kind,
                epoch: context.admission.epoch,
                targets_json: JSON.stringify(context.admission.targets),
              },
            ];
          }
          if (statement.includes("FROM workset_roots")) {
            return [
              {
                epoch: context.admission.epoch,
                roots_json: JSON.stringify(context.admission.roots),
              },
            ];
          }
          return [];
        },
      }) as unknown as SQL;
    const gateway = createWorksetGenericMutationGateway({
      rawStore,
      worksetStore,
      runGenericTransaction: async (_mutate, _measurement, _scope, context, binding) => {
        expect(context).toBeDefined();
        const admitted = context as AdmittedGenericMutation;
        expect(admitted.admission.targets).toEqual([]);
        expect(admitted.scope.targetRefs).toEqual([`${IDEAS_LEDGER}:I1`]);
        const queries = new PostgresOperationQueries(
          fakeSql(admitted),
          "t6569-binding",
          admitted.scope.operation,
          null,
          () => 0,
          null,
        );
        const resolution = await resolvePostgresGenericRows(queries, admitted, binding);
        if (resolution.plan.kind === "rejected") throw resolution.plan.error;

        const expectCallerMintedRejection = async (
          candidate: AdmittedGenericMutation,
          candidateBinding: AdmittedGenericMutationBinding = binding,
        ): Promise<void> => {
          const candidateQueries = new PostgresOperationQueries(
            fakeSql(candidate),
            "t6569-binding",
            candidate.scope.operation,
            null,
            () => 0,
            null,
          );
          const rejected = await resolvePostgresGenericRows(
            candidateQueries,
            candidate,
            candidateBinding,
          );
          expect(rejected.plan).toMatchObject({
            kind: "rejected",
            error: { code: "caller-minted-admission" },
          });
        };
        const clonedScope = {
          ...admitted,
          scope: { ...admitted.scope, targetRefs: [`${TASKS_LEDGER}:T9999`] },
        };
        await expectCallerMintedRejection(clonedScope);
        const prototypeLookalike = Object.assign(
          Object.create(Object.getPrototypeOf(binding)) as object,
          { owns: () => true },
        ) as unknown as AdmittedGenericMutationBinding;
        await expectCallerMintedRejection(clonedScope, prototypeLookalike);
        const CapturedBindingToken = Object.getPrototypeOf(binding).constructor as new (
          owns: (value: unknown) => value is AdmittedGenericMutation,
        ) => AdmittedGenericMutationBinding;
        expect(
          () => new CapturedBindingToken((_value): _value is AdmittedGenericMutation => true),
        ).toThrow("generic mutation binding constructor is private");
        await expectCallerMintedRejection({
          ...admitted,
          admission: foreignAdmission,
        });
        return {
          id: "I1",
          milestoneId: "M-AMBIENT",
          status: "raw",
          fields: { title: "updated" },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        } as never;
      },
    });

    try {
      const updated = await gateway.updateItem(IDEAS_LEDGER, "I1", {
        fields: { title: "updated" },
      });
      expect(updated).toMatchObject({ id: "I1" });
    } finally {
      await foreignAdmission.acknowledge();
      await rawStore.dispose();
    }
  });

  test("D442 rejects a still-live descriptor owned by a different gateway instance", async () => {
    const rawStore = new InMemoryLedgerStore();
    const worksetStore = createInMemoryWorksetStore();
    await rawStore.init();
    let outerContext: AdmittedGenericMutation | undefined;

    const fakeSql = (context: AdmittedGenericMutation): SQL =>
      ({
        array: (values: readonly string[]) => values,
        unsafe: async (statement: string) => {
          if (statement.includes("FROM workset_admissions")) {
            return [{
              form: "ledger-mutation", kind: context.admission.kind, epoch: context.admission.epoch,
              targets_json: JSON.stringify(context.admission.targets),
            }];
          }
          if (statement.includes("FROM workset_roots")) {
            return [{ epoch: context.admission.epoch, roots_json: JSON.stringify(context.admission.roots) }];
          }
          return [];
        },
      }) as unknown as SQL;

    const innerGateway = createWorksetGenericMutationGateway({
      rawStore,
      worksetStore,
      runGenericTransaction: async (_mutate, _measurement, _scope, _context, binding: AdmittedGenericMutationBinding) => {
        expect(outerContext).toBeDefined();
        const foreign = outerContext as AdmittedGenericMutation;
        const queries = new PostgresOperationQueries(
          fakeSql(foreign), "t6569-foreign-binding", foreign.scope.operation, null, () => 0, null,
        );
        const rejected = await resolvePostgresGenericRows(queries, foreign, binding);
        expect(rejected.plan).toMatchObject({
          kind: "rejected",
          error: { code: "caller-minted-admission" },
        });
        return {
          id: "I1", milestoneId: "M-AMBIENT", status: "raw", fields: { title: "inner" },
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        } as never;
      },
    });
    const outerGateway = createWorksetGenericMutationGateway({
      rawStore,
      worksetStore,
      runGenericTransaction: async (_mutate, _measurement, _scope, context) => {
        outerContext = context;
        await innerGateway.updateItem(IDEAS_LEDGER, "I1", { fields: { title: "inner" } });
        return {
          id: "I1", milestoneId: "M-AMBIENT", status: "raw", fields: { title: "outer" },
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        } as never;
      },
    });

    try {
      await outerGateway.updateItem(IDEAS_LEDGER, "I1", { fields: { title: "outer" } });
    } finally {
      await rawStore.dispose();
    }
  });
});

describe("T1988 durable generic shared-contract registration [Contract-Active Whitebox-Atomic]", () => {
  test("keeps the unchanged shared runner registered for every durable backend", async () => {
    for (const backend of ["sqlite", "postgres"] as const) {
      const source = await readFile(
        join(import.meta.dir, `workset-generic-mutation-${backend}.test.ts`),
        "utf8",
      );
      expect(source, backend).toContain("runWorksetGenericMutationContract");
    }
  });
});
