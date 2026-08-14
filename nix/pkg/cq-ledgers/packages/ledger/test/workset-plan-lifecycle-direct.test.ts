/** T1981: direct MCP plan lifecycle must enter through workset admission. */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  GOALS_LEDGER,
  PlanLifecycleNotImplementedError,
  createLedgerMcpTools,
  type LedgerStore,
} from "../src/index.js";
import {
  EXCLUDED_PLAN_CASES,
  excludedPlanResult,
  seedExcludedPlanStore,
} from "./worksetPlanLifecycleMcpSupport.js";

describe("workset-guarded plan lifecycle — direct MCP [Behavioral-Active Blackbox-Atomic]", () => {
  it("rejects all four excluded operations before changing the goal", async () => {
    const store = await seedExcludedPlanStore();

    try {
      const tools = createLedgerMcpTools(store);
      for (const { tool: toolName, operation, input } of EXCLUDED_PLAN_CASES) {
        const tool = tools.find(({ name }) => name === toolName);
        if (tool === undefined) throw new Error(`${toolName} tool not found`);
        const parsed = z
          .object(tool.inputSchema as Record<string, z.ZodType>)
          .parse(input);
        const result = await tool.handler(parsed as never, null);
        const text = result.content[0]?.type === "text" ? result.content[0].text : undefined;
        if (text === undefined) throw new Error(`${toolName} returned no text payload`);

        expect(JSON.parse(text), toolName).toEqual(excludedPlanResult(operation));
        expect(store.fetchItem(GOALS_LEDGER, "G1").status).toBe("clarifying");
      }
    } finally {
      await store.dispose();
    }
  });

  it("rejects caller-supplied workset context before admission or mutation", async () => {
    const store = await seedExcludedPlanStore();
    try {
      const tools = createLedgerMcpTools(store);
      for (const { tool: toolName, input } of EXCLUDED_PLAN_CASES) {
        const tool = tools.find(({ name }) => name === toolName);
        if (tool === undefined) throw new Error(`${toolName} tool not found`);
        await expect(
          tool.handler(
            {
              ...input,
              worksetContext: {
                admissionId: "caller-forged-admission",
                epoch: 1,
              },
            } as never,
            null,
          ),
        ).rejects.toThrow();
        expect(store.worksetStore().activeAdmissionCount()).toBe(0);
        expect(store.fetchItem(GOALS_LEDGER, "G1").status).toBe("clarifying");
      }
    } finally {
      await store.dispose();
    }
  });

  it("the four-tool inventory has no fallback to raw lifecycle methods", async () => {
    const store = await seedExcludedPlanStore();
    const rawCalls: string[] = [];
    const rawMethods = new Set([
      "claimPlan",
      "publishPlanDraft",
      "releasePlanClaim",
      "finalizePlan",
    ]);
    const withoutGuardedCapability = new Proxy(store, {
      get(target, property, receiver): unknown {
        if (
          property === "runAtomicOwnedMutation" ||
          property === "runAtomicWorksetPlanLifecycleMutation"
        ) {
          return undefined;
        }
        if (typeof property === "string" && rawMethods.has(property)) {
          return (): never => {
            rawCalls.push(property);
            throw new Error(`raw lifecycle method ${property} reached`);
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
      for (const { tool: toolName, input } of EXCLUDED_PLAN_CASES) {
        const tool = tools.find(({ name }) => name === toolName);
        if (tool === undefined) throw new Error(`${toolName} tool not found`);
        await expect(tool.handler(input as never, null)).rejects.toBeInstanceOf(
          PlanLifecycleNotImplementedError,
        );
      }
      expect(rawCalls).toEqual([]);
    } finally {
      await store.dispose();
    }
  });
});
