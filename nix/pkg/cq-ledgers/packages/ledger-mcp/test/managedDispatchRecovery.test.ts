import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DispatchHandle,
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  sequentialDispatchRandomBytes,
} from "@cq/config";
import {
  FsCurrentRecoverySealJournalStore,
  InMemoryCurrentRecoverySealJournalStore,
  InMemoryLedgerStore,
  WORKTREE_MANAGE_TOOL_SPEC,
  createCurrentRecoverySeal,
  createDispatchLineageCutoverFence,
  prepareManagedWorktree,
  resolveInheritedGitChangeReceipts,
  resolveManagedWorktreeDispatchBinding,
  runGuardedRebase,
  type Item,
  type DispatchRecoveryResolution,
  type ManagedWorktreeHandle,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const TASK_ID = "T6473";
const NOW = "2026-09-14T08:00:00.000Z";
const TEST_TIMEOUT_MS = 30_000;
const PRE_EEC3_PRODUCER_COMMIT = "853eeae05037de6f8c6710c125fa00d9aa028760";

interface PersistedDigestProduceConfig {
  readonly action: "produce";
  readonly caseRoot: string;
  readonly expected: "digest-mismatch" | "success";
}

interface PersistedDigestRecoverConfig {
  readonly action: "recover";
  readonly caseRoot: string;
  readonly expected: "digest-mismatch" | "success";
  readonly managedHandle: ManagedWorktreeHandle;
  readonly sourceHandle: DispatchHandle;
  readonly sourceTip: string;
}

interface PersistedDigestProduced {
  readonly runtimeRoot: string;
  readonly runtimeSourceDigest: string;
  readonly managedHandle: ManagedWorktreeHandle;
  readonly sourceHandle: DispatchHandle;
  readonly sourceTip: string;
  readonly recoverySeedRef: string;
  readonly rowCount: number;
  readonly rowDigest: string;
  readonly journalDigest: string;
}

interface PersistedDigestRecovered {
  readonly runtimeRoot: string;
  readonly runtimeSourceDigest: string;
  readonly outcome: "rejected" | "resolved";
  readonly reason?: string;
  readonly message?: string;
  readonly status?: string;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly rowDigest: string;
  readonly journalDigest?: string;
  readonly journalDigestBefore?: string;
  readonly journalDigestAfter?: string;
  readonly rowsByteIdentical: boolean;
  readonly journalByteIdentical: boolean;
}

async function runPersistedDigestProcess<T>(
  runtimeRoot: string,
  config: PersistedDigestProduceConfig | PersistedDigestRecoverConfig,
): Promise<T> {
  const fixturePath = join(
    runtimeRoot,
    "packages/ledger-mcp/test/fixtures/preEec3PersistedPrepareDigestProcess.ts",
  );
  const child = Bun.spawn([process.execPath, fixturePath], {
    cwd: runtimeRoot,
    env: { ...process.env, CQ_H392_PROCESS_CONFIG: JSON.stringify(config) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(
      `persisted digest process failed in ${runtimeRoot}: code=${String(code)} stderr=${stderr} stdout=${stdout}`,
    );
  }
  return JSON.parse(stdout.trim()) as T;
}

async function materializePersistedDigestRuntime(currentRoot: string): Promise<string> {
  const runtimeRoot = await fs.mkdtemp(join(tmpdir(), "h392-pre-eec3-runtime-"));
  const archivePath = join(runtimeRoot, "producer.tar");
  const repositoryRoot = await fs.realpath(join(currentRoot, "../../.."));
  const archive = Bun.spawn(
    [
      "git",
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      `${PRE_EEC3_PRODUCER_COMMIT}:nix/pkg/cq-ledgers`,
    ],
    { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
  );
  const [archiveCode, archiveError] = await Promise.all([
    archive.exited,
    new Response(archive.stderr).text(),
  ]);
  if (archiveCode !== 0) throw new Error(`old producer archive failed: ${archiveError}`);
  const extract = Bun.spawn(["tar", "-xf", archivePath, "-C", runtimeRoot], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [extractCode, extractError] = await Promise.all([
    extract.exited,
    new Response(extract.stderr).text(),
  ]);
  if (extractCode !== 0) throw new Error(`old producer extraction failed: ${extractError}`);
  await fs.unlink(archivePath);
  const fixturePath = "packages/ledger-mcp/test/fixtures/preEec3PersistedPrepareDigestProcess.ts";
  await fs.mkdir(join(runtimeRoot, "packages/ledger-mcp/test/fixtures"), { recursive: true });
  await fs.copyFile(join(currentRoot, fixturePath), join(runtimeRoot, fixturePath));
  await fs.symlink(join(currentRoot, "node_modules"), join(runtimeRoot, "node_modules"), "dir");
  for (const packageName of ["cq-config", "process-control", "ledger", "ledger-mcp"]) {
    await fs.cp(
      join(currentRoot, "packages", packageName, "node_modules"),
      join(runtimeRoot, "packages", packageName, "node_modules"),
      { recursive: true, verbatimSymlinks: true },
    );
  }
  return runtimeRoot;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CQ recovery test",
      GIT_AUTHOR_EMAIL: "cq@example.invalid",
      GIT_COMMITTER_NAME: "CQ recovery test",
      GIT_COMMITTER_EMAIL: "cq@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

function artifactStore(): PromptArtifactStore {
  const metadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: "codex" as const,
    promptDigest: "a".repeat(64),
    schemaVersion: 10,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: "codex",
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  };
}

class RecoveryLedger extends InMemoryLedgerStore {
  override fetchItem(ledgerId: string, itemId: string): Item {
    if (ledgerId === "tasks" && itemId === TASK_ID)
      return {
        id: TASK_ID,
        milestoneId: "M1",
        status: "wip",
        createdAt: NOW,
        updatedAt: NOW,
        fields: {
          headline: "recover managed worker",
          description: "retain receipt closure",
          acceptance: "typed recovery authority",
          ledgerRefs: ["goals:G207"],
        },
      };
    if (ledgerId === "goals" && itemId === "G207")
      return {
        id: "G207",
        milestoneId: "M1",
        status: "planned",
        createdAt: NOW,
        updatedAt: NOW,
        fields: {
          title: "managed recovery",
          planFinalizedManifest: JSON.stringify({
            revision: 1,
            milestones: [{ key: "implementation", id: "M1" }],
            tasks: [{ key: "recovery", id: TASK_ID }],
          }),
        },
      };
    return super.fetchItem(ledgerId, itemId);
  }
}

async function fixture(journalKind: "memory" | "filesystem", advance: boolean) {
  const root = await fs.mkdtemp(join(tmpdir(), "t6473-managed-recovery-"));
  const ledgerStore = new RecoveryLedger();
  await ledgerStore.init();
  try {
    await git(root, ["init", "-q"]);
    await fs.writeFile(join(root, "state.txt"), "before\n");
    await git(root, ["add", "state.txt"]);
    await git(root, ["commit", "-q", "-m", "base"]);
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    const stateDir = join(root, ".manager-state");
    const managed = await prepareManagedWorktree(
      { repositoryRoot: root, taskId: TASK_ID, baseCommit },
      { stateDir, skipInstall: true, bunWorkspaceRoot: root },
    );
    if (managed.status !== "prepared") throw new Error(`unexpected ${managed.status}`);
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: root,
        taskId: TASK_ID,
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
      },
      { stateDir },
    );
    if (binding === null) throw new Error("missing managed binding");
    const journal =
      journalKind === "memory"
        ? new InMemoryCurrentRecoverySealJournalStore()
        : new FsCurrentRecoverySealJournalStore(stateDir);
    const store = new InMemoryAttestationStore({ backend: "xdg", projectKey: "t6473" });
    const backend = new InMemoryAttestationBackend(store);
    const makeCapability = () =>
      createDispatchCapability({
        backend,
        ledgerStore,
        repositoryRoot: root,
        worktreeStateDir: stateDir,
        recoveryJournal: journal,
        promptArtifactStore: artifactStore(),
        now: () => NOW,
        randomBytes: sequentialDispatchRandomBytes(6473),
      });
    const capability = makeCapability();
    const input = {
      taskId: TASK_ID,
      headline: "recover managed worker",
      description: "retain receipt closure",
      acceptance: "typed recovery authority",
      worktreePath: binding.worktreePath,
      branch: binding.branch,
      baseCommit,
      round: 0,
      startingCommit: baseCommit,
      validationIntent: "final",
    };
    const prepared = await capability.prepare({
      roleId: "implement-worker",
      input,
      idempotencyKey: "first-worker",
      timeoutMs: 600_000,
      expectedChild: { childId: "first-worker", runId: "first-worker" },
    });
    if (
      !prepared.accepted ||
      prepared.prepared.gitChangeCapability === undefined ||
      capability.gitCommit === undefined
    )
      throw new Error("worker lacks Git authority");
    await capability.fetchInput({
      ...prepared.handle,
      inputCapability: prepared.prepared.inputCapability,
    });
    let liveTip = baseCommit;
    if (advance) {
      await fs.writeFile(join(binding.worktreePath, "state.txt"), "after\n");
      const digest = (body: string) => createHash("sha256").update(body).digest("hex");
      const receipt = await capability.gitCommit({
        ...prepared.handle,
        gitChangeCapability: prepared.prepared.gitChangeCapability,
        operationId: "advance",
        expectedHead: baseCommit,
        message: "receipt-backed advance",
        changes: [
          {
            kind: "modify",
            path: "state.txt",
            oldState: { mode: "100644", digest: digest("before\n") },
            newState: { mode: "100644", digest: digest("after\n") },
          },
        ],
      });
      liveTip = receipt.newHead;
    }
    const resolveRecovery = () =>
      WORKTREE_MANAGE_TOOL_SPEC.run(
        ledgerStore,
        {
          repositoryRoot: root,
          deps: { stateDir },
          resolveDispatchRecovery: makeCapability().resolveRecovery!,
        },
        { operation: "resolve-dispatch-recovery", handle: managed.handle },
      );
    return {
      root,
      ledgerStore,
      binding,
      journal,
      store,
      backend,
      capability,
      prepared,
      input,
      liveTip,
      stateDir,
      managed,
      resolveRecovery,
      dispose: async () => {
        await ledgerStore.dispose();
        await fs.rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await ledgerStore.dispose();
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function missingResultRecovery(journalKind: "memory" | "filesystem", dirty: boolean) {
  const f = await fixture(journalKind, true);
  try {
    const receipts = await resolveInheritedGitChangeReceipts(
      { ...f.binding, ...f.prepared.handle },
      f.liveTip,
      { stateDir: f.stateDir },
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.newHead).toBe(f.liveTip);
    await f.capability.abort({ ...f.prepared.handle, reason: "missing-result" });
    await expect(f.capability.resolveRecovery!(f.binding, f.input.baseCommit)).rejects.toThrow(
      "tip changed",
    );
    expect(await f.journal.read(TASK_ID)).toBeNull();
    if (dirty)
      await fs.writeFile(join(f.binding.worktreePath, "state.txt"), "retained partial work\n");
    const before = await git(f.binding.worktreePath, ["status", "--porcelain"]);
    expect(before.length > 0).toBe(dirty);
    const wireResult = await f.resolveRecovery();
    const resolved = wireResult as unknown as DispatchRecoveryResolution;
    expect(resolved).toMatchObject({
      status: "dispatch-recovery-resolved",
      taskId: TASK_ID,
      liveTip: f.liveTip,
      preparation: { kind: "current" },
    });
    expect(await f.resolveRecovery()).toEqual(wireResult);
    expect(await git(f.binding.worktreePath, ["status", "--porcelain"])).toBe(before);
    expect(await fs.readFile(join(f.binding.worktreePath, "state.txt"), "utf8")).toBe(
      dirty ? "retained partial work\n" : "after\n",
    );
    expect(await f.capability.fetch(f.prepared.handle)).toMatchObject({
      state: "aborted",
      reason: "missing-result",
    });
    if (resolved.preparation.kind !== "current") throw new Error("expected current authority");
    expect(
      await f.capability.prepare({
        roleId: "implement-worker",
        input: {
          ...f.input,
          round: 1,
          startingCommit: f.liveTip,
          priorResultCommit: f.liveTip,
        },
        idempotencyKey: "lineage-free",
        timeoutMs: 600_000,
        expectedChild: { childId: "lineage-free", runId: "lineage-free" },
      }),
    ).toMatchObject({ accepted: false });
    const request = {
      roleId: "implement-worker",
      input: { ...f.input, round: 1, startingCommit: f.liveTip, priorResultCommit: f.liveTip },
      idempotencyKey: "recovered-worker",
      timeoutMs: 600_000,
      expectedChild: { childId: "recovered-worker", runId: "recovered-worker" },
      recoveryPreparation: resolved.preparation.recoveryPreparation,
    };
    const next = await f.capability.prepare(request);
    expect(next).toMatchObject({ accepted: true });
    expect(await f.capability.prepare(request)).toEqual(next);
    await expect(
      f.capability.prepare({ ...request, idempotencyKey: "reused-authority" }),
    ).rejects.toThrow("still live");
    await expect(f.resolveRecovery()).rejects.toThrow();
    if (!next.accepted) throw new Error("recovery successor was not prepared");
    await f.capability.abort({ ...next.handle, reason: "missing-result" });
    await expect(
      f.capability.prepare({ ...request, idempotencyKey: "reused-after-terminal" }),
    ).rejects.toThrow("already allocated a successor");
    const renewed = (await f.resolveRecovery()) as unknown as DispatchRecoveryResolution;
    if (renewed.preparation.kind !== "current") throw new Error("expected promoted authority");
    expect(renewed.preparation.recoveryPreparation.recoverySeedRef).not.toBe(
      resolved.preparation.recoveryPreparation.recoverySeedRef,
    );
    expect(
      await f.capability.prepare({
        ...request,
        idempotencyKey: "promoted-recovery",
        recoveryPreparation: renewed.preparation.recoveryPreparation,
      }),
    ).toMatchObject({ accepted: true });
  } finally {
    await f.dispose();
  }
}

async function guardedOriginRecovery(): Promise<void> {
  const f = await fixture("filesystem", true);
  try {
    await f.capability.abort({ ...f.prepared.handle, reason: "parent-lost" });
    await fs.writeFile(join(f.root, "protected.txt"), "protected head\n");
    await git(f.root, ["add", "protected.txt"]);
    await git(f.root, ["commit", "-q", "-m", "advance protected head"]);
    const ontoCommit = await git(f.root, ["rev-parse", "HEAD"]);
    const rebase = await runGuardedRebase({
      binding: f.binding,
      operationId: "t6573-guarded-origin-rebase",
      ontoCommit,
      stateDir: f.stateDir,
      runEffect: async () => {
        const child = Bun.spawn(["git", "rebase", ontoCommit], {
          cwd: f.binding.worktreePath,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "CQ recovery test",
            GIT_AUTHOR_EMAIL: "cq@example.invalid",
            GIT_COMMITTER_NAME: "CQ recovery test",
            GIT_COMMITTER_EMAIL: "cq@example.invalid",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      },
    });
    if (rebase.kind !== "finalized") throw new Error("guarded-origin rebase did not finalize");
    const rebasedStartCommit = rebase.bridge.rebasedStartCommit;
    const guarded = await f.capability.prepare({
      roleId: "implement-worker",
      input: {
        ...f.input,
        baseCommit: ontoCommit,
        round: 1,
        startingCommit: rebasedStartCommit,
        priorResultCommit: f.liveTip,
      },
      idempotencyKey: "guarded-origin-worker",
      timeoutMs: 600_000,
      expectedChild: { childId: "guarded-origin-worker", runId: "guarded-origin-worker" },
      reprepareOf: f.prepared.handle,
      guardedRebase: rebase.reference,
    });
    if (!guarded.accepted || guarded.prepared.gitChangeCapability === undefined) {
      throw new Error("guarded-origin worker was not prepared");
    }
    await f.capability.fetchInput({
      ...guarded.handle,
      inputCapability: guarded.prepared.inputCapability,
    });
    await fs.writeFile(join(f.binding.worktreePath, "state.txt"), "guarded recovery\n");
    if (f.capability.gitCommit === undefined) throw new Error("guarded-origin broker unavailable");
    const receipt = await f.capability.gitCommit({
      ...guarded.handle,
      gitChangeCapability: guarded.prepared.gitChangeCapability,
      operationId: "guarded-origin-change",
      expectedHead: rebasedStartCommit,
      message: "guarded-origin receipt",
      changes: [
        {
          kind: "modify",
          path: "state.txt",
          oldState: {
            mode: "100644",
            digest: createHash("sha256").update("after\n").digest("hex"),
          },
          newState: {
            mode: "100644",
            digest: createHash("sha256").update("guarded recovery\n").digest("hex"),
          },
        },
      ],
    });
    await f.capability.abort({ ...guarded.handle, reason: "missing-result" });
    const resolved = (await f.resolveRecovery()) as unknown as DispatchRecoveryResolution;
    if (resolved.preparation.kind !== "current") throw new Error("expected current authority");
    const authenticatedJournal = await f.journal.read(TASK_ID);
    expect(authenticatedJournal).toMatchObject({
      state: "committed",
      seal: {
        seed: {
          gitBinding: {
            baseCommit: f.input.baseCommit,
            guardedRebaseBridge: {
              guardedRebase: rebase.reference,
              ontoCommit,
              rebasedStartCommit,
            },
          },
        },
      },
    });
    if (
      authenticatedJournal?.state !== "committed" ||
      authenticatedJournal.version !== 1 ||
      !("guardedRebaseBridge" in authenticatedJournal.seal.seed.gitBinding) ||
      authenticatedJournal.fence === undefined
    ) {
      throw new Error("authenticated guarded recovery journal is unavailable");
    }
    const { guardedRebaseBridge: _omittedGuardedBridge, ...legacyManagerBinding } =
      authenticatedJournal.seal.seed.gitBinding;
    const legacySeal = createCurrentRecoverySeal({
      ...authenticatedJournal.seal.seed,
      gitBinding: legacyManagerBinding,
    });
    if (legacySeal.version !== 1) throw new Error("legacy guarded seal changed version");
    const legacyJournal = new InMemoryCurrentRecoverySealJournalStore();
    await legacyJournal.put({
      ...authenticatedJournal,
      seal: legacySeal,
      fence: createDispatchLineageCutoverFence({
        namespace: legacySeal.seed.namespace,
        taskId: legacySeal.seed.taskId,
        managedFingerprint: legacySeal.seed.managedFingerprint,
        sourceAttestationId: legacySeal.seed.selectedSourceHandle.attestationId,
        selectedSourceGeneration: legacySeal.seed.selectedSourceHandle.generation,
        lineageMaximumGeneration: legacySeal.seed.lineageMaximumGeneration,
        recoverySeedRef: legacySeal.sealReference,
        fenceCapability: {
          scope: "dispatch-lineage-fence",
          token: f.binding.handleToken,
        },
        installedAt: authenticatedJournal.fence.installedAt,
      }),
    });
    const recoveryCapability = createDispatchCapability({
      backend: f.backend,
      ledgerStore: f.ledgerStore,
      repositoryRoot: f.root,
      worktreeStateDir: f.stateDir,
      recoveryJournal: legacyJournal,
      promptArtifactStore: artifactStore(),
      now: () => NOW,
      randomBytes: sequentialDispatchRandomBytes(6573),
    });
    if (recoveryCapability.resolveRecovery === undefined) {
      throw new Error("legacy guarded recovery resolver is unavailable");
    }
    const resolveLegacyRecovery = async () =>
      (await WORKTREE_MANAGE_TOOL_SPEC.run(
        f.ledgerStore,
        {
          repositoryRoot: f.root,
          deps: { stateDir: f.stateDir },
          resolveDispatchRecovery: recoveryCapability.resolveRecovery!,
        },
        { operation: "resolve-dispatch-recovery", handle: f.managed.handle },
      )) as unknown as DispatchRecoveryResolution;
    const legacyResolved = await resolveLegacyRecovery();
    if (legacyResolved.preparation.kind !== "current") {
      throw new Error("expected bridge-less current authority");
    }
    const recovered = await recoveryCapability.prepare({
      roleId: "implement-worker",
      input: {
        ...f.input,
        baseCommit: ontoCommit,
        round: 2,
        startingCommit: receipt.newHead,
        priorResultCommit: receipt.newHead,
      },
      idempotencyKey: "guarded-origin-recovery",
      timeoutMs: 600_000,
      expectedChild: { childId: "guarded-origin-recovery", runId: "guarded-origin-recovery" },
      recoveryPreparation: legacyResolved.preparation.recoveryPreparation,
    });
    if (!recovered.accepted) {
      throw new Error(`guarded-origin recovery rejected at ${recovered.path}: ${recovered.detail}`);
    }
    expect(
      await recoveryCapability.fetchInput({
        ...recovered.handle,
        inputCapability: recovered.prepared.inputCapability,
      }),
    ).toMatchObject({
      input: {
        baseCommit: ontoCommit,
        guardedRebaseLineage: {
          guardedRebase: rebase.reference,
          ontoCommit,
          rebasedStartCommit,
        },
      },
    });
    if (
      recoveryCapability.gitCommit === undefined ||
      recovered.prepared.gitChangeCapability === undefined
    ) {
      throw new Error("guarded-origin recovery broker authority is unavailable");
    }
    const promotedBody = "guarded recovery promoted\n";
    await fs.writeFile(join(f.binding.worktreePath, "promoted.txt"), promotedBody);
    const promotedReceipt = await recoveryCapability.gitCommit({
      ...recovered.handle,
      gitChangeCapability: recovered.prepared.gitChangeCapability,
      operationId: "guarded-origin-promoted-change",
      expectedHead: receipt.newHead,
      message: "promote guarded-origin recovery",
      changes: [
        {
          kind: "add",
          path: "promoted.txt",
          newState: {
            mode: "100644",
            digest: createHash("sha256").update(promotedBody).digest("hex"),
          },
        },
      ],
    });
    await recoveryCapability.abort({ ...recovered.handle, reason: "missing-result" });
    const promoted = await resolveLegacyRecovery();
    expect(promoted).toMatchObject({
      status: "dispatch-recovery-resolved",
      liveTip: promotedReceipt.newHead,
      preparation: { kind: "current" },
    });
    expect(await resolveLegacyRecovery()).toEqual(promoted);
    expect(await legacyJournal.read(TASK_ID)).toMatchObject({
      state: "committed",
      seal: {
        seed: {
          selectedSourceHandle: recovered.handle,
          gitBinding: {
            baseCommit: f.input.baseCommit,
            guardedRebaseBridge: {
              guardedRebase: rebase.reference,
              ontoCommit,
              rebasedStartCommit,
            },
          },
        },
      },
    });
  } finally {
    await f.dispose();
  }
}

describe("manager-bound dispatch recovery", () => {
  test(
    "pre-eec3 persisted prepare digest recovers the exact retained guarded successor [Behavioral-Active Effectual-GoodCommunication]",
    async () => {
      const currentRoot = process.cwd();
      const oldRoot = await materializePersistedDigestRuntime(currentRoot);
      const oldCaseRoot = await fs.mkdtemp(join(tmpdir(), "h392-pre-eec3-"));
      const controlCaseRoot = await fs.mkdtemp(join(tmpdir(), "h392-r17-control-"));
      const oldProduced = await runPersistedDigestProcess<PersistedDigestProduced>(oldRoot, {
        action: "produce",
        caseRoot: oldCaseRoot,
        expected: "digest-mismatch",
      });
      const crossRevision = await runPersistedDigestProcess<PersistedDigestRecovered>(
        currentRoot,
        {
          action: "recover",
          caseRoot: oldCaseRoot,
          expected: "success",
          managedHandle: oldProduced.managedHandle,
          sourceHandle: oldProduced.sourceHandle,
          sourceTip: oldProduced.sourceTip,
        },
      );
      expect(crossRevision).toMatchObject({
        outcome: "resolved",
        status: "dispatch-recovery-resolved",
        rowsByteIdentical: true,
      });
      expect(crossRevision.beforeCount).toBe(crossRevision.afterCount);

      const controlProduced = await runPersistedDigestProcess<PersistedDigestProduced>(
        currentRoot,
        {
          action: "produce",
          caseRoot: controlCaseRoot,
          expected: "success",
        },
      );
      const currentControl = await runPersistedDigestProcess<PersistedDigestRecovered>(
        currentRoot,
        {
          action: "recover",
          caseRoot: controlCaseRoot,
          expected: "success",
          managedHandle: controlProduced.managedHandle,
          sourceHandle: controlProduced.sourceHandle,
          sourceTip: controlProduced.sourceTip,
        },
      );
      expect(currentControl).toMatchObject({
        outcome: "resolved",
        status: "dispatch-recovery-resolved",
        rowsByteIdentical: true,
      });
      expect(oldProduced.runtimeSourceDigest).not.toBe(controlProduced.runtimeSourceDigest);
      console.log(
        JSON.stringify({
          hypothesisId: "H392",
          oldProducerCommit: "853eeae05037de6f8c6710c125fa00d9aa028760",
          frozenReaderSource:
            "/nix/store/cnc2kbg9jhp3mbx0mgk1jsy65n3a33va-cq-verified-fused-recovery-source",
          oldCaseRoot,
          controlCaseRoot,
          oldProduced,
          crossRevision,
          controlProduced,
          currentControl,
        }),
      );
    },
    60_000,
  );

  test(
    "guarded-origin current recovery preserves its authenticated bridge and logical onto",
    guardedOriginRecovery,
    TEST_TIMEOUT_MS,
  );

  test(
    "clean receipt-backed missing-result returns current recovery authority [Behavioral-Progression Effectual-GoodCommunication]",
    async () => {
      await missingResultRecovery("memory", false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "dirty receipt-backed missing-result preserves partial work and returns current recovery authority [Behavioral-Progression Effectual-GoodCommunication]",
    async () => {
      await missingResultRecovery("filesystem", true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "unchanged missing-result and foreign handles cannot mint recovery [Effectual-GoodCommunication]",
    async () => {
      const f = await fixture("memory", false);
      try {
        await f.capability.abort({ ...f.prepared.handle, reason: "missing-result" });
        await expect(f.resolveRecovery()).rejects.toThrow();
        await expect(
          WORKTREE_MANAGE_TOOL_SPEC.run(
            f.ledgerStore,
            {
              repositoryRoot: f.root,
              deps: { stateDir: f.stateDir },
              resolveDispatchRecovery: f.capability.resolveRecovery!,
            },
            {
              operation: "resolve-dispatch-recovery",
              handle: { ...f.managed.handle, nonce: "foreign" },
            },
          ),
        ).rejects.toThrow();
        expect(await f.journal.read(TASK_ID)).toBeNull();
      } finally {
        await f.dispose();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
