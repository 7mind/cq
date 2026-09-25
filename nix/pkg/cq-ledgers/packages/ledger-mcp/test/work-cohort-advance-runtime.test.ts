import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryLedgerStore, SqliteLedgerStore, cohortValueDigestV1 as digest,
  createCohortCommandBoundaryV1, readCohortAdvanceStatusV1, readRetainedManagedCohortHandle,
  createCohortEffectEnvelopeV1, resolveRetainedManagedCohortAuthority,
  type CohortAdmissionPlanV1 } from "@cq/ledger";
import { prepareCohortPrimaryFixture } from "../../ledger/test/workCohortCompletionContract.js";
import { cohortBrokerGit as git } from "../../ledger/test/workCohortGitBrokerFixture.js";
import { createCohortAdvanceRuntimeV1 } from "../src/workCohortAdvanceRuntime.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

export async function advanceRuntimeFixture(adapter: "memory" | "sqlite") {
  const root = await mkdtemp(join(tmpdir(), "cq-advance-production-"));
  await mkdir(join(root, ".state"));
  const store = adapter === "memory" ? new InMemoryLedgerStore()
    : new SqliteLedgerStore({ dbPath: join(root, ".state", "ledger.db") });
  await store.init();
  const close = async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); };
  const controls: { catalogHash: string; failBeforeAllocation: boolean; mutateBeforeAllocation: boolean; changeRootsBeforePublication: boolean } = {
    catalogHash: "b".repeat(64), failBeforeAllocation: false, mutateBeforeAllocation: false, changeRootsBeforePublication: false,
  };
  try {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "Cohort advance"]);
    await git(root, ["config", "user.email", "cohort@example.invalid"]);
    await git(root, ["config", "commit.gpgsign", "false"]);
    const source = "export interface SharedContract { readonly value: string }\n";
    await writeFile(join(root, "shared.ts"), source);
    await writeFile(join(root, "bun.lock"), "{}\n");
    await writeFile(join(root, ".gitignore"), ".claude/\n.state/\n.cache/\nnode_modules/\n");
    await git(root, ["add", "."]); await git(root, ["commit", "-q", "-m", "seed"]);
    const { taskIds } = await prepareCohortPrimaryFixture(store);
    for (const id of taskIds) await store.updateItem("tasks", id, { fields: { sourceRefs: ["shared.ts"] } });
    await store.worksetStore().setRoots(["goals:G1"]);
    const boundary = (identity: string) => ({ identity, digest: digest(identity) });
    const plan: CohortAdmissionPlanV1 = { kind: "cq-cohort-admission-plan", version: 1,
      members: taskIds.map((id) => ({ memberRef: `tasks:${id}`, boundaryCandidates: [{
        witness: { kind: "repository-node", nodeKind: "versioned-contract", nodeIdentity: "shared.ts#SharedContract",
          sourcePath: "shared.ts", memberPath: ["shared.ts"] },
        sharedRegression: createCohortCommandBoundaryV1({ argv: ["bun", "test", "shared.test.ts"], cwd: "nix/pkg/cq-ledgers", environment: [] }),
        canonicalFullGate: createCohortCommandBoundaryV1({ argv: ["bun", "run", "check"], cwd: "nix/pkg/cq-ledgers", environment: [] }),
        reviewerClass: boundary("whole-candidate"), deploymentClass: boundary("none"), finalizationClass: boundary("atomic"),
        splitConditions: [], focusedCommand: { argv: ["bun", "test", `${id}.test.ts`], cwd: "nix/pkg/cq-ledgers", environment: {},
          provenance: { sourceRef: "shared.ts", sourceRevision: digest(source) } },
      }] })) };
    const promptArtifacts: PromptArtifactStore = {
      readManifest: () => ({ bytes: new Uint8Array(), roles: [], promptSurface: "codex", catalogHash: controls.catalogHash }),
      readRole: () => { throw new Error("admission does not dispatch roles"); },
    };
    const runtime = await createCohortAdvanceRuntimeV1({ resolved: { store, backend: "xdg", configRoot: root, branch: "cq-ledger" },
      promptArtifacts, managedDeps: { stateDir: join(root, ".state", "registry"), cacheRoot: join(root, ".cache"), bunWorkspaceRoot: root, skipInstall: true,
        faultInjector: async (point) => {
          if (point === "before-registry-pointer-rename" && controls.changeRootsBeforePublication) await store.worksetStore().setRoots(["tasks:T900"]);
          if (point !== "before-worktree-add") return;
          if (controls.failBeforeAllocation) throw new Error("interrupted before allocation");
          if (controls.mutateBeforeAllocation) await store.updateItem("tasks", taskIds[0]!, { fields: { headline: "changed during allocation" } });
        } } });
    if (runtime === undefined) throw new Error("local cohort advance runtime absent");
    return { root, store, runtime, plan, taskIds, controls, close };
  } catch (error) { await close(); throw error; }
}

for (const adapter of ["memory", "sqlite"] as const) {
  test(`${adapter} changed acceptance boundaries create a new generation without losing witness applicability [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const f = await advanceRuntimeFixture(adapter);
    try {
      const first = await f.runtime.observe({ plan: f.plan, operationId: "original-boundary" });
      const changed: CohortAdmissionPlanV1 = { ...f.plan, members: f.plan.members.map((member) => ({ ...member,
        boundaryCandidates: member.boundaryCandidates.map((candidate) => ({ ...candidate,
          sharedRegression: createCohortCommandBoundaryV1({ argv: ["bun", "test", "replacement-shared.test.ts"],
            cwd: "nix/pkg/cq-ledgers", environment: [] }),
        })),
      })) };
      const second = await f.runtime.observe({ plan: changed, operationId: "replacement-boundary" });
      expect(second.definitions).toHaveLength(1);
      expect(second.definitions[0]!.definitionGeneration).toBe(first.definitions[0]!.definitionGeneration + 1);
      expect(second.definitions[0]!.definitionDigest).not.toBe(first.definitions[0]!.definitionDigest);
    } finally { await f.close(); }
  });

  test(`${adapter} omission cannot discard an already-observed common witness [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const f = await advanceRuntimeFixture(adapter);
    try {
      await writeFile(join(f.root, "shared.ts"), "export interface SharedContract { readonly value: string }\nexport interface Alternative1 { readonly first: string }\nexport interface Alternative2 { readonly second: string }\n");
      await git(f.root, ["add", "shared.ts"]);
      await git(f.root, ["commit", "-q", "-m", "witness alternatives"]);
      const full = await f.runtime.observe({ plan: f.plan, operationId: "fused" });
      expect(full.definitions).toHaveLength(1);
      const omitted: CohortAdmissionPlanV1 = { ...f.plan, members: f.plan.members.map((member, index) => ({ ...member,
        boundaryCandidates: member.boundaryCandidates.map((candidate) => ({ ...candidate,
          witness: { kind: "repository-node", nodeKind: "versioned-contract", sourcePath: "shared.ts",
            memberPath: ["shared.ts"], nodeIdentity: `shared.ts#Alternative${index + 1}` },
        })),
      })) };
      await expect(f.runtime.observe({ plan: omitted, operationId: "omitted-common" })).rejects.toThrow("previously observed common boundary");
      expect((await f.store.workCohortStore().snapshot()).portable.definitions).toHaveLength(1);
    } finally { await f.close(); }
  });

  test(`${adapter} a delayed observation cannot supersede a newer environment [Behavioral-Active Whitebox-GoodCommunication]`, async () => {
    const f = await advanceRuntimeFixture(adapter);
    let continueOld: () => void = () => {};
    try {
      const cohorts = f.store.workCohortStore();
      const original = cohorts.recordObservation.bind(cohorts);
      let reportPaused: () => void = () => {};
      const paused = new Promise<void>((resolve) => { reportPaused = resolve; });
      const resumed = new Promise<void>((resolve) => { continueOld = resolve; });
      cohorts.recordObservation = async (operation, observation) => {
        const result = await original(operation, observation);
        if (operation === "old:observation") { reportPaused(); await resumed; }
        return result;
      };
      const old = f.runtime.observe({ plan: f.plan, operationId: "old" }).then(
        () => ({ rejected: false }), () => ({ rejected: true }),
      );
      await paused;
      f.controls.catalogHash = "c".repeat(64);
      const currentPromise = f.runtime.observe({ plan: f.plan, operationId: "current" });
      continueOld();
      const current = await currentPromise;
      expect((await old).rejected).toBe(true);
      const prepared = await f.runtime.prepare({ plan: f.plan, operationId: "prepare-current",
        definitionDigest: current.definitions[0]!.definitionDigest });
      expect(prepared.worktree.status).toBe("prepared");
      expect((await cohorts.snapshot()).portable.definitions.at(-1)?.definitionDigest).toBe(current.definitions[0]!.definitionDigest);
    } finally { continueOld(); await f.close(); }
  });

  test(`${adapter} an unrestricted workset publishes its cohort instead of refusing at the fence [Behavioral-Active Blackbox-Atomic]`, async () => {
    // D556: admission and publication must decide the effective workset the same
    // way. D547 taught observation to treat empty persisted roots as the
    // historical unrestricted mode; the publication fence kept reconstructing
    // the workset from the raw roots and requiring a restrictive graph, so every
    // cohort admitted and then refused its worktree with registry-conflict.
    const f = await advanceRuntimeFixture(adapter);
    try {
      await f.store.worksetStore().setRoots([]);
      const observed = await f.runtime.observe({ plan: f.plan, operationId: "observe-unrestricted" });
      const prepared = await f.runtime.prepare({
        plan: f.plan,
        operationId: "prepare-unrestricted",
        definitionDigest: observed.definitions[0]!.definitionDigest,
      });
      expect(prepared.worktree.status).toBe("prepared");
    } finally { await f.close(); }
  });

  test(`${adapter} a workset replacement cannot publish the prior cohort authority [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const f = await advanceRuntimeFixture(adapter);
    try {
      const observed = await f.runtime.observe({ plan: f.plan, operationId: "observe" });
      f.controls.changeRootsBeforePublication = true;
      const result = await f.runtime.prepare({ plan: f.plan, operationId: "prepare", definitionDigest: observed.definitions[0]!.definitionDigest });
      expect(result.worktree.status).toBe("refused");
      const state = await f.store.workCohortStore().snapshot();
      const intent = state.portable.candidateIntents[0]!;
      const deps = { stateDir: join(f.root, ".state", "registry") };
      expect(await readRetainedManagedCohortHandle(f.root, intent.intentDigest, deps)).not.toBeNull();
      const envelope = createCohortEffectEnvelopeV1({ definition: observed.definitions[0]!, observation: state.portable.observations[0]!,
        intent, evidenceSubject: null, executionEpoch: state.runtime.executionEpoch });
      await expect(resolveRetainedManagedCohortAuthority(f.root, f.store.workCohortStore(), envelope, deps, false)).rejects.toThrow("retention is unavailable");
    } finally { await f.close(); }
  });

  test(`${adapter} explicit preparation resume renews the epoch without reallocating a worktree [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const f = await advanceRuntimeFixture(adapter);
    try {
      const observed = await f.runtime.observe({ plan: f.plan, operationId: "observe" });
      const prepared = await f.runtime.prepare({ plan: f.plan, operationId: "prepare", definitionDigest: observed.definitions[0]!.definitionDigest });
      const input = { plan: f.plan, operationId: "resume", definitionDigest: prepared.cohort.definition.definitionDigest,
        intentDigest: prepared.cohort.intent.intentDigest };
      await f.store.workCohortStore().beginNewExecutionEpoch();
      const resumed = await f.runtime.resume(input);
      expect(resumed.cohort.executionEpoch).not.toBe(prepared.cohort.executionEpoch);
      expect(resumed.cohort.semanticSubject).toBe(prepared.cohort.semanticSubject);
      expect(resumed.worktree.status).toBe("prepared");
      if (resumed.worktree.status !== "refused" && prepared.worktree.status !== "refused") expect(resumed.worktree.handle).toEqual(prepared.worktree.handle);
      expect(await f.runtime.resume(input)).toEqual(resumed);
      await expect(f.runtime.prepare({ plan: f.plan, operationId: "prepare", definitionDigest: prepared.cohort.definition.definitionDigest })).rejects.toThrow();
      expect((await f.store.workCohortStore().snapshot()).portable.candidateSeals).toHaveLength(0);
    } finally { await f.close(); }
  });

  test(`${adapter} preparation retains its private lease before allocation and rejects a foreign attempt without invalidating it [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const f = await advanceRuntimeFixture(adapter);
    try {
      const observed = await f.runtime.observe({ plan: f.plan, operationId: "observe" });
      const input = { plan: f.plan, operationId: "prepare", definitionDigest: observed.definitions[0]!.definitionDigest };
      f.controls.failBeforeAllocation = true;
      await expect(f.runtime.prepare(input)).rejects.toThrow("interrupted before allocation");
      f.controls.failBeforeAllocation = false;
      const prepared = await f.runtime.prepare(input);
      expect(prepared.worktree.status).toBe("prepared");
      await expect(f.runtime.prepare({ ...input, operationId: "foreign-attempt" })).rejects.toThrow();
      expect((await f.runtime.prepare(input)).worktree.status).toBe("prepared");
    } finally { await f.close(); }
  });

  test(`${adapter} changed primary revisions cannot publish old preparation authority [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const f = await advanceRuntimeFixture(adapter);
    try {
      const observed = await f.runtime.observe({ plan: f.plan, operationId: "observe" });
      f.controls.mutateBeforeAllocation = true;
      const result = await f.runtime.prepare({ plan: f.plan, operationId: "prepare", definitionDigest: observed.definitions[0]!.definitionDigest });
      expect(result.worktree.status).toBe("refused");
    } finally { await f.close(); }
  });

  test(`${adapter} each admission rebinds the installed environment [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const f = await advanceRuntimeFixture(adapter);
    try {
      const first = await f.runtime.observe({ plan: f.plan, operationId: "before" });
      f.controls.catalogHash = "c".repeat(64);
      const changed = await f.runtime.observe({ plan: f.plan, operationId: "after" });
      expect(changed.observationDigest).not.toBe(first.observationDigest);
      expect(changed.definitions[0]!.definitionGeneration).toBe(first.definitions[0]!.definitionGeneration + 1);
      await expect(f.runtime.prepare({ plan: f.plan, operationId: "old", definitionDigest: first.definitions[0]!.definitionDigest }))
        .rejects.toThrow("admission changed");
    } finally { await f.close(); }
  });

  test(`${adapter} outer admission fuses the ready boundary and prepares every member once [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const f = await advanceRuntimeFixture(adapter);
    try {
      const observed = await f.runtime.observe({ plan: f.plan, operationId: "observe" });
      expect(observed.decisions).toHaveLength(1);
      expect(observed.definitions[0]!.members.map(({ memberRef }) => memberRef)).toEqual(f.taskIds.map((id) => `tasks:${id}`));
      expect(await f.runtime.observe({ plan: f.plan, operationId: "observe" })).toEqual(observed);
      const prepared = await f.runtime.prepare({ plan: f.plan, operationId: "prepare", definitionDigest: observed.definitions[0]!.definitionDigest });
      expect(prepared.worktree.status).toBe("prepared");
      expect(prepared.cohort.state).toBe("pre-seal");
      const replay = await f.runtime.prepare({ plan: f.plan, operationId: "prepare", definitionDigest: observed.definitions[0]!.definitionDigest });
      expect(replay.cohort).toEqual(prepared.cohort);
      expect(replay.worktree.status).toBe("prepared");
      if (replay.worktree.status !== "refused" && prepared.worktree.status !== "refused") expect(replay.worktree.handle).toEqual(prepared.worktree.handle);
      const status = await readCohortAdvanceStatusV1(f.store.workCohortStore());
      expect(status.counters.observations).toBe(1);
      expect(status.counters.candidateSeals).toBe(0);
      expect(JSON.stringify(status)).not.toContain("capability");
    } finally { await f.close(); }
  });

  test(`${adapter} callers cannot suppress ready peers to bypass mandatory fusion [Behavioral-Active Blackbox-GoodCommunication]`, async () => {
    const f = await advanceRuntimeFixture(adapter);
    try {
      await expect(f.runtime.observe({ plan: { ...f.plan, members: [f.plan.members[0]!] }, operationId: "subset" }))
        .rejects.toThrow("ready boundary");
      expect((await f.store.workCohortStore().snapshot()).portable.observations).toHaveLength(0);
    } finally { await f.close(); }
  });
}
