import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { CurrentRecoveryStatusSchema } from "@cq/ledger";
import {
  runDispatchRecoveryCommand,
  type DispatchRecoveryCommandDeps,
} from "../src/dispatchRecovery.js";
import {
  RECOVERY_TASK,
  committedJournal,
  provisionalJournal,
} from "../../ledger/test/recoverySealTestSupport.js";

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

function statusDeps(status: unknown): DispatchRecoveryCommandDeps {
  return {
    seal: async () => {
      throw new Error("seal must not run");
    },
    status: async () => status,
  };
}

describe("cq dispatch-recovery status", () => {
  test("production status uses the lineage-validating project runtime", async () => {
    const source = await readFile(new URL("../src/dispatchRecovery.ts", import.meta.url), "utf8");
    expect(source).toContain("readCurrentDispatchRecoveryStatusForProject");
    expect(source).not.toContain("readCurrentDispatchRecoveryStatus({ repositoryRoot: cwd");
  });

  test("emits strict committed status as one JSON line", async () => {
    const io = recordingIo();
    const journal = committedJournal();
    const status = CurrentRecoveryStatusSchema.parse({
      kind: "cq-current-recovery-status",
      version: 1,
      taskId: RECOVERY_TASK,
      state: "committed",
      selectedSourceHandle: journal.seal.seed.selectedSourceHandle,
      lineageMaximumGeneration: journal.seal.seed.lineageMaximumGeneration,
      snapshotDigest: journal.snapshotDigest,
      liveTip: journal.seal.seed.liveTip,
      source: journal.seal.seed.source,
      sealReference: journal.seal.sealReference,
      sealDigest: journal.seal.sealDigest,
      seal: journal.seal,
    });

    expect(
      await runDispatchRecoveryCommand(
        ["status", "--task-id", RECOVERY_TASK, "--cwd", "/repo"],
        io,
        statusDeps(status),
      ),
    ).toEqual({ exitCode: 0 });
    expect(io.outs).toEqual([JSON.stringify(status)]);
    expect(io.errs).toEqual([]);
  });

  test("provisional status exposes no replay authority", async () => {
    const io = recordingIo();
    const journal = provisionalJournal();
    const status = CurrentRecoveryStatusSchema.parse({
      kind: "cq-current-recovery-status",
      version: 1,
      taskId: RECOVERY_TASK,
      state: "provisional",
      selectedSourceHandle: journal.seal.seed.selectedSourceHandle,
      lineageMaximumGeneration: journal.seal.seed.lineageMaximumGeneration,
      snapshotDigest: journal.snapshotDigest,
      liveTip: journal.seal.seed.liveTip,
      source: journal.seal.seed.source,
      updatedAt: journal.writtenAt,
    });

    expect(
      await runDispatchRecoveryCommand(
        ["status", "--task-id", RECOVERY_TASK],
        io,
        statusDeps(status),
      ),
    ).toEqual({ exitCode: 0 });
    const decoded = JSON.parse(io.outs[0]!) as Record<string, unknown>;
    expect(decoded["state"]).toBe("provisional");
    expect(decoded).not.toHaveProperty("sealReference");
  });

  test("runtime failures produce no misleading exit-0 output", async () => {
    const io = recordingIo();
    const deps: DispatchRecoveryCommandDeps = {
      ...statusDeps(null),
      status: async () => {
        throw new Error("malformed protected journal");
      },
    };

    expect(
      await runDispatchRecoveryCommand(["status", "--task-id", RECOVERY_TASK], io, deps),
    ).toEqual({ exitCode: 1 });
    expect(io.outs).toEqual([]);
    expect(io.errs).toEqual(["malformed protected journal"]);
  });
});
