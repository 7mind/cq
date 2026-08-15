/** T1982: direct ordinary mutations must enter through workset admission. */

import { describe, expect, it } from "bun:test";
import {
  GOALS_LEDGER,
  IDEAS_LEDGER,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  REVIEWS_LEDGER,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
  WORKSET_GENERIC_MUTATION_RAW_WRITE_METHODS,
  WorksetGenericMutationError,
  createLedgerMcpToolSpecifications,
  createLedgerMcpTools,
  ledgerToolInputJsonSchema,
  type LedgerStore,
} from "../src/index.js";
import {
  CUSTOM_LEDGER_SCHEMA,
  EXCLUDED_GENERIC_MUTATION_CASES,
  genericStoreBytes,
  seedExcludedGenericMutationStore,
} from "./worksetGenericMutationMcpSupport.js";

describe("workset-guarded generic mutation — direct MCP [Behavioral-Active Blackbox-Atomic]", () => {
  it("routes an explicit owner-scoped create through the guarded lifecycle", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const milestone = await store.createMilestone({ title: "Plan G1" });
    await store.createItem(GOALS_LEDGER, milestone.id, {
      id: "G1",
      status: "planning",
      fields: { title: "Selected goal", description: "Exercise owner-scoped creation." },
    });
    await store.worksetStore().setRoots(["goals:G1"]);
    const tool = createLedgerMcpTools(store).find(({ name }) => name === "create_item");
    if (tool === undefined) throw new Error("create_item tool not found");

    try {
      const result = await tool.handler(
        {
          ledger_id: REVIEWS_LEDGER,
          milestone_id: milestone.id,
          status: "revise",
          fields: {
            summary: "Revise the plan",
            planDraft: "draft-1",
            new_questions: [],
            criticism: ["Add the missing guard"],
            defects: [],
            ledgerRefs: ["goals:G1"],
          },
          owner_ref: "goals:G1",
          creation_kind: "review",
        } as never,
        null,
      );
      expect(result.isError).not.toBe(true);
      const review = store.fetch(REVIEWS_LEDGER).milestones.flatMap(({ items }) => items)[0];
      expect(review?.fields[WORKSET_OWNER_REF_FIELD]).toBe("goals:G1");
      expect(review?.fields[WORKSET_OWNER_EDGE_KIND_FIELD]).toBe("review");
      expect(store.worksetStore().activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });

  it("routes idea-to-goal through the atomic owner bundle", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    await store.createItem(IDEAS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "I1",
      status: "open",
      fields: { title: "Owned idea", description: "Create its selected goal." },
    });
    await store.worksetStore().setRoots(["ideas:I1"]);
    const tool = createLedgerMcpTools(store).find(({ name }) => name === "create_item");
    if (tool === undefined) throw new Error("create_item tool not found");

    try {
      const result = await tool.handler(
        {
          ledger_id: GOALS_LEDGER,
          status: "clarifying",
          fields: {
            title: "Owned goal",
            description: "Created atomically from I1.",
            sourceRefs: ["ideas:I1"],
          },
          owner_ref: "ideas:I1",
          creation_kind: "idea-to-goal",
        } as never,
        null,
      );
      expect(result.isError).not.toBe(true);
      const goal = store.fetch(GOALS_LEDGER).milestones.flatMap(({ items }) => items)[0];
      expect(goal?.fields[WORKSET_OWNER_REF_FIELD]).toBe("ideas:I1");
      expect(goal?.fields[WORKSET_OWNER_EDGE_KIND_FIELD]).toBe("idea-to-goal");
      expect(store.fetchItem(IDEAS_LEDGER, "I1").status).toBe("planned");
      expect(store.worksetStore().activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });

  it("advertises only create_item lifecycle kinds that this tool can execute", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    try {
      const specification = createLedgerMcpToolSpecifications(store).find(
        ({ name }) => name === "create_item",
      );
      if (specification === undefined) throw new Error("create_item tool not found");
      const schema = ledgerToolInputJsonSchema(specification) as {
        properties: { creation_kind: { enum: string[] } };
      };
      expect(schema.properties.creation_kind.enum).toEqual([
        "idea-to-goal",
        "exact-gate-question",
        "review",
        "review-filed-defect",
        "implementation-defect",
        "research",
        "hypothesis",
        "decision",
        "fix-goal",
        "handoff",
      ]);
    } finally {
      await store.dispose();
    }
  });

  it("rejects an explicit id that an atomic coordination bundle cannot preserve", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    await store.createItem(IDEAS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "I1",
      status: "open",
      fields: { title: "Owned idea", description: "Reject a discarded explicit id." },
    });
    await store.worksetStore().setRoots(["ideas:I1"]);
    const tool = createLedgerMcpTools(store).find(({ name }) => name === "create_item");
    if (tool === undefined) throw new Error("create_item tool not found");

    try {
      await expect(
        tool.handler(
          {
            ledger_id: GOALS_LEDGER,
            status: "clarifying",
            id: "G99",
            fields: { title: "Owned goal", description: "Must not ignore G99." },
            owner_ref: "ideas:I1",
            creation_kind: "idea-to-goal",
          } as never,
          null,
        ),
      ).rejects.toThrow("does not accept an explicit id");
      expect(store.fetch(GOALS_LEDGER).milestones.flatMap(({ items }) => items)).toEqual([]);
      expect(store.fetchItem(IDEAS_LEDGER, "I1").status).toBe("open");
      expect(store.worksetStore().activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });

  it("rejects partial or non-canonical owner routing before mutation", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const milestone = await store.createMilestone({ title: "Owner validation" });
    const tool = createLedgerMcpTools(store).find(({ name }) => name === "create_item");
    if (tool === undefined) throw new Error("create_item tool not found");
    const base = {
      ledger_id: REVIEWS_LEDGER,
      milestone_id: milestone.id,
      status: "revise",
      fields: {
        summary: "Invalid owner input",
        planDraft: "draft-1",
        new_questions: [],
        criticism: ["Reject before create"],
        defects: [],
      },
    };

    try {
      await expect(
        tool.handler({ ...base, owner_ref: "goals:G1" } as never, null),
      ).rejects.toThrow("owner_ref and creation_kind must be supplied together");
      await expect(
        tool.handler(
          { ...base, owner_ref: "G1", creation_kind: "review" } as never,
          null,
        ),
      ).rejects.toThrow("must use canonical <ledger>:<id> form");
      expect(store.fetch(REVIEWS_LEDGER).milestones.flatMap(({ items }) => items)).toEqual([]);
      expect(store.worksetStore().activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });

  it("rejects every excluded ordinary mutation before changing the store", async () => {
    const store = await seedExcludedGenericMutationStore();
    try {
      const tools = createLedgerMcpTools(store);
      const before = genericStoreBytes(store);
      for (const { tool: toolName, input, code } of EXCLUDED_GENERIC_MUTATION_CASES) {
        const tool = tools.find(({ name }) => name === toolName);
        if (tool === undefined) throw new Error(`${toolName} tool not found`);
        try {
          await tool.handler(input as never, null);
          throw new Error(`${toolName} unexpectedly resolved`);
        } catch (error) {
          expect(error, toolName).toBeInstanceOf(WorksetGenericMutationError);
          expect((error as WorksetGenericMutationError).code, toolName).toBe(code);
        }
        expect(genericStoreBytes(store), toolName).toBe(before);
        expect(store.worksetStore().activeAdmissionCount(), toolName).toBe(0);
      }
    } finally {
      await store.dispose();
    }
  });

  it("rejects caller-supplied workset context before an allowed mutation", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const tool = createLedgerMcpTools(store).find(({ name }) => name === "create_ledger");
    if (tool === undefined) throw new Error("create_ledger tool not found");
    try {
      await expect(
        tool.handler(
          {
            name: "forgedContextLedger",
            schema: CUSTOM_LEDGER_SCHEMA,
            worksetContext: {
              admissionId: "caller-forged-admission",
              epoch: 0,
            },
          } as never,
          null,
        ),
      ).rejects.toThrow();
      expect(store.enumerate()).not.toContain("forgedContextLedger");
      expect(store.worksetStore().activeAdmissionCount()).toBe(0);
    } finally {
      await store.dispose();
    }
  });

  it("the ordinary-tool inventory has no fallback to raw mutation methods", async () => {
    const store = await seedExcludedGenericMutationStore();
    const rawCalls: string[] = [];
    const rawMethods = new Set<string>(WORKSET_GENERIC_MUTATION_RAW_WRITE_METHODS);
    const withoutGuardedCapability = new Proxy(store, {
      get(target, property, receiver): unknown {
        if (property === "runAtomicGenericMutation") return undefined;
        if (typeof property === "string" && rawMethods.has(property)) {
          return (): never => {
            rawCalls.push(property);
            throw new Error(`raw mutation method ${property} reached`);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as LedgerStore;
    try {
      const tools = createLedgerMcpTools(withoutGuardedCapability);
      for (const { tool: toolName, input } of EXCLUDED_GENERIC_MUTATION_CASES) {
        const tool = tools.find(({ name }) => name === toolName);
        if (tool === undefined) throw new Error(`${toolName} tool not found`);
        await expect(tool.handler(input as never, null)).rejects.toThrow(
          /requires a workset-guarded generic mutation capability/,
        );
      }
      expect(rawCalls).toEqual([]);
    } finally {
      await store.dispose();
    }
  });
});
