import { describe, expect, test } from "bun:test";
import {
  WorksetInvocationAuthorityError,
  createInMemoryWorksetGuardedLedger,
  createInMemoryWorksetManagementLedger,
  createLedgerMcpTools,
  createManagementLedgerMcpTools,
  InMemoryLedgerStore,
  invokeWorksetSet,
} from "../src/index.js";

describe("direct workset management authority", () => {
  test("the ordinary direct constructor remains observe-only", async () => {
    const ordinary = createInMemoryWorksetGuardedLedger();

    expect(await ordinary.snapshotRoots()).toEqual({ roots: [], epoch: 0 });
    await expect(ordinary.setRoots(["goals:G1"])).rejects.toBeInstanceOf(
      WorksetInvocationAuthorityError,
    );
    expect(await ordinary.snapshotRoots()).toEqual({ roots: [], epoch: 0 });
  });

  test("the dedicated trusted direct constructor may set roots", async () => {
    const management = createInMemoryWorksetManagementLedger();

    expect(await management.setRoots(["goals:G1"])).toEqual({
      roots: ["goals:G1"],
      epoch: 1,
    });
  });

  test("ordinary direct MCP tools cannot elevate and carry no authority schema field", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    const ordinary = createLedgerMcpTools(store);
    const management = createManagementLedgerMcpTools(store);
    let setCalls = 0;

    await expect(
      invokeWorksetSet(ordinary, () => {
        setCalls += 1;
      }),
    ).rejects.toBeInstanceOf(WorksetInvocationAuthorityError);
    await invokeWorksetSet(management, () => {
      setCalls += 1;
    });
    expect(setCalls).toBe(1);
    expect(JSON.stringify(ordinary.map((tool) => tool.inputSchema))).not.toContain(
      "authority",
    );
    await store.dispose();
  });
});
