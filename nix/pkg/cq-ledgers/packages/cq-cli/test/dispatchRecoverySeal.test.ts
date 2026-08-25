import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  DISPATCH_RECOVERY_USAGE,
  parseDispatchRecoveryArgs,
  runDispatchRecoveryCommand,
  type DispatchRecoveryCommandDeps,
} from "../src/dispatchRecovery.js";
import { RECOVERY_TASK, recoverySeal } from "../../ledger/test/recoverySealTestSupport.js";

function recordingIo() {
  const outs: string[] = [];
  const errs: string[] = [];
  return {
    outs,
    errs,
    out: (line: string) => outs.push(line),
    err: (line: string) => errs.push(line),
  };
}

describe("cq dispatch-recovery seal", () => {
  test("parses one task-scoped repository command", () => {
    expect(
      parseDispatchRecoveryArgs(["seal", "--task-id", RECOVERY_TASK, "--cwd", "fixture"], {}),
    ).toEqual({ operation: "seal", taskId: RECOVERY_TASK, cwd: resolve("fixture") });
  });

  test("prints exactly the protected seal returned by the runtime", async () => {
    const io = recordingIo();
    const expected = recoverySeal();
    const calls: unknown[] = [];
    const deps: DispatchRecoveryCommandDeps = {
      seal: async (input) => {
        calls.push(input);
        return expected;
      },
      status: async () => {
        throw new Error("status must not run");
      },
    };

    expect(
      await runDispatchRecoveryCommand(
        ["seal", "--task-id", RECOVERY_TASK, "--cwd", "/repo"],
        io,
        deps,
      ),
    ).toEqual({ exitCode: 0 });
    expect(io.errs).toEqual([]);
    expect(io.outs).toEqual([JSON.stringify(expected)]);
    expect(calls).toEqual([{ cwd: "/repo", taskId: RECOVERY_TASK }]);
  });

  test("fails closed on malformed coordinates without invoking the runtime", async () => {
    const io = recordingIo();
    let invoked = false;
    const deps: DispatchRecoveryCommandDeps = {
      seal: async () => {
        invoked = true;
      },
      status: async () => {
        invoked = true;
      },
    };

    expect(await runDispatchRecoveryCommand(["seal", "--task-id", "2345"], io, deps)).toEqual({
      exitCode: 2,
    });
    expect(invoked).toBe(false);
    expect(io.outs).toEqual([]);
    expect(io.errs.join("\n")).toContain("canonical task id");
    expect(DISPATCH_RECOVERY_USAGE).toContain("<seal|status>");
  });
});
