import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMPLEMENTATION_EVIDENCE_SERVICE_OPERATION_INVENTORY,
  ImplementationEvidenceService,
  createInMemoryImplementationEvidenceStore,
  createFsImplementationEvidenceStore,
  createInMemoryWorksetStore,
  type ImplementationEvidenceStore,
  type ImplementationAdoptionRecord,
  type RecordImplementationAdoptionInput,
} from "../src/index.js";
import {
  createImplementationEvidenceFixture,
  prepareImplementationCompletion,
} from "./implementationEvidenceTestSupport.js";

describe("operator implementation adoption [Behavioral-Active Blackbox-Atomic]", () => {
  // D461: adopted work cannot truthfully use the obsolete worker completion journal.
  test("offers separate adoption authority when ordinary completion requires re-preparation", async () => {
    const fixture = await createImplementationEvidenceFixture();
    const prepared = await prepareImplementationCompletion(fixture);
    const adoptedHead = "c".repeat(40);
    fixture.setHead(adoptedHead);
    expect(await fixture.service.recordCompletion({
      taskRef: "tasks:T2345",
      expectedRepositoryHead: adoptedHead,
      operationId: "d461-stale-journal",
      author: "parent",
    })).toMatchObject({ status: "reprepare-required", completionRef: prepared.completionRef });
    expect(fixture.getLedgerWrites()).toBe(0);
    expect(IMPLEMENTATION_EVIDENCE_SERVICE_OPERATION_INVENTORY).toContain(
      "record_implementation_adoption",
    );
  });
});

const ADOPTED_HEAD = "c".repeat(40);
const TASK_VERSION = "2026-09-14T09:00:00.000Z";

async function adoptionFixture(store: ImplementationEvidenceStore) {
  const fixture = await createImplementationEvidenceFixture(store);
  const completion = await prepareImplementationCompletion(fixture);
  fixture.setHead(ADOPTED_HEAD);
  let taskUpdatedAt = TASK_VERSION;
  let taskDigest = "a".repeat(64);
  let writes = 0;
  let failWrite = false;
  let recorded: ImplementationAdoptionRecord | null = null;
  const workset = createInMemoryWorksetStore();
  let beforeWrite: () => Promise<void> = async () => {};
  const input: RecordImplementationAdoptionInput = {
    taskRef: "tasks:T2345", expectedTaskUpdatedAt: TASK_VERSION,
    expectedTaskDigest: taskDigest,
    expectedRepositoryHead: ADOPTED_HEAD, resultCommit: ADOPTED_HEAD,
    supersedesCompletionRefs: [completion.completionRef],
    approval: { kind: "explicit-operator-approval", questionRef: "questions:Q405", answer: "Allow explicit operator adoption" },
    authorityLossReason: "Original dispatch authority was lost after rebase.",
    completion: "Adopted the integrated implementation after validation.",
    validation: { kind: "operator-reported-validation", validatedCommit: ADOPTED_HEAD,
      command: "bun run check", exitCode: 0, logPath: "raw/adoption-gate.md", logSha256: "d".repeat(64) },
    operationId: "operator-adoption-T2345", author: "parent", session: "D461",
  };
  const service = (evidenceStore: ImplementationEvidenceStore) => new ImplementationEvidenceService({
    ...fixture.dependencies, store: evidenceStore,
    fetchWorker: async () => { throw new Error("adoption must not request worker evidence"); },
    fetchNativeReview: async () => { throw new Error("adoption must not request reviewer evidence"); },
    operatorAdoption: {
      admit: async (taskRef) => await workset.admitLedgerMutation({ kind: "owned-write", targets: [taskRef] }),
      verify: async (request) => {
        if (request.approval.answer !== input.approval.answer) throw new Error("approval changed");
        if (request.validation.logSha256 !== input.validation.logSha256) throw new Error("log changed");
      },
      taskRevision: async () => ({ updatedAt: taskUpdatedAt, digest: taskDigest }),
      recordLedger: async (_task, adoption) => {
        await beforeWrite();
        if (failWrite) throw new Error("injected ledger write failure");
        if (recorded !== null) {
          expect(recorded.adoptionRef).toBe(adoption.adoptionRef);
          return;
        }
        expect(taskUpdatedAt).toBe(adoption.expectedTaskUpdatedAt);
        expect(taskDigest).toBe(adoption.expectedTaskDigest);
        recorded = adoption;
        writes += 1;
      },
    },
  });
  return { fixture, input, service, completion, workset,
    beforeWrites: (callback: () => Promise<void>) => { beforeWrite = callback; },
    getWrites: () => writes, getRecorded: () => recorded,
    changeTask: () => { taskUpdatedAt = "2026-09-14T09:01:00.000Z"; },
    changeTaskContent: () => { taskDigest = "b".repeat(64); },
    failWrites: (value: boolean) => { failWrite = value; },
  };
}

async function evidenceBackend(backend: "memory" | "filesystem") {
  if (backend === "memory") {
    const store = createInMemoryImplementationEvidenceStore();
    return { store, restart: async () => createInMemoryImplementationEvidenceStore(await store.snapshot()), dispose: async () => {} };
  }
  const root = await mkdtemp(join(tmpdir(), "cq-adoption-record-"));
  const path = join(root, "evidence.json");
  return { store: createFsImplementationEvidenceStore({ path }),
    restart: async () => createFsImplementationEvidenceStore({ path }),
    dispose: async () => { await rm(root, { recursive: true, force: true }); } };
}

for (const backend of ["memory", "filesystem"] as const) {
  describe(`operator adoption durable record — ${backend} [Behavioral-Active Blackbox-${backend === "memory" ? "Atomic" : "GoodCommunication"}]`, () => {
    test("holds root replacement until the durable adoption outcome is acknowledged", async () => {
      const durable = await evidenceBackend(backend);
      const release = Promise.withResolvers<void>();
      try {
        const f = await adoptionFixture(durable.store);
        const entered = Promise.withResolvers<void>();
        f.beforeWrites(async () => { entered.resolve(); await release.promise; });
        const recording = f.service(durable.store).recordAdoption(f.input);
        await entered.promise;
        let replaced = false;
        const replacement = f.workset.setRoots(["goals:G999"]).then(() => { replaced = true; });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(replaced).toBe(false);
        expect(f.workset.activeAdmissionCount()).toBe(1);
        expect(Object.values((await durable.store.snapshot()).adoptions)[0]?.state).toBe("recording");
        release.resolve();
        await recording;
        await replacement;
        expect(Object.values((await durable.store.snapshot()).adoptions)[0]?.state).toBe("recorded");
        expect(f.workset.activeAdmissionCount()).toBe(0);
      } finally { release.resolve(); await durable.dispose(); }
    });

    test("records exact evidence, supersedes old authority, and replays after restart without a review", async () => {
      const durable = await evidenceBackend(backend);
      try {
        const store = durable.store;
        const f = await adoptionFixture(store);
        const first = await f.service(store).recordAdoption(f.input);
        expect(first).toMatchObject({ status: "recorded", kind: "operator-adoption", resultCommit: ADOPTED_HEAD });
        const state = await store.snapshot();
        expect(state.completions[f.completion.completionRef]?.state).toBe("superseded");
        expect(state.adoptions[first.adoptionRef]).toMatchObject({ ...f.input, state: "recorded" });
        expect(Object.keys(f.getRecorded()!)).not.toContain("workerDispatch");
        expect(Object.keys(f.getRecorded()!)).not.toContain("reviewAttemptRefs");
        const restarted = f.service(await durable.restart());
        expect(await restarted.recordAdoption(f.input)).toEqual({ ...first, status: "existing" });
        expect(f.getWrites()).toBe(1);
        await expect(restarted.recordAdoption({ ...f.input, completion: "substituted" })).rejects.toThrow("different evidence");
        await expect(f.fixture.service.recordCompletion({ taskRef: f.input.taskRef,
          expectedRepositoryHead: ADOPTED_HEAD, operationId: "ordinary-after-adoption", author: "parent" }))
          .rejects.toThrow("exactly one active completion journal");
      } finally { await durable.dispose(); }
    });

    test("a failed ledger write retains a retryable reservation across restart", async () => {
      const durable = await evidenceBackend(backend);
      const store = durable.store;
      try {
        const f = await adoptionFixture(store);
        f.failWrites(true);
        await expect(f.service(store).recordAdoption(f.input)).rejects.toThrow("injected ledger write failure");
        expect(Object.values((await store.snapshot()).adoptions)[0]?.state).toBe("recording");
        expect(f.getWrites()).toBe(0);
        f.failWrites(false);
        const restarted = await durable.restart();
        expect(await f.service(restarted).recordAdoption(f.input)).toMatchObject({ status: "recorded" });
        expect(f.getWrites()).toBe(1);
      } finally { await durable.dispose(); }
    });
  });
}

test("adoption refuses stale or incomplete evidence before reserving authority [Behavioral-Active Blackbox-Atomic]", async () => {
  for (const violation of ["head", "task", "task-content", "journals", "approval", "log", "failed-gate", "different-gate-commit"] as const) {
    const store = createInMemoryImplementationEvidenceStore();
    const f = await adoptionFixture(store);
    let input = f.input;
    if (violation === "head") f.fixture.setHead("e".repeat(40));
    if (violation === "task") f.changeTask();
    if (violation === "task-content") f.changeTaskContent();
    if (violation === "journals") input = { ...input, supersedesCompletionRefs: [] };
    if (violation === "approval") input = { ...input, approval: { ...input.approval, answer: "different" } };
    if (violation === "log") input = { ...input, validation: { ...input.validation, logSha256: "f".repeat(64) } };
    if (violation === "failed-gate") input = { ...input, validation: { ...input.validation, exitCode: 1 as 0 } };
    if (violation === "different-gate-commit") input = { ...input, validation: { ...input.validation, validatedCommit: "e".repeat(40) } };
    const before = await store.snapshot();
    await expect(f.service(store).recordAdoption(input)).rejects.toThrow();
    expect(await store.snapshot()).toEqual(before);
    expect(f.getWrites()).toBe(0);
  }
});
