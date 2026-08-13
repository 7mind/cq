import { describe, expect, test } from "bun:test";
import {
  WorksetInvocationAuthorityError,
  createInMemoryWorksetGuardedLedger,
  createInMemoryWorksetManagementLedger,
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
});
