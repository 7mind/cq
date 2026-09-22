import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPATCH_TIMEOUT_MIN_MS, investigateExplorerSidecar, investigateProberSidecar, serializePromptSurfaceManifest, withoutWorksetCredentials } from "@cq/config";
import { createLedgerStore, SqliteLedgerStore, createWorksetOwnedGuardedLedger, createTrustedWorksetManagementAuthority,
  createCohortCommandBoundaryV1, createNodeSupervisedWorkerCommandRunner, settleProcessGroups, settleWorktreeGateCommands } from "@cq/ledger";
import { FileSystemPromptArtifactStore, createSingleProjectDispatchRuntime, createCohortInvestigationAdvanceRuntimeV1 } from "@cq/ledger-mcp";
import { createCohortAdvanceRuntimeV1 } from "../../ledger-mcp/src/workCohortAdvanceRuntime.js";
import { cohortValueDigestV1 as digest, createProcessWorksetEffectAdmissionProvider, investigationCohortEffectTargetRefV1 } from "@cq/process-control";
import { cohortBrokerGit } from "../../ledger/test/workCohortGitBrokerFixture.js";
import { useIsolatedXdgState, writeXdgConfig } from "./xdgFixture.js";

useIsolatedXdgState();
const cli = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cq-investigation-native-"));
  await writeXdgConfig(root);
  await writeFile(join(root, "contract.ts"), "export interface CommonCause { value: string }\n");
  await writeFile(join(root, ".gitignore"), ".cache/\n");
  await cohortBrokerGit(root, ["init", "-q", "-b", "main"]);
  await cohortBrokerGit(root, ["config", "user.name", "Investigation provider"]);
  await cohortBrokerGit(root, ["config", "user.email", "provider@example.invalid"]);
  await cohortBrokerGit(root, ["config", "commit.gpgsign", "false"]);
  await cohortBrokerGit(root, ["add", "."]);
  await cohortBrokerGit(root, ["commit", "-qm", "seed"]);
  const promptRoot = join(root, ".cache", "prompts");
  await mkdir(join(promptRoot, "roles"), { recursive: true });
  await mkdir(join(promptRoot, "schemas"));
  const roles = [];
  const catalog = [];
  for (const sidecar of [investigateExplorerSidecar, investigateProberSidecar]) {
    const prompt = `Investigate exactly this hypothesis with cited evidence: ${sidecar.id}.\n`;
    const schema = JSON.stringify(sidecar);
    await writeFile(join(promptRoot, "roles", `${sidecar.id}.md`), prompt);
    await writeFile(join(promptRoot, "schemas", `${sidecar.id}.json`), schema);
    catalog.push({ roleId: sidecar.id, roleKind: "dispatched-subagent", sidecar: { schemaRoleId: sidecar.id } });
    roles.push({ roleId: sidecar.id, version: sidecar.version, sha256: sha256(prompt), schemaSha256: sha256(schema) });
  }
  const catalogBytes = JSON.stringify(catalog);
  await writeFile(join(promptRoot, "catalog.json"), catalogBytes);
  await writeFile(join(promptRoot, "surface.json"), serializePromptSurfaceManifest("codex", sha256(catalogBytes), roles));
  const promptArtifacts = new FileSystemPromptArtifactStore("codex", promptRoot);
  const resolved = await createLedgerStore(root);
  const store = resolved.store;
  if (!(store instanceof SqliteLedgerStore)) throw new Error("fixture requires the actual SQLite primary");
  const dispatch = await createSingleProjectDispatchRuntime({ construction: "stdio", resolved, promptArtifactStore: promptArtifacts, environment: process.env });
  if (dispatch.kind !== "available" || store.workCohortStore === undefined || store.worksetStore === undefined) throw new Error("fixture runtime unavailable");
  await store.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "Native investigations", description: "Shared source" } });
  const guarded = createWorksetOwnedGuardedLedger({ rawStore: store, worksetStore: store.worksetStore(), invocationAuthority: createTrustedWorksetManagementAuthority(),
    runOwnedTransaction: (mutate, context) => store.runAtomicOwnedMutation(mutate, context) });
  const members = [];
  for (let index = 0; index < 2; index++) {
    const defect = await guarded.owned.createOwned({ owner: { ledgerId: "goals", itemId: "G1" }, creationKind: "review-filed-defect",
      child: { ledgerId: "defects", status: "open", fields: { headline: "Shared cause", severity: "high", sourceRefs: ["contract.ts"] } } });
    const hypothesis = await guarded.owned.createOwned({ owner: { ledgerId: "defects", itemId: defect.child.id }, creationKind: "hypothesis",
      child: { ledgerId: "hypothesis", status: "uncertain", fields: { headline: `Hypothesis ${index}`, sourceRefs: ["contract.ts"] } } });
    const command = { argv: ["bun", "run", "check"], cwd: "nix/pkg/cq-ledgers", environment: [] };
    members.push({ memberRef: `defects:${defect.child.id}`, investigationHypothesisRef: `hypothesis:${hypothesis.child.id}`,
      boundaryCandidates: [{ witness: { kind: "repository-node" as const, nodeKind: "versioned-contract" as const,
        nodeIdentity: "contract#CommonCause", sourcePath: "contract.ts", memberPath: ["contract.ts"] },
        sharedRegression: createCohortCommandBoundaryV1(command), canonicalFullGate: createCohortCommandBoundaryV1(command),
        reviewerClass: { identity: "review", digest: digest("review") }, deploymentClass: { identity: "none", digest: digest("none") },
        finalizationClass: { identity: "investigate", digest: digest("investigate") }, splitConditions: [],
        focusedCommand: { argv: ["bun", "test"], cwd: ".", environment: {}, provenance: { sourceRef: "contract.ts", sourceRevision: digest("source") } } }] });
  }
  await store.worksetStore().setRoots(["goals:G1"]);
  const admissionPlan = { kind: "cq-cohort-admission-plan" as const, version: 1 as const, members };
  const observer = await createCohortAdvanceRuntimeV1({ resolved, promptArtifacts });
  const observed = await observer!.observe({ plan: admissionPlan, operationId: "observe-native" });
  const runtime = await createCohortInvestigationAdvanceRuntimeV1({ resolved, backend: dispatch.backend, dispatch: dispatch.capability,
    promptArtifacts, cancellationSignal: new AbortController().signal });
  const prepared = await runtime!.advance({ operation: "prepare", admissionPlan, definitionDigest: observed.definitions[0]!.definitionDigest,
    operationId: "prepare-native", members: members.map((member) => ({ defectRef: member.memberRef, branchContext: "Inspect source", leads: [] })) });
  const launch = prepared.launches[0]!;
  const binding = launch.nativeBinding;
  const options = { command: process.execPath, args: [cli, "__workset-effect-provider", "--cwd", root], cwd: root,
    env: { ...process.env, CQ_PROMPT_ROOT: promptRoot, CQ_PROMPT_SURFACE: "codex" }, investigationCohort: binding };
  const request = { kind: "child-dispatch" as const, targetRef: investigationCohortEffectTargetRefV1(binding) };
  if (resolved.dbPath === undefined) throw new Error("fixture lacks durable state path");
  return { root, promptRoot, stateDir: dirname(resolved.dbPath), store, dispatch: dispatch.capability, launch, binding, options, request, cohorts: store.workCohortStore(), runtime: runtime!,
    close: async () => { await dispatch.close(); await store.dispose(); await rm(root, { recursive: true, force: true }); } };
}

describe("investigation cohort native process admission [Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("a known cohort dispatch cannot omit its metadata and downgrade to one defect", async () => {
    const f = await fixture();
    try {
      const { investigationCohort: _binding, ...base } = f.options;
      const provider = createProcessWorksetEffectAdmissionProvider({ ...base,
        investigationDispatch: { roleId: f.binding.roleId, handle: f.binding.handle } });
      let accepted = false;
      try {
        const admission = await provider.acquire({ kind: "child-dispatch", targetRef: f.binding.memberRef });
        accepted = true;
        await admission.abandonBeforeRegistration();
      } catch { /* Expected fail-closed admission. */ }
      expect(accepted).toBe(false);
      await rm(join(f.stateDir, "cohort-investigation-dispatches", `${digest(f.binding.handle)}.json`));
      let acceptedAfterIndexLoss = false;
      try {
        const admission = await provider.acquire({ kind: "child-dispatch", targetRef: f.binding.memberRef });
        acceptedAfterIndexLoss = true;
        await admission.abandonBeforeRegistration();
      } catch { /* The durable preparation remains authoritative without its derived index. */ }
      expect(acceptedAfterIndexLoss).toBe(false);
      const single = await f.dispatch.prepare({ roleId: f.binding.roleId, input: f.launch.investigation.binding.input,
        idempotencyKey: "independent-singleton", timeoutMs: DISPATCH_TIMEOUT_MIN_MS, expectedChild: { childId: "singleton", runId: "singleton-run" } });
      if (!single.accepted) throw new Error(JSON.stringify(single));
      const singleton = createProcessWorksetEffectAdmissionProvider({ ...base,
        investigationDispatch: { roleId: f.binding.roleId, handle: single.handle } });
      const singletonAdmission = await singleton.acquire({ kind: "child-dispatch", targetRef: f.binding.memberRef });
      expect(singletonAdmission.targetRef).toBe(f.binding.memberRef);
      await singletonAdmission.abandonBeforeRegistration();
    } finally { await f.close(); }
  }, 30_000);
  test("actual SQLite sidecar authenticates a complete prepared investigation and runs a registered process", async () => {
    const f = await fixture();
    try {
      const runner = createNodeSupervisedWorkerCommandRunner({ settleProcessGroups, settleWorktreeGateCommands });
      const execution = await runner.run({ command: { argv: [process.execPath, "-e", 'process.stdout.write("investigation admitted")'], cwd: ".", environment: {} },
        worktreePath: f.root, admissionTimeoutMs: 10_000, executionTimeoutMs: 5_000, cancellationSignal: new AbortController().signal,
        effectAdmission: { provider: createProcessWorksetEffectAdmissionProvider(f.options), targetRef: f.request.targetRef } });
      expect(execution.gateExitCode).toBe(0);
      expect(execution.completeOutput).toContain("investigation admitted");
      expect(f.store.worksetStore!().activeAdmissionCount()).toBe(0);
    } finally { await f.close(); }
  }, 30_000);

  test("rejects substituted launch membership, revisions, handle, epoch and native identity before admission", async () => {
    const f = await fixture();
    try {
      const mutations = [
        { members: f.binding.members.slice(0, 1) }, { members: [...f.binding.members].reverse() },
        { members: f.binding.members.map((member, index) => index === 1 ? { ...member, hypothesisRevision: "f".repeat(64) } : member) },
        { handle: { ...f.binding.handle, generation: f.binding.handle.generation + 1 } },
        { executionEpoch: "substituted" }, { preparedDigest: "f".repeat(64) },
        { roleId: "investigate-prober" as const }, { memberRef: f.binding.members[1]!.defectRef },
        { expectedChild: { ...f.binding.expectedChild, runId: "substituted" } },
      ];
      for (const mutation of mutations) await expect(createProcessWorksetEffectAdmissionProvider({ ...f.options,
        investigationCohort: { ...f.binding, ...mutation } }).acquire(f.request)).rejects.toThrow();
      expect(f.store.worksetStore!().activeAdmissionCount()).toBe(0);
    } finally { await f.close(); }
  }, 30_000);

  test("current primary revision and complete workset admission are checked independently of wire metadata", async () => {
    const f = await fixture();
    try {
      await f.store.worksetStore!().setRoots([f.binding.members[0]!.defectRef]);
      await expect(createProcessWorksetEffectAdmissionProvider(f.options).acquire(f.request)).rejects.toThrow();
      await f.store.worksetStore!().setRoots(["goals:G1"]);
      await f.store.updateItem("hypothesis", f.binding.members[1]!.hypothesisRef.slice("hypothesis:".length), { fields: { description: "Changed after preparation" } });
      await expect(createProcessWorksetEffectAdmissionProvider(f.options).acquire(f.request)).rejects.toThrow();
      expect(f.store.worksetStore!().activeAdmissionCount()).toBe(0);
    } finally { await f.close(); }
  }, 30_000);

  test("guardian sharing rechecks the complete retained investigation epoch", async () => {
    const f = await fixture();
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { cwd: f.root, detached: true, stdout: "ignore", stderr: "ignore" });
    try {
      const admission = await createProcessWorksetEffectAdmissionProvider(f.options).acquire(f.request);
      try {
        const registration = { pgid: child.pid, leaderPid: child.pid };
        await admission.registerProcessGroup(registration);
        await f.cohorts.beginNewExecutionEpoch();
        await expect(admission.shareWithGuardian(registration)).rejects.toThrow();
      } finally { child.kill("SIGTERM"); await child.exited; await admission.markSettled(); await admission.releaseAfterSettlement(); }
      await expect(createProcessWorksetEffectAdmissionProvider(f.options).acquire(f.request)).rejects.toThrow();
      expect(f.store.worksetStore!().activeAdmissionCount()).toBe(0);
    } finally { child.kill("SIGTERM"); await child.exited; await f.close(); }
  }, 30_000);

  test("installed Codex script carries investigation authority into its real process provider", async () => {
    const f = await fixture();
    try {
      const cq = join(f.root, ".cache", "cq");
      const codex = join(f.root, ".cache", "codex");
      await writeFile(cq, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`);
      await writeFile(codex, `#!/usr/bin/env bun
const request = JSON.parse(await Bun.stdin.text());
const handle = { attestationId: request.attestationId, generation: request.generation };
const acknowledgement = { state: "result-stored", result: { state: "result-stored", ...handle, storedAt: "2026-09-22T00:00:00.000Z", outputDigest: "recording-only" } };
console.log(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "ledger", tool: "store_result", result: { content: [{ type: "text", text: JSON.stringify(acknowledgement) }] } } }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(handle) } }));
`);
      await chmod(cq, 0o755); await chmod(codex, 0o755);
      const invocation = { roleId: f.binding.roleId, handle: f.binding.handle, investigationCohort: f.binding,
        inputCapability: f.launch.prepared.inputCapability, resultCapability: f.launch.prepared.resultCapability,
        effectTargetRef: f.request.targetRef, cwd: f.root, ledgerCwd: f.root, model: "recording",
        reasoningEffort: "medium", sandboxMode: "danger-full-access", timeoutMs: 5_000 };
      const roleScript = fileURLToPath(new URL("../../cq-config/scripts/codex-role-dispatch.ts", import.meta.url));
      const { CQ_PROMPT_SURFACE: _surface, ...scriptEnvironment } = f.options.env;
      const child = Bun.spawn([process.execPath, roleScript], { cwd: f.root,
        env: { ...withoutWorksetCredentials(scriptEnvironment), CQ_CODEX_LEDGER_COMMAND: cq, CQ_CODEX_EXECUTABLE: codex },
        stdin: new Blob([`${JSON.stringify(invocation)}\n`]), stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual(f.binding.handle);
      expect(f.store.worksetStore!().activeAdmissionCount()).toBe(0);
    } finally { await f.close(); }
  }, 30_000);
});
