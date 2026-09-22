import { expect, test } from "bun:test";
import { completionRuntimeFixture } from "./workCohortCompletionRuntimeFixture.js";
import { cohortBrokerGit } from "../../ledger/test/workCohortGitBrokerFixture.js";
import { acknowledgeOperatorAction, operatorActionRevision, readAuthorizedCohortCompletionHandoffV1, readCohortAdvanceStatusV1 } from "@cq/ledger";
import type { OwnedMutationContext } from "../../ledger/src/store/directOwnedMutation.js";
import type { WorksetOwnedWriteTx } from "../../ledger/src/worksetOwnedLifecycle.js";
import { access, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { serializeWipArtifact } from "@cq/config";

for (const adapter of ["memory", "sqlite"] as const) {
  test(`terminal cohort cleanup preserves unrelated inherited WIP ${adapter} [Behavioral-Active Effectual-GoodCommunication]`, async () => {
    const inherited = serializeWipArtifact({ id: "T9999", role: "implement-worker", baseCommit: "b".repeat(40),
      startedAt: "2026-09-22T00:00:00.000Z", checkpoints: [{ name: "inherited", status: "todo", body: "owned elsewhere\n" }],
      complete: false, openCheckpoints: ["inherited"] });
    const f = await completionRuntimeFixture(adapter, false, inherited);
    try {
      expect((await f.complete()).state).toBe("complete");
      expect(await cohortBrokerGit(f.root, ["show", "HEAD:WIP-T9999.md"])).toBe(inherited.trim());
    } finally { await f.close(); }
  }, 30_000);
  for (const boundary of ["before-release", "lost-release-ack", "before-worktree-remove", "before-registry-release", "after-registry-pointer-rename"] as const) {
    test(`terminal cohort cleanup recovers ${boundary} without reacquiring archived authority ${adapter} [Behavioral-Active Effectual-GoodCommunication]`, async () => {
      const f = await completionRuntimeFixture(adapter, false);
      try {
        let interrupted = false;
        const persist = f.cohorts.recordCompletionHandoff.bind(f.cohorts);
        f.cohorts.recordCompletionHandoff = async (id, lease, envelope, authorized) => {
          if (!interrupted && readAuthorizedCohortCompletionHandoffV1(authorized).phase === "released" &&
              (boundary === "before-release" || boundary === "lost-release-ack")) {
            interrupted = true;
            if (boundary === "lost-release-ack") await persist(id, lease, envelope, authorized);
            throw new Error("terminal interrupted");
          }
          return persist(id, lease, envelope, authorized);
        };
        const runtime = f.runtimeWithArtifact("test-artifact-one", async (point) => {
          if (!interrupted && point === boundary) { interrupted = true; throw new Error("terminal interrupted"); }
        });
        await expect(runtime.complete({ batch: f.batch })).rejects.toThrow("terminal interrupted");
        expect(interrupted).toBe(true);
        const state = await f.cohorts.snapshot();
        expect(state.portable.completionHandoffs.at(-1)?.phase).toBe(boundary === "before-release" ? "ledger-recorded" : "released");
        const successor = boundary === "before-release" ? null : await f.cohorts.acquireLease({ holderId: "next-independent-cohort", semanticSubject: "next-independent-subject" });
        const completed = await f.complete();
        expect(completed.state).toBe("complete");
        await expect(access(f.managed.handle.absolutePath)).rejects.toThrow();
        expect((await f.cohorts.snapshot()).portable.reservationTransitions.map(({ transition }) => transition)).toEqual(["reserved", "released"]);
        expect(await f.complete()).toEqual(completed);
        if (successor !== null) {
          expect((await f.cohorts.snapshot()).runtime.lease?.semanticSubject).toBe(successor.semanticSubject);
          await f.cohorts.releaseLease(successor);
        }
        expect(f.commands).toHaveLength(4);
      } finally { await f.close(); }
    }, 30_000);
  }
  for (const change of ["dirty", "commit-mismatch"] as const) test(`terminal cleanup refuses ${change} and resumes exact cleanup ${adapter} [Behavioral-Active Effectual-GoodCommunication]`, async () => {
    const f = await completionRuntimeFixture(adapter, false);
    try {
      const persist = f.cohorts.recordCompletionHandoff.bind(f.cohorts);
      f.cohorts.recordCompletionHandoff = async (id, lease, envelope, authorized) => {
        const result = await persist(id, lease, envelope, authorized);
        if (readAuthorizedCohortCompletionHandoffV1(authorized).phase === "released") {
          if (change === "dirty") await writeFile(join(f.managed.handle.absolutePath, "operator-edit.txt"), "preserve\n");
          else await cohortBrokerGit(f.managed.handle.absolutePath, ["commit", "--allow-empty", "-qm", "operator changed candidate"]);
        }
        return result;
      };
      await expect(f.complete()).rejects.toThrow(`cleanup pending (${change})`);
      expect((await f.cohorts.snapshot()).runtime.lease).toBeNull();
      if (change === "dirty") {
        await access(join(f.managed.handle.absolutePath, "operator-edit.txt"));
        await unlink(join(f.managed.handle.absolutePath, "operator-edit.txt"));
      } else {
        const changedTip = await cohortBrokerGit(f.managed.handle.absolutePath, ["rev-parse", "HEAD"]);
        expect(changedTip).not.toBe(f.batch.resultCommit);
        await cohortBrokerGit(f.root, ["update-ref", `refs/heads/${f.managed.handle.branch}`, f.batch.resultCommit, changedTip]);
      }
      expect((await f.complete()).state).toBe("complete");
    } finally { await f.close(); }
  }, 30_000);
  for (const interruption of ["before-primary", "lost-ack"] as const) {
    test(`production deployment ${interruption} recovers without repeating acceptance ${adapter} [Behavioral-Active Effectual-GoodCommunication]`, async () => {
      const f = await completionRuntimeFixture(adapter, true);
      try {
        const waiting = await f.complete();
        if (waiting.state !== "deployment-required") throw new Error(JSON.stringify(waiting));
        const actionId = waiting.operatorActionRef.slice("operatorActions:".length);
        const action = f.ledger.fetchItem("operatorActions", actionId);
        await acknowledgeOperatorAction(f.ledger, { actionId, expectedRevision: operatorActionRevision(action),
          outputIdentity: String(action.fields["expectedOutputIdentity"]), acknowledgedAt: new Date().toISOString() });
        let interrupted = false;
        const primary = f.ledger as { runAtomicOwnedMutation<T>(mutate: (tx: WorksetOwnedWriteTx) => T, context: OwnedMutationContext): Promise<T> };
        const write = primary.runAtomicOwnedMutation.bind(primary);
        primary.runAtomicOwnedMutation = async (mutate, context) => {
          if (interruption === "before-primary" && !interrupted && context !== null && "direct" in context && context.direct.kind === "cohort-completion") {
            interrupted = true; throw new Error("primary interrupted");
          }
          return write(mutate, context);
        };
        const persist = f.cohorts.recordCompletionHandoff.bind(f.cohorts);
        f.cohorts.recordCompletionHandoff = async (id, lease, envelope, authorized) => {
          if (interruption === "lost-ack" && !interrupted && readAuthorizedCohortCompletionHandoffV1(authorized).phase === "ledger-recorded") {
            interrupted = true; throw new Error("primary interrupted acknowledgement");
          }
          return persist(id, lease, envelope, authorized);
        };
        await expect(f.complete()).rejects.toThrow("primary interrupted");
        expect((await f.cohorts.snapshot()).portable.completionHandoffs.at(-1)?.phase).toBe("ledger-recording");
        expect(f.ledger.fetch("handoffs").milestones.flatMap(({ items }) => items)).toHaveLength(interruption === "before-primary" ? 1 : 0);
        if (interruption === "before-primary") expect(f.taskIds.map((id) => f.ledger.fetchItem("tasks", id).status)).toEqual(["wip", "wip"]);
        const completed = interruption === "before-primary"
          ? await f.runtimeWithArtifact("test-artifact-two").complete({ batch: f.batch }) : await f.complete();
        expect(completed.state).toBe("complete");
        const record = Object.values((await f.evidence.snapshot()).cohortCompletions)[0]!;
        expect(record.probes).toHaveLength(interruption === "before-primary" ? 4 : 2);
        expect(new Set(record.probes.map(({ probeEpoch }) => probeEpoch)).size).toBe(interruption === "before-primary" ? 2 : 1);
        expect(f.commands).toHaveLength(4);
      } finally { await f.close(); }
    }, 30_000);
  }
  test(`production cohort deployment closes its handoff and retains member diagnostics ${adapter} [Behavioral-Active Effectual-GoodCommunication]`, async () => {
    const f = await completionRuntimeFixture(adapter, true);
    try {
      await f.ledger.createItem("handoffs", "M-AMBIENT", { id: "HO900", status: "user-action-required",
        fields: { summary: "unrelated", ledgerRefs: [], handoffReasons: ["unrelated operator work"] } });
      const waiting = await f.complete();
      expect(waiting.state).toBe("deployment-required");
      if (waiting.state !== "deployment-required") throw new Error(JSON.stringify(waiting));
      expect(f.taskIds.map((id) => f.ledger.fetchItem("tasks", id).status)).toEqual(["wip", "wip"]);
      const actionId = waiting.operatorActionRef.slice("operatorActions:".length);
      const action = f.ledger.fetchItem("operatorActions", actionId);
      await acknowledgeOperatorAction(f.ledger, { actionId, expectedRevision: operatorActionRevision(action),
        outputIdentity: String(action.fields["expectedOutputIdentity"]), acknowledgedAt: new Date().toISOString() });
      const completed = await f.complete();
      expect(completed.state).toBe("complete");
      expect(f.ledger.fetchItem("operatorActions", actionId).status).toBe("verified");
      const handoff = f.ledger.fetch("handoffs").milestones.flatMap(({ items }) => items)
        .find((item) => (item.fields["ledgerRefs"] as string[]).includes(waiting.operatorActionRef));
      const journal = Object.values((await f.evidence.snapshot()).cohortCompletions)[0]!;
      expect(journal.probes).toHaveLength(2);
      expect(journal.probes).toEqual(expect.arrayContaining(f.taskIds.map((id) => expect.objectContaining({
        taskRef: `tasks:${id}`, execution: expect.objectContaining({ outputTail: expect.stringContaining(`${id} smoke passed`) }),
      }))));
      expect(handoff).toBeUndefined();
      expect(f.ledger.fetchItem("handoffs", "HO900").fields["summary"]).toBe("unrelated");
      expect(await f.complete()).toEqual(completed);
      expect(Object.values((await f.evidence.snapshot()).cohortCompletions)[0]!.probes).toHaveLength(2);
    } finally { await f.close(); }
  }, 30_000);
  test(`production cohort review and completion atomically archive every member ${adapter} [Behavioral-Active Effectual-GoodCommunication]`, async () => {
    const f = await completionRuntimeFixture(adapter, false);
    try {
      const completed = await f.complete();
      expect(completed.state).toBe("complete");
      if (completed.state !== "complete") throw new Error(JSON.stringify(completed));
      expect(completed.handoff.phase).toBe("released");
      expect(completed.handoff.ledgerResult?.archivedRefs).toEqual(expect.arrayContaining(f.taskIds.map((id) => `tasks:${id}`)));
      expect(f.ledger.fetchItem("goals", "G1").status).toBe("building");
      expect(f.ledger.fetchItem("tasks", "T900").status).toBe("wip");
      expect(await cohortBrokerGit(f.root, ["rev-parse", "HEAD"])).toBe(f.batch.resultCommit);
      const terminal = await f.cohorts.snapshot();
      expect(terminal.runtime.lease).toBeNull();
      expect(terminal.runtime.resumeValidation).toBeNull();
      expect(terminal.portable.reservationTransitions.map(({ transition }) => transition)).toEqual(["reserved", "released"]);
      await expect(access(f.managed.handle.absolutePath)).rejects.toThrow();
      const successor = await f.cohorts.acquireLease({ holderId: "next-independent-cohort", semanticSubject: "next-independent-subject" });
      expect(await f.complete()).toEqual(completed);
      expect((await f.cohorts.snapshot()).runtime.lease?.semanticSubject).toBe(successor.semanticSubject);
      await f.cohorts.releaseLease(successor);
      expect(f.commands).toHaveLength(4);
      expect((await readCohortAdvanceStatusV1(f.cohorts)).counters).toMatchObject({
        authenticatedReviews: 1, reviewReuses: 2, primaryFinalizations: 1, primaryFinalizationAttempts: 2,
        itemSweeps: new Set(completed.handoff.ledgerResult!.archivedRefs).size,
        focusedExecutions: 2, sharedExecutions: 1, fullGateExecutions: 1,
      });
      await f.cohorts.beginNewExecutionEpoch();
      expect((await f.cohorts.snapshot()).runtime.resumeRequired).toBe(false);
      const nextEpoch = await f.cohorts.acquireLease({ holderId: "next-epoch-cohort", semanticSubject: "next-epoch-subject" });
      expect(await f.complete()).toEqual(completed);
      expect((await f.cohorts.snapshot()).runtime.lease?.semanticSubject).toBe(nextEpoch.semanticSubject);
      await f.cohorts.releaseLease(nextEpoch);
    } finally { await f.close(); }
  }, 30_000);
}
