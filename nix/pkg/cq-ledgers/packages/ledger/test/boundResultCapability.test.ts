/**
 * G224: a child-owned ledger server binds the dispatch's result capability
 * from its environment, so a print-bridge child stores its result without
 * the capability ever appearing in its prompt.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  InMemoryLedgerStore,
  createLedgerMcpTools,
  type DispatchCapability,
  type StoreResultToolInput,
} from "../src/index.js";

const BOUND = { scope: "store-result", token: `cq_result_${"b".repeat(43)}` } as const;
const OTHER = { scope: "store-result", token: `cq_result_${"c".repeat(43)}` } as const;

async function storeResultTool(boundResultCapability: typeof BOUND | undefined) {
  const store = new InMemoryLedgerStore();
  await store.init();
  const stored: StoreResultToolInput[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("unexpected dispatch operation");
  };
  const dispatchCapability: DispatchCapability = {
    prepare: unused,
    fetchInput: unused,
    storeResult: async (input) => {
      stored.push(input);
      return { state: "stored" } as never;
    },
    confirmCompletion: unused,
    abort: unused,
    fetch: unused,
    gitCommit: unused,
    gitResolveContinue: unused,
    ...(boundResultCapability === undefined ? {} : { boundResultCapability }),
  };
  const tool = createLedgerMcpTools(store, undefined, undefined, undefined, "", undefined, dispatchCapability)
    .find((candidate) => candidate.name === "store_result");
  if (tool === undefined) throw new Error("store_result is not exposed");
  return {
    stored,
    schema: z.object(tool.inputSchema),
    call: (args: Record<string, unknown>) => tool.handler(args as never, null),
  };
}

describe("store_result with an environment-bound result capability", () => {
  it("the tool schema accepts a call that omits resultCapability", async () => {
    const { schema } = await storeResultTool(BOUND);
    expect(schema.safeParse({ output: { status: "pass" } }).success).toBe(true);
  });

  it("a bound server stores with its bound capability when the child omits one", async () => {
    const { stored, call } = await storeResultTool(BOUND);
    await call({ output: { status: "pass" } });
    expect(stored).toEqual([{ resultCapability: BOUND, output: { status: "pass" } }]);
  });

  it("a bound server accepts the identical capability passed explicitly", async () => {
    const { stored, call } = await storeResultTool(BOUND);
    await call({ resultCapability: BOUND, output: { status: "pass" } });
    expect(stored).toEqual([{ resultCapability: BOUND, output: { status: "pass" } }]);
  });

  it("a bound server refuses a different capability and stores nothing", async () => {
    const { stored, call } = await storeResultTool(BOUND);
    await expect(call({ resultCapability: OTHER, output: { status: "pass" } })).rejects.toThrow(
      /bound result capability/,
    );
    expect(stored).toEqual([]);
  });

  it("an unbound server refuses a call that omits resultCapability and stores nothing", async () => {
    const { stored, call } = await storeResultTool(undefined);
    await expect(call({ output: { status: "pass" } })).rejects.toThrow(/requires resultCapability/);
    expect(stored).toEqual([]);
  });

  it("an unbound server passes an explicit capability through unchanged", async () => {
    const { stored, call } = await storeResultTool(undefined);
    await call({ resultCapability: OTHER, output: { status: "pass" } });
    expect(stored).toEqual([{ resultCapability: OTHER, output: { status: "pass" } }]);
  });
});
