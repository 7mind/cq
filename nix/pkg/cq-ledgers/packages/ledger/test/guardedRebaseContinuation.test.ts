/**
 * T2150 / D334 — the replay-safe task-bound guarded-rebase journal.
 *
 * Behavioral-Active Effectual-GoodCommunication tests against disposable real
 * Git repositories. The journal under the managed handle's Git-effect lock is
 * the ONLY authority a later worker continuation may be prepared from: exact
 * replay returns the same opaque reference, changed-payload reuse rejects, a
 * restart reconciles the same journal, and a nonterminal journal never
 * materializes a bridge.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  runWorksetGitEffectGate,
  type RebaseOntoEffectBinding,
} from "@cq/process-control";
import {
  GuardedRebaseRejection,
  InMemoryLedgerStore,
  continueManagedWorktreeRebase,
  gitRebaseConflictStateDigest,
  materializeGuardedRebaseBridge,
  observeManagedWorktreeConflictState,
  prepareManagedWorktree,
  requireWorksetStore,
  resolveManagedWorktreeDispatchBinding,
  runGuardedRebase,
  worksetEffectAdmissionProviderFromStore,
  type GuardedRebaseEffectResult,
  type ManagedWorktreeDispatchBinding,
} from "../src/index.js";

const exec = promisify(execFile);
const roots: string[] = [];
const TASK_ID = "T2150";
const REFERENCE_PATTERN = /^cq-guarded-rebase:v1:[0-9a-f]{64}$/u;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "T2150",
      GIT_AUTHOR_EMAIL: "t2150@example.invalid",
      GIT_COMMITTER_NAME: "T2150",
      GIT_COMMITTER_EMAIL: "t2150@example.invalid",
    },
  });
  return stdout.trim();
}

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface GuardedFixture {
  readonly repositoryRoot: string;
  readonly stateDir: string;
  readonly worktreePath: string;
  readonly binding: ManagedWorktreeDispatchBinding;
  readonly baseCommit: string;
  readonly oldTip: string;
  readonly ontoCommit: string;
  readonly runEffect: () => Promise<GuardedRebaseEffectResult>;
  readonly store: InMemoryLedgerStore;
}

async function seedGuarded(options: {
  readonly conflict?: boolean;
  readonly partialReplay?: boolean;
}): Promise<GuardedFixture> {
  const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), "t2150-guarded-"));
  roots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "-q", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.name", "T2150"]);
  await git(repositoryRoot, ["config", "user.email", "t2150@example.invalid"]);
  await git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(repositoryRoot, "file.txt"), "base\n");
  await fs.writeFile(path.join(repositoryRoot, "other.txt"), "other base\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const stateDir = path.join(repositoryRoot, ".broker-state");
  const prepared = await prepareManagedWorktree(
    { repositoryRoot, taskId: TASK_ID, baseCommit },
    { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
  );
  if (prepared.status !== "prepared") throw new Error(`prepare returned ${prepared.status}`);
  const worktreePath = prepared.handle.absolutePath;
  await fs.writeFile(path.join(worktreePath, "file.txt"), "task change\n");
  if (options.partialReplay === true) {
    await fs.writeFile(path.join(worktreePath, "other.txt"), "task other\n");
    await git(worktreePath, ["add", "other.txt"]);
  }
  await git(worktreePath, ["add", "file.txt"]);
  await git(worktreePath, ["commit", "-q", "-m", "task change"]);
  const oldTip = await git(worktreePath, ["rev-parse", "HEAD"]);
  if (options.conflict === true) {
    await fs.writeFile(path.join(repositoryRoot, "file.txt"), "main change\n");
  } else {
    await fs.writeFile(path.join(repositoryRoot, "main.txt"), "main only\n");
    await git(repositoryRoot, ["add", "main.txt"]);
  }
  if (options.partialReplay === true) {
    await fs.writeFile(path.join(repositoryRoot, "other.txt"), "task other\n");
    await git(repositoryRoot, ["add", "other.txt"]);
  }
  if (options.conflict === true) await git(repositoryRoot, ["add", "file.txt"]);
  await git(repositoryRoot, ["commit", "-q", "-m", "advance main"]);
  const ontoCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const binding = await resolveManagedWorktreeDispatchBinding(
    { repositoryRoot, taskId: TASK_ID, worktreePath, branch: prepared.handle.branch },
    { stateDir },
  );
  if (binding === null) throw new Error("managed dispatch binding did not resolve");
  const store = new InMemoryLedgerStore();
  await store.init();
  await store.createMilestone({ id: "M2150", title: "guarded rebase fixture" });
  await store.createItem("tasks", "M2150", {
    id: TASK_ID,
    status: "wip",
    fields: { headline: "Guarded rebase continuation" },
  });
  await requireWorksetStore(store).setRoots([`tasks:${TASK_ID}`]);
  const provider = worksetEffectAdmissionProviderFromStore(requireWorksetStore(store));
  const effectBinding: RebaseOntoEffectBinding = {
    kind: "rebase",
    targetRef: `tasks:${TASK_ID}`,
    repositoryRoot,
    worktreePath,
    ontoCommit,
  };
  const runEffect = async () =>
    await runWorksetGitEffectGate({
      expected: effectBinding,
      resolve: async () => effectBinding,
      provider,
    });
  return { repositoryRoot, stateDir, worktreePath, binding, baseCommit, oldTip, ontoCommit, runEffect, store };
}

function priorOf(fixture: GuardedFixture): ManagedWorktreeDispatchBinding & {
  readonly attestationId: string;
  readonly generation: number;
} {
  return Object.freeze({
    ...fixture.binding,
    attestationId: "cq_attest_t2150_prior",
    generation: 1,
  });
}

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

describe("runGuardedRebase", () => {
  test("journals a clean guarded rebase, replays exactly, and rejects changed-payload reuse", async () => {
    const fixture = await seedGuarded({});
    try {
      const first = await runGuardedRebase({
        binding: fixture.binding,
        operationId: "t2150-clean-rebase",
        ontoCommit: fixture.ontoCommit,
        runEffect: fixture.runEffect,
        stateDir: fixture.stateDir,
      });
      if (first.kind !== "finalized") throw new Error("clean rebase did not finalize");
      expect(first.reference).toMatch(REFERENCE_PATTERN);
      expect(first.effect).not.toBeNull();
      expect(first.bridge).toEqual({
        guardedRebase: first.reference,
        operationId: "t2150-clean-rebase",
        requestDigest: first.reference.slice("cq-guarded-rebase:v1:".length),
        oldResultCommit: fixture.oldTip,
        ontoCommit: fixture.ontoCommit,
        rebasedStartCommit: await git(fixture.worktreePath, ["rev-parse", "HEAD"]),
        outcome: "clean",
        exactTip: true,
        finalizedAt: first.bridge.finalizedAt,
      });
      expect(first.bridge.rebasedStartCommit).not.toBe(fixture.oldTip);

      // Exact replay: the effect is never re-launched and the reference is identical.
      const replay = await runGuardedRebase({
        binding: fixture.binding,
        operationId: "t2150-clean-rebase",
        ontoCommit: fixture.ontoCommit,
        runEffect: async () => {
          throw new Error("exact replay must not re-launch the effect");
        },
        stateDir: fixture.stateDir,
      });
      expect(replay).toEqual({ ...first, effect: null });

      // Restart reconcile: a fresh process-level call resolves the same journal.
      const restarted = await runGuardedRebase({
        binding: fixture.binding,
        operationId: "t2150-clean-rebase",
        ontoCommit: fixture.ontoCommit,
        runEffect: async () => {
          throw new Error("restart reconcile must not re-launch the effect");
        },
        stateDir: fixture.stateDir,
      });
      if (restarted.kind !== "finalized") throw new Error("restart did not reconcile");
      expect(restarted.reference).toBe(first.reference);

      // Changed-payload reuse of the same operation id rejects.
      await expect(
        runGuardedRebase({
          binding: fixture.binding,
          operationId: "t2150-clean-rebase",
          ontoCommit: fixture.baseCommit,
          runEffect: fixture.runEffect,
          stateDir: fixture.stateDir,
        }),
      ).rejects.toThrow("reused with a different request");

      // The terminal journal materializes the same bridge server-side.
      const bridge = await materializeGuardedRebaseBridge({
        reference: first.reference,
        prior: priorOf(fixture),
        current: fixture.binding,
        baseCommitInput: fixture.ontoCommit,
        startingCommitInput: first.bridge.rebasedStartCommit,
        priorResultCommitInput: fixture.oldTip,
        stateDir: fixture.stateDir,
      });
      expect(bridge).toEqual(first.bridge);

      // Omission/substitution matrix on the materialized coordinates.
      await expect(
        materializeGuardedRebaseBridge({
          reference: first.reference,
          prior: priorOf(fixture),
          current: fixture.binding,
          baseCommitInput: fixture.baseCommit,
          startingCommitInput: first.bridge.rebasedStartCommit,
          priorResultCommitInput: fixture.oldTip,
          stateDir: fixture.stateDir,
        }),
      ).rejects.toBeInstanceOf(GuardedRebaseRejection);
      await expect(
        materializeGuardedRebaseBridge({
          reference: first.reference,
          prior: priorOf(fixture),
          current: fixture.binding,
          baseCommitInput: fixture.ontoCommit,
          startingCommitInput: fixture.oldTip,
          priorResultCommitInput: fixture.oldTip,
          stateDir: fixture.stateDir,
        }),
      ).rejects.toBeInstanceOf(GuardedRebaseRejection);
      await expect(
        materializeGuardedRebaseBridge({
          reference: first.reference,
          prior: priorOf(fixture),
          current: fixture.binding,
          baseCommitInput: fixture.ontoCommit,
          startingCommitInput: first.bridge.rebasedStartCommit,
          priorResultCommitInput: first.bridge.rebasedStartCommit,
          stateDir: fixture.stateDir,
        }),
      ).rejects.toBeInstanceOf(GuardedRebaseRejection);
      await expect(
        materializeGuardedRebaseBridge({
          reference: "cq-guarded-rebase:v1:not-a-digest",
          prior: priorOf(fixture),
          current: fixture.binding,
          baseCommitInput: fixture.ontoCommit,
          startingCommitInput: first.bridge.rebasedStartCommit,
          priorResultCommitInput: fixture.oldTip,
          stateDir: fixture.stateDir,
        }),
      ).rejects.toBeInstanceOf(GuardedRebaseRejection);
      await expect(
        materializeGuardedRebaseBridge({
          reference: `cq-guarded-rebase:v1:${"0".repeat(64)}`,
          prior: priorOf(fixture),
          current: fixture.binding,
          baseCommitInput: fixture.ontoCommit,
          startingCommitInput: first.bridge.rebasedStartCommit,
          priorResultCommitInput: fixture.oldTip,
          stateDir: fixture.stateDir,
        }),
      ).rejects.toThrow("does not resolve to a durable journal");

      // Stale: the managed ref advancing past the journaled head closes the bridge.
      await fs.writeFile(path.join(fixture.worktreePath, "later.txt"), "later\n");
      await git(fixture.worktreePath, ["add", "later.txt"]);
      await git(fixture.worktreePath, ["commit", "-q", "-m", "later correction"]);
      await expect(
        materializeGuardedRebaseBridge({
          reference: first.reference,
          prior: priorOf(fixture),
          current: fixture.binding,
          baseCommitInput: fixture.ontoCommit,
          startingCommitInput: first.bridge.rebasedStartCommit,
          priorResultCommitInput: fixture.oldTip,
          stateDir: fixture.stateDir,
        }),
      ).rejects.toThrow("stale");
      await expect(
        runGuardedRebase({
          binding: fixture.binding,
          operationId: "t2150-clean-rebase",
          ontoCommit: fixture.ontoCommit,
          runEffect: fixture.runEffect,
          stateDir: fixture.stateDir,
        }),
      ).rejects.toThrow("stale");
    } finally {
      await fixture.store.dispose();
    }
  });

  test("a clean rebase that absorbs part of the change denies the exact-tip mode", async () => {
    const fixture = await seedGuarded({ partialReplay: true });
    try {
      const outcome = await runGuardedRebase({
        binding: fixture.binding,
        operationId: "t2150-partial-replay",
        ontoCommit: fixture.ontoCommit,
        runEffect: fixture.runEffect,
        stateDir: fixture.stateDir,
      });
      if (outcome.kind !== "finalized") throw new Error("partial replay did not finalize");
      expect(outcome.bridge.outcome).toBe("clean");
      expect(outcome.bridge.exactTip).toBe(false);
    } finally {
      await fixture.store.dispose();
    }
  });

  test("an interrupted intent journal relaunches the effect and keeps the reference", async () => {
    const fixture = await seedGuarded({});
    try {
      await expect(
        runGuardedRebase({
          binding: fixture.binding,
          operationId: "t2150-interrupted",
          ontoCommit: fixture.ontoCommit,
          runEffect: async () => ({ code: 1, stdout: "", stderr: "simulated launch failure" }),
          stateDir: fixture.stateDir,
        }),
      ).rejects.toThrow("guarded rebase effect failed");
      // A nonterminal journal never materializes a bridge.
      const pending = await runGuardedRebase({
        binding: fixture.binding,
        operationId: "t2150-interrupted",
        ontoCommit: fixture.ontoCommit,
        runEffect: fixture.runEffect,
        stateDir: fixture.stateDir,
      });
      if (pending.kind !== "finalized") throw new Error("intent reconcile did not finalize");
      expect(pending.reference).toMatch(REFERENCE_PATTERN);
      expect(pending.bridge.oldResultCommit).toBe(fixture.oldTip);
    } finally {
      await fixture.store.dispose();
    }
  });

  test("a conflicted rebase finalizes only after durable continuation receipts reach the terminal tip", async () => {
    const fixture = await seedGuarded({ conflict: true });
    try {
      const stopped = await runGuardedRebase({
        binding: fixture.binding,
        operationId: "t2150-conflicted",
        ontoCommit: fixture.ontoCommit,
        runEffect: fixture.runEffect,
        stateDir: fixture.stateDir,
      });
      if (stopped.kind !== "conflict-pending") {
        throw new Error("conflicted rebase did not stop at the journal boundary");
      }
      expect(stopped.effect.code).not.toBe(0);

      // Nonterminal: the journal exists but mints no authority — replay stays
      // pending and materialization rejects the exact stopped reference.
      const journalRoot = path.join(fixture.stateDir, "guarded-rebase");
      const journalDirs = await fs.readdir(journalRoot);
      expect(journalDirs).toHaveLength(1);
      const stoppedJournal = JSON.parse(
        await fs.readFile(path.join(journalRoot, journalDirs[0]!, "journal.json"), "utf8"),
      ) as { readonly state: string; readonly requestDigest: string };
      expect(stoppedJournal.state).toBe("rebase-stopped");
      const stoppedReference = `cq-guarded-rebase:v1:${stoppedJournal.requestDigest}`;
      const pendingReplay = await runGuardedRebase({
        binding: fixture.binding,
        operationId: "t2150-conflicted",
        ontoCommit: fixture.ontoCommit,
        runEffect: async () => {
          throw new Error("a stopped rebase must not re-launch the effect");
        },
        stateDir: fixture.stateDir,
      });
      expect(pendingReplay.kind).toBe("conflict-pending");
      await expect(
        materializeGuardedRebaseBridge({
          reference: stoppedReference,
          prior: priorOf(fixture),
          current: fixture.binding,
          baseCommitInput: fixture.ontoCommit,
          startingCommitInput: fixture.oldTip,
          priorResultCommitInput: fixture.oldTip,
          stateDir: fixture.stateDir,
        }),
      ).rejects.toThrow("has not reached a verified terminal tip");

      await expect(
        materializeGuardedRebaseBridge({
          reference: `cq-guarded-rebase:v1:${"0".repeat(64)}`,
          prior: priorOf(fixture),
          current: fixture.binding,
          baseCommitInput: fixture.ontoCommit,
          startingCommitInput: fixture.oldTip,
          priorResultCommitInput: fixture.oldTip,
          stateDir: fixture.stateDir,
        }),
      ).rejects.toThrow("does not resolve to a durable journal");

      // Resolve the conflict through the durable continuation boundary.
      const resolverAuthorization = Object.freeze({
        ...fixture.binding,
        attestationId: "cq_attest_t2150_resolver",
        generation: 1,
        roleId: "implement-conflict-resolver" as const,
        surface: "codex",
        childCancelAt: "2099-01-01T00:00:00.000Z",
      });
      const conflict = await observeManagedWorktreeConflictState(fixture.binding, {
        stateDir: fixture.stateDir,
      });
      const authorization = Object.freeze({
        ...resolverAuthorization,
        conflictStateDigest: gitRebaseConflictStateDigest(conflict),
      });
      await fs.writeFile(path.join(fixture.worktreePath, "file.txt"), "main change + task change\n");
      const receipt = await continueManagedWorktreeRebase(
        {
          authorization,
          operationId: "t2150-resolution-1",
          expectedState: conflict,
          resolutions: [
            {
              kind: "regular" as const,
              path: "file.txt",
              newState: { mode: "100644" as const, digest: digest("main change + task change\n") },
            },
          ],
        },
        { stateDir: fixture.stateDir, authorize: async () => {} },
      );
      expect(receipt.outcome).toEqual({ kind: "terminal", tip: receipt.newHead });

      // Restart reconcile: the same operation id finalizes from the durable
      // continuation chain without re-launching anything.
      const finalized = await runGuardedRebase({
        binding: fixture.binding,
        operationId: "t2150-conflicted",
        ontoCommit: fixture.ontoCommit,
        runEffect: async () => {
          throw new Error("conflict reconcile must not re-launch the effect");
        },
        stateDir: fixture.stateDir,
      });
      if (finalized.kind !== "finalized") throw new Error("conflicted rebase did not finalize");
      expect(finalized.effect).toBeNull();
      expect(finalized.bridge.outcome).toBe("conflicted");
      expect(finalized.bridge.exactTip).toBe(false);
      expect(finalized.bridge.rebasedStartCommit).toBe(receipt.newHead);

      const bridge = await materializeGuardedRebaseBridge({
        reference: finalized.reference,
        prior: priorOf(fixture),
        current: fixture.binding,
        baseCommitInput: fixture.ontoCommit,
        startingCommitInput: receipt.newHead,
        priorResultCommitInput: fixture.oldTip,
        stateDir: fixture.stateDir,
      });
      expect(bridge).toEqual(finalized.bridge);

      // Exact replay returns the same reference after the conflicted finalization.
      const replay = await runGuardedRebase({
        binding: fixture.binding,
        operationId: "t2150-conflicted",
        ontoCommit: fixture.ontoCommit,
        runEffect: async () => {
          throw new Error("finalized replay must not re-launch the effect");
        },
        stateDir: fixture.stateDir,
      });
      if (replay.kind !== "finalized") throw new Error("finalized replay did not reconcile");
      expect(replay.reference).toBe(finalized.reference);
    } finally {
      await fixture.store.dispose();
    }
  });

  test("a foreign repository cannot resolve another handle's guarded-rebase reference", async () => {
    const first = await seedGuarded({});
    const second = await seedGuarded({});
    try {
      const minted = await runGuardedRebase({
        binding: first.binding,
        operationId: "t2150-foreign-source",
        ontoCommit: first.ontoCommit,
        runEffect: first.runEffect,
        stateDir: first.stateDir,
      });
      if (minted.kind !== "finalized") throw new Error("source rebase did not finalize");
      await expect(
        materializeGuardedRebaseBridge({
          reference: minted.reference,
          prior: priorOf(second),
          current: second.binding,
          baseCommitInput: second.ontoCommit,
          startingCommitInput: minted.bridge.rebasedStartCommit,
          priorResultCommitInput: second.oldTip,
          stateDir: second.stateDir,
        }),
      ).rejects.toThrow("does not resolve to a durable journal");
    } finally {
      await first.store.dispose();
      await second.store.dispose();
    }
  });
});
