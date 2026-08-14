/** T1982: direct ordinary mutations must enter through workset admission. */

import { describe, expect, it } from "bun:test";
import {
  InMemoryLedgerStore,
  WORKSET_GENERIC_MUTATION_RAW_WRITE_METHODS,
  WorksetGenericMutationError,
  createLedgerMcpTools,
  type LedgerStore,
} from "../src/index.js";
import {
  CUSTOM_LEDGER_SCHEMA,
  EXCLUDED_GENERIC_MUTATION_CASES,
  genericStoreBytes,
  seedExcludedGenericMutationStore,
} from "./worksetGenericMutationMcpSupport.js";

describe("workset-guarded generic mutation — direct MCP [Behavioral-Active Blackbox-Atomic]", () => {
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
