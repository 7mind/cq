import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutWorksetCredentials } from "@cq/config";
import { createLedgerStore, constructCohortDecisionsV1, createCohortDefinitionIdentityV1,
  createCohortCandidateIntentV1, createCohortEffectEnvelopeV1, prepareManagedCohortWorktree,
  resolveManagedCohortWorktreeDispatchBinding, runGuardedRebase, observeManagedWorktreeConflictState, gitRebaseConflictStateDigest,
  type ManagedCohortWorktreeAuthority } from "@cq/ledger";
import { cohortValueDigestV1, cohortEffectTargetRefV1, createProcessWorksetEffectAdmissionProvider } from "@cq/process-control";
import { cohortBrokerGit } from "../../ledger/test/workCohortGitBrokerFixture.js";
import { observationFor } from "../../ledger/test/workCohortFixture.js";
import { useIsolatedXdgState, writeXdgConfig } from "./xdgFixture.js";

useIsolatedXdgState();
const cli = fileURLToPath(new URL("../src/main.ts", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cq-cohort-provider-"));
  await writeXdgConfig(root);
  await writeFile(join(root, "bun.lock"), "{}\n");
  await writeFile(join(root, ".gitignore"), ".claude/\n.cache/\nnode_modules/\n");
  await cohortBrokerGit(root, ["init", "-q", "-b", "main"]);
  await cohortBrokerGit(root, ["config", "user.name", "Cohort provider"]);
  await cohortBrokerGit(root, ["config", "user.email", "cohort-provider@example.invalid"]);
  await cohortBrokerGit(root, ["config", "commit.gpgsign", "false"]);
  await cohortBrokerGit(root, ["add", "."]);
  await cohortBrokerGit(root, ["commit", "-q", "-m", "seed"]);
  const baseCommit = await cohortBrokerGit(root, ["rev-parse", "HEAD"]);
  const repositoryId = new Bun.CryptoHasher("sha256").update(`${root}\n${await cohortBrokerGit(root,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"] )}`).digest("hex");
  const resolved = await createLedgerStore(root);
  const store = resolved.store;
  if (store.workCohortStore === undefined || store.worksetStore === undefined) throw new Error("fixture lacks durable cohort/workset stores");
  const cohortStore = store.workCohortStore();
  const milestone = await store.createMilestone({ title: "Native cohort provider" });
  for (const taskId of ["T1", "T2"]) await store.createItem("tasks", milestone.id, { status: "planned", fields: { headline: taskId } });
  await store.worksetStore().setRoots(["tasks:T1", "tasks:T2"]);
  const observation = await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }], {
    repository: { repositoryId, headCommit: baseCommit, treeOid: await cohortBrokerGit(root, ["rev-parse", "HEAD^{tree}"]) },
  });
  const decision = constructCohortDecisionsV1(observation)[0]!;
  const definition = createCohortDefinitionIdentityV1({ cohortId: "native-provider", observation, decision, prior: null });
  const intent = createCohortCandidateIntentV1(definition, "native-provider-candidate");
  await cohortStore.recordObservation("observe", observation);
  await cohortStore.recordDecision("decide", decision);
  await cohortStore.recordDefinition("define", definition);
  await cohortStore.recordCandidateIntent("intent", intent);
  await cohortStore.transitionReservation("reserve", { reservationId: "native-provider", cohortId: definition.cohortId,
    definitionDigest: definition.definitionDigest, memberRefs: ["tasks:T1", "tasks:T2"], transition: "reserved" });
  const envelope = createCohortEffectEnvelopeV1({ definition, observation, intent, evidenceSubject: null,
    executionEpoch: (await cohortStore.snapshot()).runtime.executionEpoch });
  const authority: ManagedCohortWorktreeAuthority = { store: cohortStore, envelope,
    lease: await cohortStore.acquireLease({ holderId: "native-provider", semanticSubject: envelope.semanticSubject }) };
  const prepared = await prepareManagedCohortWorktree({ repositoryRoot: root, baseCommit, handle: null,
    priorResultCommit: null, integrationHead: baseCommit, dependencyReader: { readTaskSnapshots: async () =>
      ["T1", "T2"].map((taskId) => ({ taskId, status: "planned", dependsOn: [], resultCommit: null,
        archived: false, contributionKind: "git-producing" as const, operatorAction: null })) } },
  { skipInstall: true, bunWorkspaceRoot: root, cacheRoot: join(root, ".cache") }, authority);
  if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));
  return { root, store, cohortStore, envelope, authority, prepared, close: async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); } };
}

describe("full-cohort process provider control [Blackbox-GoodCommunication]", () => {
  test("detached resolver admission requires the exact pending cohort conflict digest", async () => {
    const subject = await fixture();
    try {
      const binding = await resolveManagedCohortWorktreeDispatchBinding(subject.prepared.handle, subject.authority, {}, false);
      if (binding === null) throw new Error("fixture manager binding missing");
      for (const [cwd, text] of [[binding.worktreePath, "candidate\n"], [subject.root, "integration\n"]] as const) {
        await writeFile(join(cwd, "change.txt"), text);
        await cohortBrokerGit(cwd, ["add", "change.txt"]);
        await cohortBrokerGit(cwd, ["commit", "-qm", "conflicting change"]);
      }
      const ontoCommit = await cohortBrokerGit(subject.root, ["rev-parse", "HEAD"]);
      expect((await runGuardedRebase({ binding, operationId: "resolver-provider", ontoCommit,
        cohortAuthority: subject.authority, store: subject.store })).kind).toBe("conflict-pending");
      const state = await observeManagedWorktreeConflictState(binding, { cohortAuthority: subject.authority });
      const options = { command: process.execPath, args: ["run", cli, "__workset-effect-provider", "--cwd", subject.root],
        cwd: subject.root, env: process.env, cohort: subject.envelope };
      const request = { kind: "child-dispatch" as const, targetRef: cohortEffectTargetRefV1(subject.envelope) };
      await expect(createProcessWorksetEffectAdmissionProvider(options).acquire(request)).rejects.toThrow();
      const resolverOptions = { ...options, cohortConflictStateDigest: gitRebaseConflictStateDigest(state), cohortRoleId: "implement-conflict-resolver" as const };
      expect(() => createProcessWorksetEffectAdmissionProvider({ ...options,
        cohortConflictStateDigest: resolverOptions.cohortConflictStateDigest })).toThrow("conflict-resolver binding");
      await expect(createProcessWorksetEffectAdmissionProvider(resolverOptions).acquire({ ...request, kind: "rebase" })).rejects.toThrow("child-dispatch only");
      const admission = await createProcessWorksetEffectAdmissionProvider(resolverOptions).acquire(request);
      await admission.abandonBeforeRegistration();
      expect(subject.store.worksetStore!().activeAdmissionCount()).toBe(0);
      await expect(createProcessWorksetEffectAdmissionProvider({ ...resolverOptions, cohortConflictStateDigest: "f".repeat(64) }).acquire(request)).rejects.toThrow();
    } finally { await subject.close(); }
  });
  test("installed role script carries a full cohort into the actual SQLite admission sidecar", async () => {
    const subject = await fixture();
    try {
      const promptRoot = join(subject.root, ".cache", "prompts");
      await mkdir(join(promptRoot, "roles"), { recursive: true });
      await writeFile(join(promptRoot, "roles", "implement-conflict-resolver.md"), "Preserve every member.\n");
      const cq = join(subject.root, ".cache", "cq");
      const codex = join(subject.root, ".cache", "codex");
      await writeFile(cq, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`);
      await writeFile(codex, `#!/usr/bin/env bun
const request = JSON.parse(await Bun.stdin.text());
const handle = { attestationId: request.attestationId, generation: request.generation };
const acknowledgement = { state: "result-stored", result: { state: "result-stored", ...handle,
  storedAt: "2026-09-22T00:00:00.000Z", outputDigest: "recording-provider-test" } };
console.log(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "ledger", tool: "store_result",
  result: { content: [{ type: "text", text: JSON.stringify(acknowledgement) }] } } }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(handle) } }));
`);
      await chmod(cq, 0o755);
      await chmod(codex, 0o755);
      const invocation = { roleId: "implement-conflict-resolver", handle: { attestationId: "native-cohort-script", generation: 1 },
        cohort: subject.envelope, effectTargetRef: cohortEffectTargetRefV1(subject.envelope),
        inputCapability: { scope: "fetch-input", token: "cq_input_script_test" },
        resultCapability: { scope: "store-result", token: "cq_result_script_test" },
        gitConflictCapability: { scope: "git-conflict", token: "cq_conflict_script_test" },
        cwd: subject.prepared.handle.absolutePath, ledgerCwd: subject.root,
        model: "recording", reasoningEffort: "medium", sandboxMode: "danger-full-access", timeoutMs: 5_000 };
      const roleScript = fileURLToPath(new URL("../../cq-config/scripts/codex-role-dispatch.ts", import.meta.url));
      const child = Bun.spawn([process.execPath, roleScript], { cwd: subject.root,
        env: { ...withoutWorksetCredentials(process.env), CQ_PROMPT_ROOT: promptRoot, CQ_CODEX_LEDGER_COMMAND: cq, CQ_CODEX_EXECUTABLE: codex },
        stdin: new Blob([`${JSON.stringify(invocation)}\n`]), stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual(invocation.handle);
      expect(subject.store.worksetStore!().activeAdmissionCount()).toBe(0);
    } finally { await subject.close(); }
  });

  test("actual SQLite sidecar resolves retained all-member authority and rejects a removed member or expired epoch", async () => {
    const subject = await fixture();
    try {
      const options = { command: process.execPath, args: ["run", cli, "__workset-effect-provider", "--cwd", subject.root],
        cwd: subject.root, env: process.env, cohort: subject.envelope };
      const provider = createProcessWorksetEffectAdmissionProvider(options);
      const request = { kind: "child-dispatch" as const, targetRef: cohortEffectTargetRefV1(subject.envelope) };
      const admission = await provider.acquire(request);
      expect(admission.targetRef).toBe(request.targetRef);
      await admission.abandonBeforeRegistration();
      await subject.store.worksetStore!().setRoots(["tasks:T1"]);
      await expect(provider.acquire(request)).rejects.toThrow();
      await subject.store.worksetStore!().setRoots(["tasks:T1", "tasks:T2"]);
      await subject.cohortStore.beginNewExecutionEpoch();
      await expect(provider.acquire(request)).rejects.toThrow();
    } finally { await subject.close(); }
  });

  test("controlled IPC receives the exact envelope once and never a retained lease", async () => {
    const subject = await fixture();
    try {
      const transcript = join(subject.root, "provider.jsonl");
      const control = fileURLToPath(new URL("../../process-control/test/processWorksetEffectAdmissionProviderFixture.ts", import.meta.url));
      const options = { command: process.execPath, args: ["run", control], cwd: subject.root,
        env: { ...process.env, CQ_TEST_PROVIDER_TRANSCRIPT: transcript }, cohort: subject.envelope };
      const provider = createProcessWorksetEffectAdmissionProvider(options);
      const targetRef = cohortEffectTargetRefV1(subject.envelope);
      const admission = await provider.acquire({ kind: "child-dispatch", targetRef });
      await admission.abandonBeforeRegistration();
      const rows = (await Bun.file(transcript).text()).trim().split("\n").map((line) => JSON.parse(line));
      expect(rows).toEqual([{ op: "acquire", kind: "child-dispatch", targetRef, cohort: subject.envelope }, { op: "abandon" }]);
      expect(cohortValueDigestV1(rows[0].cohort)).toBe(cohortValueDigestV1(subject.envelope));
      expect(JSON.stringify(rows)).not.toContain("lease");
    } finally { await subject.close(); }
  });

  test("guardian sharing rechecks the retained cohort lease after process registration", async () => {
    const subject = await fixture();
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"],
      { cwd: subject.root, detached: true, stdout: "ignore", stderr: "ignore" });
    try {
      const provider = createProcessWorksetEffectAdmissionProvider({ command: process.execPath,
        args: ["run", cli, "__workset-effect-provider", "--cwd", subject.root], cwd: subject.root,
        env: process.env, cohort: subject.envelope });
      const admission = await provider.acquire({ kind: "child-dispatch", targetRef: cohortEffectTargetRefV1(subject.envelope) });
      try {
        const registration = { pgid: child.pid, leaderPid: child.pid };
        await admission.registerProcessGroup(registration);
        await subject.cohortStore.beginNewExecutionEpoch();
        await expect(admission.shareWithGuardian(registration)).rejects.toThrow();
      } finally {
        child.kill("SIGTERM");
        await child.exited;
        await admission.markSettled();
        await admission.releaseAfterSettlement();
      }
      expect(subject.store.worksetStore!().activeAdmissionCount()).toBe(0);
    } finally { child.kill("SIGTERM"); await child.exited; await subject.close(); }
  });
});
