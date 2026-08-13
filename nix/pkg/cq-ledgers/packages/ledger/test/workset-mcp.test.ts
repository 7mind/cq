/** T1980 shared workset MCP contract. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { validateAgainstSchema } from "@cq/config";
import {
  createLedgerMcpTools,
  createManagementLedgerMcpTools,
  InMemoryLedgerStore,
  ledgerToolInputJsonSchema,
  SqliteLedgerStore,
  TASKS_LEDGER,
  type LedgerStore,
  type LedgerToolSpecification,
  type WorksetResult,
} from "../src/index.js";

type Tools = ReturnType<typeof createLedgerMcpTools>;
type WorksetGetResult = Extract<WorksetResult, { readonly op: "get" }>;
type WorksetFetchResult = Extract<WorksetResult, { readonly op: "fetch" }>;
const resultCorrelation: [WorksetGetResult["op"], WorksetFetchResult["op"]] = ["get", "fetch"];

function worksetTool(tools: Tools) {
  const found = tools.find((candidate) => candidate.name === "workset");
  if (found === undefined) throw new Error("workset tool not found");
  return found;
}

async function invoke(tools: Tools, args: Record<string, unknown>): Promise<WorksetResult> {
  const target = worksetTool(tools);
  const parsed = z.object(target.inputSchema as Record<string, z.ZodType>).parse(args);
  const result = (await target.handler(parsed as never, null)) as {
    content: Array<{ type: string; text?: string }>;
  };
  return JSON.parse(result.content[0]?.text ?? "") as WorksetResult;
}

async function seed(store: LedgerStore): Promise<void> {
  await store.createMilestone({ id: "M9001", title: "Workset fixture" });
  await store.createItem(TASKS_LEDGER, "M9001", {
    id: "T9001",
    status: "planned",
    fields: { headline: "Compact headline", description: "Complement narrative" },
  });
}

interface Fixture {
  readonly store: LedgerStore;
  close(): Promise<void>;
}

interface Factory {
  readonly name: string;
  readonly classification: string;
  build(): Promise<Fixture>;
}

function runContract(factory: Factory): void {
  describe(`${factory.name} [${factory.classification}]`, () => {
    it("shares one exact get/fetch/set DTO and increments identical/empty sets", async () => {
      const fixture = await factory.build();
      try {
        await seed(fixture.store);
        const management = createManagementLedgerMcpTools(fixture.store);
        expect(await invoke(management, { op: "set", roots: [] })).toEqual({
          op: "set",
          acknowledgement: { roots: [], epoch: 1 },
        });
        expect(await invoke(management, { op: "set", roots: [] })).toEqual({
          op: "set",
          acknowledgement: { roots: [], epoch: 2 },
        });
        expect(
          await invoke(management, {
            op: "set",
            roots: ["T9001", "tasks:T9001", "T9001"],
          }),
        ).toEqual({
          op: "set",
          acknowledgement: { roots: ["tasks:T9001"], epoch: 3 },
        });

        const get = await invoke(management, { op: "get", projection: "id" });
        expect(get).toEqual({
          op: "get",
          graph: {
            roots: ["tasks:T9001"],
            inactiveRoots: [],
            nodes: [{ ref: "tasks:T9001" }],
            edges: [],
            restrictive: true,
            projection: "id",
          },
        });
        const fetch = await invoke(management, {
          op: "fetch",
          roots: ["T9001"],
          projection: "complement",
        });
        expect(fetch.op).toBe("fetch");
        if (fetch.op !== "fetch") throw new Error("expected fetch result");
        expect(fetch.graph.nodes).toEqual([
          {
            ref: "tasks:T9001",
            item: { id: "T9001", fields: { description: "Complement narrative" } },
          },
        ]);
        expect(await fixture.store.worksetStore?.().snapshot()).toEqual({
          roots: ["tasks:T9001"],
          epoch: 3,
        });
      } finally {
        await fixture.close();
      }
    });

    it("rejects an invalid replacement atomically", async () => {
      const fixture = await factory.build();
      try {
        await seed(fixture.store);
        const management = createManagementLedgerMcpTools(fixture.store);
        await invoke(management, { op: "set", roots: ["T9001"] });
        const before = await fixture.store.worksetStore?.().snapshot();
        await expect(invoke(management, { op: "set", roots: ["tasks:T-missing"] }))
          .rejects.toThrow(/inactive/);
        expect(await fixture.store.worksetStore?.().snapshot()).toEqual(before);
      } finally {
        await fixture.close();
      }
    });
  });
}

runContract({
  name: "in-memory dummy",
  classification: "Behavioral-Active Blackbox-Atomic",
  async build() {
    const store = new InMemoryLedgerStore();
    await store.init();
    return { store, close: async () => store.dispose() };
  },
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

runContract({
  name: "SQLite primary",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  async build() {
    const dir = await mkdtemp(path.join(tmpdir(), "workset-mcp-"));
    dirs.push(dir);
    const store = new SqliteLedgerStore({ dbPath: path.join(dir, "ledger.db") });
    await store.init();
    return { store, close: async () => store.dispose() };
  },
});

describe("workset MCP authority-shaped schema", () => {
  it("keeps get/fetch result discriminants type-correlated", () => {
    expect(resultCorrelation).toEqual(["get", "fetch"]);
  });

  it("advertises get/fetch to ordinary sessions and adds set only for management", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    try {
      const ordinary = worksetTool(createLedgerMcpTools(store));
      const management = worksetTool(createManagementLedgerMcpTools(store));
      const ordinarySchema = z.object(ordinary.inputSchema as Record<string, z.ZodType>);
      const managementSchema = z.object(management.inputSchema as Record<string, z.ZodType>);

      expect(ordinarySchema.safeParse({ op: "get", projection: "id" }).success).toBe(true);
      expect(ordinarySchema.safeParse({ op: "fetch", roots: [], projection: "compact" }).success)
        .toBe(true);
      expect(ordinarySchema.safeParse({ op: "set", roots: [] }).success).toBe(false);
      expect(managementSchema.safeParse({ op: "set", roots: [] }).success).toBe(true);
    } finally {
      await store.dispose();
    }
  });

  it("publishes three exact conditional JSON Schema arms", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    try {
      const schemaFor = (tools: Tools) =>
        ledgerToolInputJsonSchema(worksetTool(tools) as LedgerToolSpecification) as Parameters<
          typeof validateAgainstSchema
        >[0];
      const ordinary = schemaFor(createLedgerMcpTools(store));
      const management = schemaFor(createManagementLedgerMcpTools(store));
      const accepts = (schema: typeof ordinary, value: unknown) =>
        validateAgainstSchema(schema, value).ok;

      expect(accepts(ordinary, { op: "get", projection: "id" })).toBe(true);
      expect(accepts(ordinary, { op: "fetch", roots: [], projection: "compact" })).toBe(true);
      expect(accepts(ordinary, { op: "get" })).toBe(false);
      expect(accepts(ordinary, { op: "get", roots: [], projection: "id" })).toBe(false);
      expect(accepts(ordinary, { op: "fetch", projection: "full" })).toBe(false);
      expect(accepts(ordinary, { op: "fetch", roots: [] })).toBe(false);
      expect(accepts(ordinary, { op: "set", roots: [] })).toBe(false);

      expect(accepts(management, { op: "get", projection: "complement" })).toBe(true);
      expect(accepts(management, { op: "fetch", roots: [], projection: "full" })).toBe(true);
      expect(accepts(management, { op: "set", roots: [] })).toBe(true);
      expect(accepts(management, { op: "get", roots: [], projection: "id" })).toBe(false);
      expect(accepts(management, { op: "fetch", roots: [] })).toBe(false);
      expect(accepts(management, { op: "set" })).toBe(false);
      expect(accepts(management, { op: "set", roots: [], projection: "id" })).toBe(false);
    } finally {
      await store.dispose();
    }
  });

  it("refuses a forged set before consulting the workset store", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    let worksetReads = 0;
    const original = store.worksetStore.bind(store);
    store.worksetStore = () => {
      worksetReads += 1;
      return original();
    };
    try {
      const forged = {
        get: <T>(operation: () => T) => operation(),
        fetch: async <T>(operation: () => T | Promise<T>) => await operation(),
        set: async <T>(operation: () => T | Promise<T>) => await operation(),
      };
      expect(() =>
        createLedgerMcpTools(
          store,
          undefined,
          undefined,
          undefined,
          "",
          undefined,
          undefined,
          "full",
          undefined,
          forged,
        ),
      ).toThrow(/runtime-issued authority/);
      expect(worksetReads).toBe(0);
    } finally {
      await store.dispose();
    }
  });
});
