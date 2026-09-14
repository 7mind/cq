import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  sequentialDispatchRandomBytes,
} from "@cq/config";
import {
  FsCurrentRecoverySealJournalStore,
  InMemoryCurrentRecoverySealJournalStore,
  InMemoryLedgerStore,
  WORKTREE_MANAGE_TOOL_SPEC,
  prepareManagedWorktree,
  resolveInheritedGitChangeReceipts,
  resolveManagedWorktreeDispatchBinding,
  type Item,
  type DispatchRecoveryResolution,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const TASK_ID = "T6473";
const NOW = "2026-09-14T08:00:00.000Z";
const TEST_TIMEOUT_MS = 30_000;

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
    await expect(f.capability.prepare({ ...request, idempotencyKey: "reused-after-terminal" }))
      .rejects.toThrow("already allocated a successor");
    const renewed = await f.resolveRecovery() as unknown as DispatchRecoveryResolution;
    if (renewed.preparation.kind !== "current") throw new Error("expected promoted authority");
    expect(renewed.preparation.recoveryPreparation.recoverySeedRef)
      .not.toBe(resolved.preparation.recoveryPreparation.recoverySeedRef);
    expect(await f.capability.prepare({ ...request, idempotencyKey: "promoted-recovery",
      recoveryPreparation: renewed.preparation.recoveryPreparation,
    })).toMatchObject({ accepted: true });
  } finally {
    await f.dispose();
  }
}

describe("manager-bound dispatch recovery", () => {
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
