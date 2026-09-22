import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { InMemoryAttestationBackend, InMemoryAttestationStore, SqliteAttestationBackend,
  IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_TAIL_BYTE_LIMIT,
  sequentialDispatchRandomBytes, type AttestationBackend, type DispatchJSONValue } from "@cq/config";
import { COHORT_INVESTIGATION_ADVANCE_SCHEMA, cohortValueDigestV1 as digest,
  createInMemoryWorkCohortStore, createInMemoryWorksetStore, createNodeSupervisedWorkerCommandRunner,
  InMemoryLedgerStore, SqliteLedgerStore, createWorksetOwnedGuardedLedger, createTrustedWorksetManagementAuthority, createCohortCommandBoundaryV1,
  settleProcessGroups, settleWorktreeGateCommands,
  type CohortInvestigationAdvanceResultV1, type SupervisedWorkerCommandRunner } from "@cq/ledger";
import { createSqliteWorkCohortStore } from "../../ledger/src/store/sqlite/sqliteWorkCohortStore.js";
import { openLedgerDb } from "../../ledger/src/store/sqlite/connection.js";
import { ensureSchema } from "../../ledger/src/store/sqlite/schema.js";
import { investigationPlanFixture, investigationRole, INVESTIGATION_NOW } from "../../ledger/test/workCohortInvestigationFixture.js";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import { createInvestigationAdvanceCapabilityV1, createCohortInvestigationAdvanceRuntimeV1 } from "../src/workCohortInvestigationAdvanceRuntime.js";
import { createCohortAdvanceRuntimeV1 } from "../src/workCohortAdvanceRuntime.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

function artifacts(): PromptArtifactStore {
  const roles = (["investigate-explorer", "investigate-prober"] as const).map((roleId) => {
    const role = investigationRole(roleId);
    return { roleId, roleKind: "dispatched-subagent" as const, artifactPath: `roles/${roleId}.md`,
      sidecarSchemaRoleId: roleId, promptSurface: role.surface, promptDigest: role.promptDigest,
      schemaVersion: role.version, schemaDigest: role.schemaDigest };
  });
  return { readManifest: () => ({ bytes: new Uint8Array(), roles, promptSurface: "claude", catalogHash: investigationRole("investigate-explorer").catalogHash }),
    readRole: (roleId) => { const metadata = roles.find((role) => role.roleId === roleId);
      if (metadata === undefined) throw new Error("unknown fixture role");
      return { metadata, bytes: new Uint8Array([1]) }; } };
}

class ManualProbeRunner implements SupervisedWorkerCommandRunner {
  count = 0;
  output = "confirmed\n";
  async run(request: Parameters<SupervisedWorkerCommandRunner["run"]>[0]) {
    if (request.effectAdmission === undefined) throw new Error("probe lacks all-member admission");
    const admission = await request.effectAdmission.provider.acquire({ kind: "child-dispatch", targetRef: request.effectAdmission.targetRef });
    try {
      await admission.registerProcessGroup({ leaderPid: 101, pgid: 101 });
      await admission.shareWithGuardian({ leaderPid: 101, pgid: 101 });
      this.count++;
      const output = this.output;
      return { executionId: `manual:${this.count}`, outputDigest: createHash("sha256").update(output).digest("hex"),
        outputTail: output.slice(-IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_TAIL_BYTE_LIMIT),
        ...(Buffer.byteLength(output) <= IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_TAIL_BYTE_LIMIT ? { completeOutput: output } : {}),
        gateExitCode: 0, passCount: 0, failCount: 0, gateDurationMs: 1, capturedAt: INVESTIGATION_NOW };
    } finally { await admission.markSettled(); await admission.releaseAfterSettlement(); }
  }
}

async function fixture(adapter: "memory" | "SQLite") {
  const directory = await mkdtemp(join(tmpdir(), "cq-investigation-parent-"));
  const initialized = Bun.spawnSync(["git", "init", directory]);
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "cause.ts"), "confirmed\n");
  const namespace = { backend: "xdg" as const, projectKey: "parent-investigation" };
  const backend: AttestationBackend = adapter === "memory" ? new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace)) :
    new SqliteAttestationBackend({ namespace, dbPath: join(directory, "dispatch.db") });
  const db = adapter === "SQLite" ? openLedgerDb(join(directory, "ledger.db")) : null;
  if (db !== null) ensureSchema(db);
  const cohorts = db === null ? createInMemoryWorkCohortStore() : await createSqliteWorkCohortStore(db);
  const { plan, source } = await investigationPlanFixture(cohorts);
  const snapshot = await source.resolveExactSnapshot({ memberRefs: plan.members.map((member) => member.defectRef) });
  const admissionPlan = { kind: "cq-cohort-admission-plan" as const, version: 1 as const,
    members: snapshot.members.map((member) => ({ memberRef: member.memberRef, boundaryCandidates: member.boundaryCandidates })) };
  const dispatch = createDispatchCapability({ backend, promptArtifactStore: artifacts(),
    now: () => INVESTIGATION_NOW, randomBytes: sequentialDispatchRandomBytes() });
  const workset = createInMemoryWorksetStore();
  await workset.setRoots(["defects:D1", "defects:D2"]);
  const manual = new ManualProbeRunner();
  const commands = adapter === "memory" ? manual : createNodeSupervisedWorkerCommandRunner({ settleProcessGroups, settleWorktreeGateCommands });
  const options = { cohorts, backend, dispatch, promptArtifacts: artifacts(), repositoryRoot: directory,
    journalRoot: join(directory, "private"), cancellationSignal: new AbortController().signal, commands, workset,
    source: () => source, hypothesisStatement: () => plan.members[0]!.statement };
  const make = () => createInvestigationAdvanceCapabilityV1(options);
  const prepare = COHORT_INVESTIGATION_ADVANCE_SCHEMA.parse({ operation: "prepare", admissionPlan,
    definitionDigest: plan.definition.definitionDigest, operationId: "parent-investigation",
    members: plan.members.map(({ defectRef, branchContext, leads }) => ({ defectRef, branchContext, leads })) });
  const consume = async (launch: CohortInvestigationAdvanceResultV1["launches"][number], probe: boolean, commandEvidence: string | null) => {
    await dispatch.fetchInput({ ...launch.investigation.handle, inputCapability: launch.prepared.inputCapability });
    await dispatch.storeResult({ resultCapability: launch.prepared.resultCapability,
      output: { hypothesisId: launch.investigation.binding.member.hypothesisRef.slice("hypothesis:".length),
        evidence: [{ n: 1, citation: commandEvidence === null ? "src/cause.ts:1" : "confirmed-command",
          excerpt: commandEvidence === null ? "confirmed" : commandEvidence, relevance: "Member-specific source and execution" }],
        lean: probe ? "insufficient" : "supports", ...(probe ? { probeRequest: { what: "explicit approved command", why: "discriminates cause" } } : {}) } as DispatchJSONValue });
    await dispatch.confirmCompletion({ ...launch.investigation.handle, expectedProvenance: launch.investigation.provenance,
      nativeCompletion: { kind: "native-completion", actor: "trusted-parent", ...launch.investigation.expectedChild, completedAt: INVESTIGATION_NOW } });
  };
  return { make, prepare, consume, cohorts, directory, manual, workset, plan,
    close: async () => { await backend.close(); db?.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const adapter of ["memory", "SQLite"] as const) describe(`parent investigation ${adapter} [Behavioral-Active Blackbox-${adapter === "memory" ? "Group" : "GoodCommunication"}]`, () => {
  test("epoch recovery after private lease publication starts the first durable run without inventing consumed work", async () => {
    const f = await fixture(adapter);
    const acquire = f.cohorts.acquireLeaseAndPublish.bind(f.cohorts);
    try {
      f.cohorts.acquireLeaseAndPublish = async (input, publish) => {
        await acquire(input, publish);
        throw new Error("interrupted after private investigation lease publication");
      };
      await expect(f.make().advance(f.prepare)).rejects.toThrow("interrupted after private investigation lease publication");
      f.cohorts.acquireLeaseAndPublish = acquire;
      expect((await f.cohorts.snapshot()).portable.investigationRuns).toHaveLength(0);
      await f.cohorts.beginNewExecutionEpoch();
      const resumed = await f.make().advance({ operation: "resume", planDigest: f.plan.planDigest });
      expect(resumed.state).toBe("awaiting-launch");
      expect(resumed.launches).toHaveLength(2);
      expect(resumed.run.members.every((member) => member.explorerResult === null && member.proberResult === null && member.adjudication === null)).toBe(true);
    } finally { f.cohorts.acquireLeaseAndPublish = acquire; await f.close(); }
  });

  test("production factory derives statements and revisions from canonical owned primary hypotheses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-investigation-primary-"));
    await mkdir(join(directory, ".state"));
    const primary = adapter === "memory" ? new InMemoryLedgerStore() : new SqliteLedgerStore({ dbPath: join(directory, ".state", "ledger.db") });
    await primary.init();
    const backend = new InMemoryAttestationBackend(new InMemoryAttestationStore({ backend: "xdg", projectKey: "primary-investigation" }));
    try {
      for (const args of [["init", directory], ["-C", directory, "config", "user.email", "fixture@example.invalid"], ["-C", directory, "config", "user.name", "Fixture"], ["-C", directory, "config", "commit.gpgsign", "false"]]) {
        const run = Bun.spawnSync(["git", ...args]); if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      }
      await writeFile(join(directory, "contract.ts"), "export interface CohortContract { value: string }\n");
      await writeFile(join(directory, ".gitignore"), ".state/\n");
      Bun.spawnSync(["git", "-C", directory, "add", "."]);
      const committed = Bun.spawnSync(["git", "-C", directory, "commit", "-m", "fixture"]);
      if (committed.exitCode !== 0) throw new Error(committed.stderr.toString());
      await primary.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "Investigate", description: "Actual parent ownership" } });
      const guarded = createWorksetOwnedGuardedLedger({ rawStore: primary, worksetStore: primary.worksetStore(),
        invocationAuthority: createTrustedWorksetManagementAuthority(), runOwnedTransaction: (mutate, context) => primary.runAtomicOwnedMutation(mutate, context) });
      const members = [];
      const command = { argv: ["bun", "run", "check"], cwd: "nix/pkg/cq-ledgers", environment: [] };
      for (let index = 0; index < 2; index++) {
        const defect = await guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "review-filed-defect",
          child: { ledgerId: "defects", status: "open", fields: { headline: "Shared cause", severity: "high", sourceRefs: ["contract.ts"] } } });
        const hypothesis = await guarded.owned.createOwned({ owner: { ledgerId: "defects", itemId: defect.child.id }, creationKind: "hypothesis",
          child: { ledgerId: "hypothesis", status: "uncertain", fields: { headline: `Canonical hypothesis ${index}`, sourceRefs: ["contract.ts"] } } });
        members.push({ memberRef: `defects:${defect.child.id}`, investigationHypothesisRef: `hypothesis:${hypothesis.child.id}`,
          boundaryCandidates: [{ witness: { kind: "repository-node" as const, nodeKind: "versioned-contract" as const,
            nodeIdentity: "contract#CohortContract", sourcePath: "contract.ts", memberPath: ["contract.ts"] },
            sharedRegression: createCohortCommandBoundaryV1(command), canonicalFullGate: createCohortCommandBoundaryV1(command),
            reviewerClass: { identity: "review", digest: digest("review") }, deploymentClass: { identity: "none", digest: digest("none") },
            finalizationClass: { identity: "investigate", digest: digest("investigate") }, splitConditions: [],
            focusedCommand: { argv: ["bun", "test"], cwd: ".", environment: {}, provenance: { sourceRef: "contract.ts", sourceRevision: digest("source") } } }] });
      }
      await primary.worksetStore().setRoots(["goals:G1"]);
      const resolved = { store: primary, configRoot: directory, backend: "xdg" as const, branch: "cq-backup", dbPath: join(directory, ".state", "ledger.db") };
      const observation = await createCohortAdvanceRuntimeV1({ resolved, promptArtifacts: artifacts() });
      const admissionPlan = { kind: "cq-cohort-admission-plan" as const, version: 1 as const, members };
      const observed = await observation!.observe({ plan: admissionPlan, operationId: "observe-primary" });
      expect(observed.definitions.length).toBe(1);
      const dispatch = createDispatchCapability({ backend, promptArtifactStore: artifacts(), now: () => INVESTIGATION_NOW, randomBytes: sequentialDispatchRandomBytes() });
      const runtime = await createCohortInvestigationAdvanceRuntimeV1({ resolved, backend, dispatch, promptArtifacts: artifacts(),
        cancellationSignal: new AbortController().signal });
      const prepared = await runtime!.advance({ operation: "prepare", admissionPlan, definitionDigest: observed.definitions[0]!.definitionDigest,
        operationId: "prepare-primary", members: members.map((member) => ({ defectRef: member.memberRef, branchContext: "Inspect exact source", leads: [] })) });
      expect(prepared.run.plan.members.map((member) => member.statement)).toEqual(["Canonical hypothesis 0", "Canonical hypothesis 1"]);
      expect(prepared.launches.length).toBe(2);
      const authority = await runtime!.resolveLaunchAuthority(prepared.launches[0]!.investigation.handle);
      expect(authority).toMatchObject({ roleId: "investigate-explorer", memberRef: members[0]!.memberRef });
      expect(authority!.members.map((member) => member.defectRef)).toEqual(members.map((member) => member.memberRef));
      await primary.updateItem("hypothesis", prepared.run.plan.members[0]!.hypothesisRef.slice("hypothesis:".length), { fields: { description: "changed after preparation" } });
      await expect(runtime!.resolveLaunchAuthority(prepared.launches[0]!.investigation.handle)).rejects.toThrow("observation changed");
    } finally { await backend.close(); await primary.dispose(); await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  test("prepared refs survive runtime recreation; only consumed distinct members reach explicit adjudication", async () => {
    const f = await fixture(adapter);
    try {
      const prepared = await f.make().advance(f.prepare);
      expect(prepared.state).toBe("awaiting-launch");
      expect(prepared.launches.length).toBe(2);
      expect(prepared.run.members.every((member) => member.explorerResult === null)).toBe(true);
      const beforeResume = await f.make().resolveLaunchAuthority(prepared.launches[0]!.investigation.handle);
      expect(beforeResume!.members.length).toBe(2);
      await f.cohorts.beginNewExecutionEpoch();
      await expect(f.make().resolveLaunchAuthority(prepared.launches[0]!.investigation.handle)).rejects.toThrow("execution epoch");
      const resumed = await f.make().advance({ operation: "resume", planDigest: prepared.planDigest });
      expect(resumed.launches.map(({ nativeBinding: _binding, ...launch }) => launch)).toEqual(
        prepared.launches.map(({ nativeBinding: _binding, ...launch }) => launch));
      expect(resumed.launches.every((launch) => launch.nativeBinding.executionEpoch !== beforeResume!.executionEpoch)).toBe(true);
      const afterResume = await f.make().resolveLaunchAuthority(prepared.launches[0]!.investigation.handle);
      expect(afterResume!.executionEpoch).not.toBe(beforeResume!.executionEpoch);
      const repeated = await f.make().advance({ operation: "collect", planDigest: prepared.planDigest });
      expect(repeated.launches).toEqual(resumed.launches);
      for (const launch of prepared.launches) await f.consume(launch, false, null);
      const collected = await f.make().advance({ operation: "collect", planDigest: prepared.planDigest });
      expect(collected.state).toBe("awaiting-adjudication");
      expect(collected.adjudicationRequests.length).toBe(2);
      expect(collected.run.members.every((member) => member.confirmedCause === null)).toBe(true);
      const state = (await f.cohorts.snapshot()).portable;
      const atom = state.observations[0]!.atoms[0]!.atomDigest;
      const members = collected.adjudicationRequests.map((request) => ({ ...request,
        adjudication: { verdict: "confirmed" as const, rationale: "Independent consumed member evidence establishes this cause",
          causeDigest: digest("cause"), correctionBoundaryDigest: digest("boundary"), implementationAtomDigests: [atom] } }));
      await expect(f.make().advance({ operation: "adjudicate", planDigest: prepared.planDigest,
        members: [{ ...members[0]!, evidenceDigest: digest("unrelated") }] })).rejects.toThrow("exact complete member evidence");
      const complete = await f.make().advance({ operation: "adjudicate", planDigest: prepared.planDigest, members });
      expect(complete.state).toBe("correction-ready");
      expect(new Set(complete.run.members.map((member) => member.confirmedCause!.receiptDigest)).size).toBe(2);
      await f.cohorts.beginNewExecutionEpoch();
      await expect(f.make().advance({ operation: "collect", planDigest: prepared.planDigest })).rejects.toThrow("explicit resume");
      expect((await f.make().advance({ operation: "resume", planDigest: prepared.planDigest })).state).toBe("correction-ready");
    } finally { await f.close(); }
  }, 30_000);
  test("native admission rejects any omitted workset member and wire proof injection", async () => {
    const f = await fixture(adapter);
    try {
      const prepared = await f.make().advance(f.prepare);
      const authority = await f.make().resolveLaunchAuthority(prepared.launches[0]!.investigation.handle);
      await f.workset.setRoots(["defects:D1"]);
      await expect(authority!.provider.acquire({ kind: "child-dispatch", targetRef: authority!.targetRef })).rejects.toThrow();
      expect(COHORT_INVESTIGATION_ADVANCE_SCHEMA.safeParse({ operation: "collect", planDigest: prepared.planDigest,
        lease: { capability: "forged" } }).success).toBe(false);
      expect(COHORT_INVESTIGATION_ADVANCE_SCHEMA.safeParse({ operation: "probe", planDigest: prepared.planDigest,
        preparedDigest: prepared.launches[0]!.investigation.preparedDigest, citation: "command", command: { argv: ["true"], cwd: ".", environment: {} },
        result: { exitCode: 0 } }).success).toBe(false);
    } finally { await f.close(); }
  });
  test("lost derived native index is reconstructed from the retained prepared journal", async () => {
    const f = await fixture(adapter);
    try {
      const prepared = await f.make().advance(f.prepare);
      const handle = prepared.launches[0]!.investigation.handle;
      await rm(join(f.directory, "private", "cohort-investigation-dispatches", `${digest(handle)}.json`));
      await f.make().advance({ operation: "collect", planDigest: prepared.planDigest });
      expect(await f.make().resolveLaunchAuthority(handle)).not.toBeNull();
    } finally { await f.close(); }
  });
  test("explicit probe executes under all-member admission and supplies authenticated command output", async () => {
    const f = await fixture(adapter);
    try {
      const prepared = await f.make().advance(f.prepare);
      for (const launch of prepared.launches) await f.consume(launch, true, null);
      const probing = await f.make().advance({ operation: "collect", planDigest: prepared.planDigest });
      expect(probing.launches.length).toBe(2);
      for (const launch of probing.launches) {
        const input = { operation: "probe" as const, planDigest: prepared.planDigest,
          preparedDigest: launch.investigation.preparedDigest, citation: "confirmed-command",
          command: { argv: [process.execPath, "-e", 'process.stdout.write("confirmed")'], cwd: ".", environment: {} } };
        const probed = await f.make().advance(input);
        const receipt = probed.probeEvidence.find((entry) => entry.preparedDigest === input.preparedDigest)!;
        expect(receipt.completeOutput).toBe("confirmed\n");
        expect(receipt.outputDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect((await f.make().advance(input)).probeEvidence).toEqual(probed.probeEvidence);
        await f.consume(launch, false, receipt.completeOutput);
      }
      const collected = await f.make().advance({ operation: "collect", planDigest: prepared.planDigest });
      expect(collected.state).toBe("awaiting-adjudication");
      expect(collected.run.members.every((member) => member.proberResult !== null)).toBe(true);
      expect(collected.probeEvidence.length).toBe(2);
    } finally { await f.close(); }
  }, 30_000);
  test("truncated diagnostics never substitute for unavailable complete command evidence", async () => {
    const f = await fixture(adapter);
    try {
      const prepared = await f.make().advance(f.prepare);
      for (const launch of prepared.launches) await f.consume(launch, true, null);
      const probing = await f.make().advance({ operation: "collect", planDigest: prepared.planDigest });
      const launch = probing.launches[0]!;
      const size = IMPLEMENT_WORKER_SUPERVISED_GATE_REJECTION_TAIL_BYTE_LIMIT * 2;
      f.manual.output = `${"x".repeat(size)}\n`;
      const probed = await f.make().advance({ operation: "probe", planDigest: prepared.planDigest,
        preparedDigest: launch.investigation.preparedDigest, citation: "confirmed-command",
        command: { argv: [process.execPath, "-e", `process.stdout.write("x".repeat(${size}))`], cwd: ".", environment: {} } });
      expect(probed.probeEvidence[0]!.completeOutput).toBeNull();
      expect(probed.probeEvidence[0]!.outputTail.length).toBeGreaterThan(0);
      await f.consume(launch, false, probed.probeEvidence[0]!.outputTail);
      const rejected = await f.make().advance({ operation: "collect", planDigest: prepared.planDigest });
      expect(rejected.state).toBe("split");
      expect(rejected.run.split!.detail).toContain("unavailable range");
      expect((await f.cohorts.snapshot()).portable.investigationRuns.at(-1)!.members[0]!.confirmedCause).toBeNull();
    } finally { await f.close(); }
  }, 30_000);
});
