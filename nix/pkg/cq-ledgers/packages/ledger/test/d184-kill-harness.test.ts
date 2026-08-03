/**
 * D184 regression: encode the observed T722 total-loss result with a kill point
 * that cannot drift past the worker's terminal write.
 */

import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import {
  KILL_BLOCKING_MECHANISM,
  createConflictedRebaseFixture,
  createKillHarness,
} from "@cq/ledger/testing";

describe("D184 deterministic kill harness [Effectual-GoodCommunication]", () => {
  test("CONTROL loses all expensive work before the terminal write", async () => {
    const harness = await createKillHarness("control");
    try {
      expect(harness.blockingMechanism).toBe(
        "wait on a release sentinel that the parent never creates",
      );
      expect(await readFile(harness.expensiveWorkSentinel, "utf8")).not.toBe("");

      const termination = await harness.terminateAtBlock();
      expect(termination.blockingMechanism).toBe(KILL_BLOCKING_MECHANISM);
      expect(termination.checkpoint).toBe("terminal-write-blocked");
      expect(termination.aliveBeforeSigterm).toBe(true);
      expect(termination.releaseSentinelPresentBeforeSigterm).toBe(false);
      expect(termination.blockedBeforeSigterm).toBe(true);
      expect(termination.signalSent).toBe("SIGTERM");
      expect(termination.exitSignal).toBe("SIGTERM");
      expect(await Bun.file(harness.terminalWritePath).exists()).toBe(false);

      const probes = harness.readProbes();
      expect(probes.status).toBe("");
      expect(probes.log).toBe("");
      expect(probes.stash).toBe("");
    } finally {
      await harness.cleanup();
    }
  });

  test("NEGATIVE CONTROL exposes a commit made before the same kill point", async () => {
    const harness = await createKillHarness("commit-before-kill");
    try {
      const termination = await harness.terminateAtBlock();
      expect(termination.blockedBeforeSigterm).toBe(true);
      expect(termination.aliveBeforeSigterm).toBe(true);
      expect(termination.releaseSentinelPresentBeforeSigterm).toBe(false);

      const probes = harness.readProbes();
      expect(probes.log).not.toBe("");
    } finally {
      await harness.cleanup();
    }
  });

  test("real conflicted rebase remains byte-stable through a named WIP-ref checkpoint", async () => {
    const fixture = await createConflictedRebaseFixture({ taskId: "T1283", role: "worker" });
    try {
      expect(fixture.wipRef).toBe("refs/cq/wip/T1283/worker");
      expect(fixture.initialSnapshots.unmergedIndex.length).toBeGreaterThan(0);
      expect(fixture.initialSnapshots.conflictedFile.toString("utf8")).toContain("<<<<<<<");

      const ordinaryCommit = fixture.attemptOrdinaryCommit();
      const ordinaryCommitDiagnostic = Buffer.concat([
        ordinaryCommit.stdout,
        ordinaryCommit.stderr,
      ]).toString("utf8");
      expect(ordinaryCommit.exitCode).not.toBe(0);
      expect(ordinaryCommitDiagnostic).toContain("unmerged files");
      expect(await fixture.captureSnapshots()).toEqual(fixture.initialSnapshots);

      const checkpoint = "wip-ref-written";
      const termination = await fixture.terminateAfterWipRefCheckpoint(checkpoint);
      expect(termination.checkpoint).toBe(checkpoint);
      expect(termination.blockedBeforeSigterm).toBe(true);
      expect(termination.aliveBeforeSigterm).toBe(true);
      expect(termination.releaseSentinelPresentBeforeSigterm).toBe(false);
      expect(termination.exitSignal).toBe("SIGTERM");
      expect(fixture.readWipRef()).toEqual(fixture.initialSnapshots.head);
      expect(await Bun.file(fixture.conflictedFilePath).exists()).toBe(true);
      expect(await fixture.captureSnapshots()).toEqual(fixture.initialSnapshots);

      await writeFile(
        fixture.conflictedFilePath,
        Buffer.concat([
          fixture.initialSnapshots.conflictedFile,
          Buffer.from("deliberate mutation\n"),
        ]),
      );
      const deliberatelyMutated = await fixture.captureSnapshots();
      expect(deliberatelyMutated.head).toEqual(fixture.initialSnapshots.head);
      expect(deliberatelyMutated.unmergedIndex).toEqual(fixture.initialSnapshots.unmergedIndex);
      expect(deliberatelyMutated.conflictedFile).not.toEqual(
        fixture.initialSnapshots.conflictedFile,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
