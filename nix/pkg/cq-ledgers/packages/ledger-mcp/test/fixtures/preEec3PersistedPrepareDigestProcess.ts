import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  SqliteAttestationBackend,
  sequentialDispatchRandomBytes,
  type DispatchHandle,
} from "@cq/config";
import {
  FsCurrentRecoverySealJournalStore,
  InMemoryLedgerStore,
  WORKTREE_MANAGE_TOOL_SPEC,
  prepareManagedWorktree,
  resolveManagedWorktreeDispatchBinding,
  runGuardedRebase,
  type DispatchRecoveryResolution,
  type Item,
  type ManagedWorktreeHandle,
} from "@cq/ledger";
import { createDispatchCapability } from "../../src/dispatchCapability.js";

const TASK_ID = "T6473";
const NOW = "2026-09-14T08:00:00.000Z";
const NAMESPACE = { backend: "xdg", projectKey: "h392-pre-eec3-digest" } as const;
const EXPECTED_ERROR =
  "journal recovery cancellation does not authenticate its exact guarded successor; " +
  "cause=retained-source-prepare-digest-mismatch; claim=retained";

interface ProcessConfig {
  readonly action: "produce" | "recover";
  readonly caseRoot: string;
  readonly expected: "success" | "digest-mismatch";
  readonly managedHandle?: ManagedWorktreeHandle;
  readonly sourceHandle?: DispatchHandle;
  readonly sourceTip?: string;
}

interface ProducedFixture {
  readonly managedHandle: ManagedWorktreeHandle;
  readonly sourceHandle: DispatchHandle;
  readonly sourceTip: string;
  readonly recoverySeedRef: string;
  readonly rowCount: number;
  readonly rowDigest: string;
  readonly journalDigest: string;
}

class RecoveryLedger extends InMemoryLedgerStore {
  override fetchItem(ledgerId: string, itemId: string): Item {
    if (ledgerId === "tasks" && itemId === TASK_ID) {
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
    }
    if (ledgerId === "goals" && itemId === "G207") {
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
    }
    return super.fetchItem(ledgerId, itemId);
  }
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

function artifactStore() {
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
      promptSurface: "codex" as const,
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  };
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredConfig(): ProcessConfig {
  const encoded = process.env["CQ_H392_PROCESS_CONFIG"];
  if (encoded === undefined) throw new Error("CQ_H392_PROCESS_CONFIG is required");
  return JSON.parse(encoded) as ProcessConfig;
}

function journalPath(caseRoot: string): string {
  return join(caseRoot, ".manager-state", "current-recovery-seals", `${TASK_ID}.json`);
}

async function sourceDigest(): Promise<string> {
  return digest(await fs.readFile(join(process.cwd(), "packages/cq-config/src/dispatchAttestation.ts")));
}

async function produce(caseRoot: string): Promise<ProducedFixture> {
  await fs.mkdir(caseRoot, { recursive: true });
  await git(caseRoot, ["init", "-q"]);
  await fs.writeFile(join(caseRoot, "state.txt"), "before\n");
  await git(caseRoot, ["add", "state.txt"]);
  await git(caseRoot, ["commit", "-q", "-m", "base"]);
  const baseCommit = await git(caseRoot, ["rev-parse", "HEAD"]);
  const stateDir = join(caseRoot, ".manager-state");
  const managed = await prepareManagedWorktree(
    { repositoryRoot: caseRoot, taskId: TASK_ID, baseCommit },
    { stateDir, skipInstall: true, bunWorkspaceRoot: caseRoot },
  );
  if (managed.status !== "prepared") throw new Error(`unexpected ${managed.status}`);
  const binding = await resolveManagedWorktreeDispatchBinding(
    {
      repositoryRoot: caseRoot,
      taskId: TASK_ID,
      worktreePath: managed.handle.absolutePath,
      branch: managed.handle.branch,
    },
    { stateDir },
  );
  if (binding === null) throw new Error("missing managed binding");

  const ledgerStore = new RecoveryLedger();
  await ledgerStore.init();
  const backend = new SqliteAttestationBackend({
    namespace: NAMESPACE,
    dbPath: join(caseRoot, "attestations.sqlite"),
  });
  const journal = new FsCurrentRecoverySealJournalStore(stateDir);
  const makeCapability = () =>
    createDispatchCapability({
      backend,
      ledgerStore,
      repositoryRoot: caseRoot,
      worktreeStateDir: stateDir,
      recoveryJournal: journal,
      promptArtifactStore: artifactStore(),
      now: () => NOW,
      randomBytes: sequentialDispatchRandomBytes(392),
    });
  const resolveRecovery = async (): Promise<DispatchRecoveryResolution> =>
    (await WORKTREE_MANAGE_TOOL_SPEC.run(
      ledgerStore,
      {
        repositoryRoot: caseRoot,
        deps: { stateDir },
        resolveDispatchRecovery: makeCapability().resolveRecovery!,
      },
      { operation: "resolve-dispatch-recovery", handle: managed.handle },
    )) as unknown as DispatchRecoveryResolution;

  try {
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
    ) {
      throw new Error("worker lacks Git authority");
    }
    await capability.fetchInput({
      ...prepared.handle,
      inputCapability: prepared.prepared.inputCapability,
    });
    await fs.writeFile(join(binding.worktreePath, "state.txt"), "after\n");
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
    await capability.abort({ ...prepared.handle, reason: "parent-lost" });
    const first = await resolveRecovery();
    if (first.preparation.kind !== "current") throw new Error("expected current recovery");
    const recoveredRequest = {
      roleId: "implement-worker",
      input: {
        ...input,
        round: 1,
        startingCommit: receipt.newHead,
        priorResultCommit: receipt.newHead,
      },
      idempotencyKey: "recovered-worker",
      timeoutMs: 600_000,
      expectedChild: { childId: "recovered-worker", runId: "recovered-worker" },
      recoveryPreparation: first.preparation.recoveryPreparation,
    };
    const recovered = await capability.prepare(recoveredRequest);
    if (!recovered.accepted) {
      throw new Error(`recovery successor rejected at ${recovered.path}: ${recovered.detail}`);
    }
    await capability.fetchInput({
      ...recovered.handle,
      inputCapability: recovered.prepared.inputCapability,
    });
    await capability.abort({ ...recovered.handle, reason: "cancelled" });
    const rows = backend.rawStorageDump();
    const journalBytes = await fs.readFile(journalPath(caseRoot));
    return {
      managedHandle: managed.handle,
      sourceHandle: recovered.handle,
      sourceTip: receipt.newHead,
      recoverySeedRef: first.preparation.recoveryPreparation.recoverySeedRef,
      rowCount: backend.storedRows().length,
      rowDigest: digest(rows),
      journalDigest: digest(journalBytes),
    };
  } finally {
    await backend.close();
    await ledgerStore.dispose();
  }
}

async function recover(
  caseRoot: string,
  managedHandle: ManagedWorktreeHandle,
  sourceHandle: DispatchHandle,
  sourceTip: string,
  expected: ProcessConfig["expected"],
) {
  const stateDir = join(caseRoot, ".manager-state");
  const ledgerStore = new RecoveryLedger();
  await ledgerStore.init();
  let backend = new SqliteAttestationBackend({
    namespace: NAMESPACE,
    dbPath: join(caseRoot, "attestations.sqlite"),
  });
  const journal = new FsCurrentRecoverySealJournalStore(stateDir);
  try {
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot: caseRoot,
        taskId: TASK_ID,
        worktreePath: managedHandle.absolutePath,
        branch: managedHandle.branch,
      },
      { stateDir },
    );
    if (binding === null) throw new Error("missing managed binding during recovery");
    await fs.writeFile(join(caseRoot, "protected.txt"), "protected\n");
    await git(caseRoot, ["add", "protected.txt"]);
    await git(caseRoot, ["commit", "-q", "-m", "advance protected head"]);
    const protectedHead = await git(caseRoot, ["rev-parse", "HEAD"]);
    const rebase = await runGuardedRebase({
      binding,
      operationId: "h392-manual-guarded-successor",
      ontoCommit: protectedHead,
      stateDir,
      runEffect: async () => {
        await git(binding.worktreePath, ["rebase", protectedHead]);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    if (rebase.kind !== "finalized") throw new Error("manual guarded rebase did not finalize");
    const setupCapability = createDispatchCapability({
      backend,
      ledgerStore,
      repositoryRoot: caseRoot,
      worktreeStateDir: stateDir,
      recoveryJournal: journal,
      promptArtifactStore: artifactStore(),
      now: () => NOW,
      randomBytes: sequentialDispatchRandomBytes(700),
    });
    const guarded = await setupCapability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: TASK_ID,
        headline: "recover managed worker",
        description: "retain receipt closure",
        acceptance: "typed recovery authority",
        worktreePath: binding.worktreePath,
        branch: binding.branch,
        baseCommit: protectedHead,
        round: 2,
        startingCommit: rebase.bridge.rebasedStartCommit,
        validationIntent: "final",
        priorResultCommit: sourceTip,
      },
      idempotencyKey: "manual-guarded-successor",
      timeoutMs: 600_000,
      expectedChild: { childId: "manual-guarded-successor", runId: "manual-guarded-successor" },
      reprepareOf: sourceHandle,
      guardedRebase: rebase.reference,
    });
    if (!guarded.accepted) {
      throw new Error(`manual guarded successor rejected at ${guarded.path}: ${guarded.detail}`);
    }
    await setupCapability.fetchInput({
      ...guarded.handle,
      inputCapability: guarded.prepared.inputCapability,
    });
    await setupCapability.abort({ ...guarded.handle, reason: "cancelled" });
    await backend.close();
    backend = new SqliteAttestationBackend({
      namespace: NAMESPACE,
      dbPath: join(caseRoot, "attestations.sqlite"),
    });
    const beforeRows = backend.rawStorageDump();
    const beforeCount = backend.storedRows().length;
    const beforeJournal = await fs.readFile(journalPath(caseRoot));
    const capability = createDispatchCapability({
      backend,
      ledgerStore,
      repositoryRoot: caseRoot,
      worktreeStateDir: stateDir,
      recoveryJournal: journal,
      promptArtifactStore: artifactStore(),
      now: () => NOW,
      randomBytes: sequentialDispatchRandomBytes(800),
    });
    let result: DispatchRecoveryResolution | undefined;
    let observedError: unknown;
    try {
      result = (await WORKTREE_MANAGE_TOOL_SPEC.run(
        ledgerStore,
        {
          repositoryRoot: caseRoot,
          deps: { stateDir },
          resolveDispatchRecovery: capability.resolveRecovery!,
        },
        { operation: "resolve-dispatch-recovery", handle: managedHandle },
      )) as unknown as DispatchRecoveryResolution;
    } catch (error) {
      observedError = error;
    }
    const afterRows = backend.rawStorageDump();
    const afterCount = backend.storedRows().length;
    const afterJournal = await fs.readFile(journalPath(caseRoot));
    if (afterRows !== beforeRows || afterCount !== beforeCount) {
      throw new Error("resolve-dispatch-recovery changed the persisted attestation rows");
    }
    if (expected === "digest-mismatch") {
      if (!beforeJournal.equals(afterJournal)) {
        throw new Error("rejected resolve-dispatch-recovery changed the recovery journal bytes");
      }
      if (!(observedError instanceof Error)) throw new Error("expected recovery rejection");
      const reason = (observedError as Error & { readonly reason?: string }).reason;
      if (reason !== "journal-conflict" || observedError.message !== EXPECTED_ERROR) {
        throw new Error(
          `unexpected recovery rejection: reason=${String(reason)} message=${observedError.message}`,
        );
      }
      return {
        outcome: "rejected" as const,
        reason,
        message: observedError.message,
        beforeCount,
        afterCount,
        rowDigest: digest(beforeRows),
        journalDigest: digest(beforeJournal),
        rowsByteIdentical: true,
        journalByteIdentical: true,
      };
    }
    if (observedError !== undefined) throw observedError;
    if (result?.status !== "dispatch-recovery-resolved") {
      throw new Error("control recovery did not resolve");
    }
    return {
      outcome: "resolved" as const,
      status: result.status,
      beforeCount,
      afterCount,
      rowDigest: digest(beforeRows),
      journalDigestBefore: digest(beforeJournal),
      journalDigestAfter: digest(afterJournal),
      rowsByteIdentical: true,
      journalByteIdentical: beforeJournal.equals(afterJournal),
    };
  } finally {
    await backend.close();
    await ledgerStore.dispose();
  }
}

const config = requiredConfig();
const runtimeSourceDigest = await sourceDigest();
const output =
  config.action === "produce"
    ? await produce(config.caseRoot)
    : await recover(
        config.caseRoot,
        config.managedHandle ?? (() => {
          throw new Error("managedHandle is required for recovery");
        })(),
        config.sourceHandle ?? (() => {
          throw new Error("sourceHandle is required for recovery");
        })(),
        config.sourceTip ?? (() => {
          throw new Error("sourceTip is required for recovery");
        })(),
        config.expected,
      );
process.stdout.write(`${JSON.stringify({ runtimeRoot: process.cwd(), runtimeSourceDigest, ...output })}\n`);
