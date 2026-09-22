import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryAttestationBackend, InMemoryAttestationStore } from "@cq/config";
import { InMemoryLedgerStore, createInMemoryImplementationEvidenceStore } from "@cq/ledger";
import { prepareCohortCompletionFixture } from "../../ledger/test/workCohortCompletionContract.js";
import { createCohortCompletionRuntimeV1 } from "../src/workCohortCompletionRuntime.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

test("production cohort runtime requires privately retained managed authority and disables remote effects [Behavioral-Active Blackbox-GoodCommunication]", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohort-runtime-"));
  const store = new InMemoryLedgerStore(); await store.init();
  const evidence = createInMemoryImplementationEvidenceStore();
  const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore({ backend: "xdg", projectKey: "runtime-contract" }));
  const promptArtifacts: PromptArtifactStore = {
    readManifest: () => { throw new Error("authority refusal must precede prompt authentication"); },
    readRole: () => { throw new Error("authority refusal must precede prompt authentication"); },
  };
  try {
    const f = await prepareCohortCompletionFixture(store);
    const options = { resolved: { store, implementationEvidenceStore: evidence, backend: "xdg" as const,
      configRoot: directory, branch: "cq-ledger" }, backend, promptArtifacts,
      cancellationSignal: new AbortController().signal, stateDir: join(directory, "registry") };
    expect(createCohortCompletionRuntimeV1({ ...options, resolved: { ...options.resolved, backend: "remote" } })).toBeUndefined();
    const runtime = createCohortCompletionRuntimeV1(options);
    if (runtime === undefined) throw new Error("local runtime is unavailable");
    expect(await runtime.status({ operationId: f.batch.operationId })).toEqual({ executor: "local-xdg", handoff: null });
    await expect(runtime.complete({ batch: f.batch })).rejects.toThrow("authority retention is unavailable");
    await expect(runtime.recordReview({ reviewerDispatch: { attestationId: "caller-review", generation: 1 }, envelope: f.batch.envelope,
      operationId: "review", author: "contract", session: "T6562" })).rejects.toThrow("authority retention is unavailable");
    expect(f.taskIds.map((id) => store.fetchItem("tasks", id).status)).toEqual(["wip", "wip"]);
    expect(Object.keys((await evidence.snapshot()).cohortCompletions)).toEqual([]);
  } finally { await backend.close(); await store.dispose(); await rm(directory, { recursive: true, force: true }); }
});
