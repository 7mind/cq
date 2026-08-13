import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  WorksetInvocationAuthorityError,
  WorksetAdmissionError,
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

  test("ordinary store construction denies reset without changing persisted items", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workset-authority-reset-"));
    const store = new FsLedgerStore({ root });
    await store.init();
    try {
      const milestone = await store.createMilestone({ title: "reset denial" });
      const task = await store.createItem("tasks", milestone.id, {
        status: "planned",
        fields: { headline: "must survive denied reset" },
      });

      await expect(store.reset()).rejects.toMatchObject({
        code: "management-authority-required",
      } satisfies Partial<WorksetAdmissionError>);
      expect(store.fetchItem("tasks", task.id).fields["headline"]).toBe(
        "must survive denied reset",
      );
    } finally {
      await store.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
