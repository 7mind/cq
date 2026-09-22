import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  commitManagedWorktreeChanges,
  resolveInheritedGitChangeReceipts,
  validateGitChangeBrokerResultEvidence,
  type DispatchBoundGitAuthorization,
} from "../src/gitChangeBroker.js";
import {
  continueManagedWorktreeRebase,
  observeManagedRebaseConflict,
  gitRebaseConflictStateDigest,
  validateGitConflictContinuationResultEvidence,
} from "../src/gitConflictContinuation.js";
import {
  cohortBrokerGit as git,
  cohortChangeRequest,
  cohortGitBrokerFixture,
  rawDigest,
} from "./workCohortGitBrokerFixture.js";
import { createCohortEffectEnvelopeV1, cohortValueDigestV1 } from "../src/workCohort.js";

for (const backend of ["memory", "sqlite"] as const)
  describe(`${backend} cohort Git broker [Behavioral-Active Blackbox-GoodCommunication]`, () => {
    test("renewed live authority reconciles an already published commit without changing its producing receipt", async () => {
      const f = await cohortGitBrokerFixture(backend);
      try {
        const request = await cohortChangeRequest(f.authorization, "renewed-publication", "a", "base a\n", "candidate\n");
        await expect(commitManagedWorktreeChanges(request, { stateDir: f.deps.stateDir, cohortAuthority: f.authority,
          authorize: async () => {
            if (await git(f.authorization.worktreePath, ["rev-parse", "HEAD"]) !== f.baseCommit) throw new Error("crash after publication");
          } })).rejects.toThrow("crash after publication");
        const published = await git(f.authorization.worktreePath, ["rev-parse", "HEAD"]);
        const original = await resolveInheritedGitChangeReceipts(f.authorization, published, { stateDir: f.deps.stateDir });
        expect(await git(f.authorization.worktreePath, ["status", "--porcelain"])).toBe("MM a.txt");
        await f.store.beginNewExecutionEpoch();
        const renewed = await f.makeAuthority("reconcile");
        const deps = { stateDir: f.deps.stateDir, cohortAuthority: renewed, authorize: () => undefined };
        await expect(commitManagedWorktreeChanges(request, deps)).rejects.toThrow("authority");
        const retry = { ...request, authorization: { ...f.authorization, cohort: renewed.envelope } };
        await expect(commitManagedWorktreeChanges({ ...retry, message: "changed payload" }, deps)).rejects.toThrow("different request");
        expect(await commitManagedWorktreeChanges(retry, deps)).toEqual(original[0]!);
        expect(await git(f.authorization.worktreePath, ["status", "--porcelain"])).toBe("");
        expect(await git(f.authorization.worktreePath, ["rev-list", "--count", `${f.baseCommit}..HEAD`])).toBe("1");
        expect(await resolveInheritedGitChangeReceipts(retry.authorization, published, deps)).toEqual(original);
      } finally { await f.close(); }
    });
    test("completed replay rejects a substituted durable cohort receipt epoch", async () => {
      const f = await cohortGitBrokerFixture(backend);
      try {
        const deps = {
          stateDir: f.deps.stateDir,
          cohortAuthority: f.authority,
          authorize: () => undefined,
        };
        const request = await cohortChangeRequest(
          f.authorization,
          "receipt-substitution",
          "a",
          "base a\n",
          "member one\n",
        );
        await commitManagedWorktreeChanges(request, deps);
        const journalPath = join(
          f.deps.stateDir,
          "git-broker",
          rawDigest(
            `${f.authorization.attestationId}\n${f.authorization.generation}\n${request.operationId}`,
          ),
          "journal.json",
        );
        const journal = JSON.parse(await readFile(journalPath, "utf8"));
        journal.receipt.cohort = createCohortEffectEnvelopeV1({
          definition: f.definition,
          observation: f.observation,
          intent: f.intent,
          evidenceSubject: null,
          executionEpoch: "forged-producing-epoch",
        });
      await writeFile(journalPath, JSON.stringify(journal));
      await expect(commitManagedWorktreeChanges(request, deps)).rejects.toThrow("receipt");
      await expect(
        resolveInheritedGitChangeReceipts(f.authorization, journal.receipt.newHead, deps),
      ).rejects.toThrow("journal-bound producing envelope");
      } finally {
        await f.close();
      }
    });
    test("one real multi-member candidate has contiguous v2 receipts, exact replay, and no anchor task", async () => {
      const f = await cohortGitBrokerFixture(backend);
      try {
        const deps = {
          stateDir: f.deps.stateDir,
          cohortAuthority: f.authority,
          authorize: () => undefined,
        };
        const firstRequest = await cohortChangeRequest(
          f.authorization,
          "first",
          "a",
          "base a\n",
          "member one\n",
        );
        const first = await commitManagedWorktreeChanges(firstRequest, deps);
        expect(first.version).toBe(2);
        expect(first.cohort).toEqual(f.authority.envelope);
        expect(Object.hasOwn(first, "taskId")).toBe(false);
        expect(await commitManagedWorktreeChanges(firstRequest, deps)).toEqual(first);
        await expect(
          commitManagedWorktreeChanges({ ...firstRequest, message: "changed replay" }, deps),
        ).rejects.toThrow("different request");
        const secondRequest = await cohortChangeRequest(
          f.authorization,
          "second",
          "b",
          "base b\n",
          "member two\n",
        );
        const second = await commitManagedWorktreeChanges(secondRequest, deps);
        expect(second.oldHead).toBe(first.newHead);
        const evidence = {
          cohort: f.authority.envelope,
          resultCommit: second.newHead,
          branch: f.authorization.branch,
          actualWorktreePath: f.authorization.worktreePath,
          filesTouched: ["a.txt", "b.txt"],
          gitReceipts: [first, second],
        };
        await expect(
          validateGitChangeBrokerResultEvidence(f.authorization, evidence, deps),
        ).resolves.toEqual(evidence);
        await expect(
          validateGitChangeBrokerResultEvidence(
            f.authorization,
            { ...evidence, gitReceipts: [second] },
            deps,
          ),
        ).rejects.toThrow("omits");
        await expect(
          validateGitChangeBrokerResultEvidence(
            f.authorization,
            { ...evidence, gitReceipts: [second, first] },
            deps,
          ),
        ).rejects.toThrow("entry");
        await f.store.beginNewExecutionEpoch();
        await expect(commitManagedWorktreeChanges(secondRequest, deps)).rejects.toThrow("epoch");
        const renewed = await f.makeAuthority("renewed");
        expect(
          await resolveInheritedGitChangeReceipts(
            { ...f.authorization, cohort: renewed.envelope },
            second.newHead,
            deps,
          ),
        ).toEqual([first, second]);
      } finally {
        await f.close();
      }
    });
    test("missing authority, anchor injection, foreign handle and stale epoch refuse before ref mutation", async () => {
      const f = await cohortGitBrokerFixture(backend);
      try {
        const request = await cohortChangeRequest(
          f.authorization,
          "refuse",
          "a",
          "base a\n",
          "candidate\n",
        );
        await expect(
          commitManagedWorktreeChanges(request, {
            stateDir: f.deps.stateDir,
            authorize: () => undefined,
          }),
        ).rejects.toThrow("all-member authority");
        const deps = {
          stateDir: f.deps.stateDir,
          cohortAuthority: f.authority,
          authorize: () => undefined,
        };
        const { envelopeDigest: _priorDigest, ...envelope } = f.authority.envelope;
        const payload = {
          ...envelope,
          memberAuthorities: envelope.memberAuthorities.slice(0, 1),
          memberSetDigest: cohortValueDigestV1(envelope.memberAuthorities.slice(0, 1)),
        };
        const omittedMember = { ...payload, envelopeDigest: cohortValueDigestV1(payload) };
        for (const authorization of [
          { ...f.authorization, taskId: "T1" },
          { ...f.authorization, handleToken: "foreign" },
          { ...f.authorization, cohort: omittedMember },
        ]) {
          await expect(
            commitManagedWorktreeChanges(
              { ...request, authorization: authorization as DispatchBoundGitAuthorization },
              deps,
            ),
          ).rejects.toThrow();
        }
        expect(await git(f.authorization.worktreePath, ["rev-parse", "HEAD"])).toBe(f.baseCommit);
        await f.store.beginNewExecutionEpoch();
        await expect(commitManagedWorktreeChanges(request, deps)).rejects.toThrow("epoch");
        expect(await git(f.authorization.worktreePath, ["rev-parse", "HEAD"])).toBe(f.baseCommit);
      } finally {
        await f.close();
      }
    });
    test("epoch rotation after broker validation prevents the decisive ref CAS", async () => {
      const f = await cohortGitBrokerFixture(backend);
      try {
        const request = await cohortChangeRequest(
          f.authorization,
          "rotate-before-cas",
          "a",
          "base a\n",
          "candidate\n",
        );
        const publish = f.store.publishLiveCohortEffect.bind(f.store);
        f.store.publishLiveCohortEffect = async (...args) => {
          await f.store.beginNewExecutionEpoch();
          return publish(...args);
        };
        await expect(
          commitManagedWorktreeChanges(request, {
            stateDir: f.deps.stateDir,
            cohortAuthority: f.authority,
            authorize: () => undefined,
          }),
        ).rejects.toThrow("epoch");
        expect(await git(f.authorization.worktreePath, ["rev-parse", "HEAD"])).toBe(f.baseCommit);
      } finally {
        await f.close();
      }
    });
    test("a crash after cohort ref CAS retains truthful journal recovery and one commit", async () => {
      const f = await cohortGitBrokerFixture(backend);
      try {
        const request = await cohortChangeRequest(
          f.authorization,
          "crash",
          "a",
          "base a\n",
          "candidate\n",
        );
        await expect(
          commitManagedWorktreeChanges(request, {
            stateDir: f.deps.stateDir,
            cohortAuthority: f.authority,
            authorize: async () => {
              if ((await git(f.authorization.worktreePath, ["rev-parse", "HEAD"])) !== f.baseCommit)
                throw new Error("simulated crash after ref CAS");
            },
          }),
        ).rejects.toThrow("simulated crash");
        const published = await git(f.authorization.worktreePath, ["rev-parse", "HEAD"]);
        expect(published).not.toBe(f.baseCommit);
        const receipt = await commitManagedWorktreeChanges(request, {
          stateDir: f.deps.stateDir,
          cohortAuthority: f.authority,
          authorize: () => undefined,
        });
        expect(receipt.newHead).toBe(published);
        expect(
          await git(f.authorization.worktreePath, ["rev-list", "--count", `${f.baseCommit}..HEAD`]),
        ).toBe("1");
        expect(await git(f.authorization.worktreePath, ["status", "--porcelain"])).toBe("");
      } finally {
        await f.close();
      }
    });
    test("registered cohort conflict continuation carries all members and preserves both edits", async () => {
      const f = await cohortGitBrokerFixture(backend);
      try {
        const deps = {
          stateDir: f.deps.stateDir,
          cohortAuthority: f.authority,
          authorize: () => undefined,
        };
        await commitManagedWorktreeChanges(
          await cohortChangeRequest(f.authorization, "task-a", "a", "base a\n", "member one\n"),
          deps,
        );
        await commitManagedWorktreeChanges(
          await cohortChangeRequest(f.authorization, "task-b", "b", "base b\n", "member two\n"),
          deps,
        );
        await writeFile(join(f.root, "a.txt"), "upstream\n");
        await git(f.root, ["add", "a.txt"]);
        await git(f.root, ["commit", "-q", "-m", "upstream"]);
        const onto = await git(f.root, ["rev-parse", "HEAD"]);
        const rebased = Bun.spawnSync(["git", "rebase", onto], {
          cwd: f.authorization.worktreePath,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(rebased.exitCode).not.toBe(0);
        const resolver = {
          ...f.authorization,
          roleId: "implement-conflict-resolver" as const,
          generation: 2,
        };
        const state = await observeManagedRebaseConflict(resolver, deps);
        const authorization = {
          ...resolver,
          conflictStateDigest: gitRebaseConflictStateDigest(state),
        };
        const resolution = "upstream + member one\n";
        await writeFile(join(authorization.worktreePath, "a.txt"), resolution);
        const request = {
          authorization,
          operationId: "resolve",
          expectedState: state,
          resolutions: [
            {
              kind: "regular" as const,
              path: "a.txt",
              newState: { mode: "100644" as const, digest: rawDigest(resolution) },
            },
          ],
        };
        await expect(continueManagedWorktreeRebase(request, deps)).rejects.toThrow(
          "registered all-member",
        );
        let observedTarget = "";
        const continuationDeps = {
          ...deps,
          runRebaseContinue: async (...args: Parameters<typeof f.runRebaseContinue>) => {
            observedTarget = args[0].targetRef;
            expect(args[0].cohort).toEqual(f.authority.envelope);
            return f.runRebaseContinue(...args);
          },
        };
        await f.ledger.worksetStore().setRoots(["tasks:T1"]);
        await expect(continueManagedWorktreeRebase(request, continuationDeps)).rejects.toThrow(
          "outside the admitted workset",
        );
        expect(await git(authorization.worktreePath, ["rev-parse", "HEAD"])).toBe(
          state.currentHead,
        );
        await f.ledger.worksetStore().setRoots(["tasks:T1", "tasks:T2"]);
        await expect(
          continueManagedWorktreeRebase(request, {
            ...continuationDeps,
            runRebaseContinue: async (...args) => {
              await continuationDeps.runRebaseContinue(...args);
              throw new Error("simulated crash after registered cohort continuation");
            },
          }),
        ).rejects.toThrow("simulated crash");
        const receipt = await continueManagedWorktreeRebase(request, continuationDeps);
        expect(receipt.version).toBe(2);
        expect(Object.hasOwn(receipt, "taskId")).toBe(false);
        expect(observedTarget).not.toBe("tasks:T1");
        expect(receipt.outcome.kind).toBe("terminal");
        expect(await readFile(join(authorization.worktreePath, "a.txt"), "utf8")).toBe(resolution);
        expect(await readFile(join(authorization.worktreePath, "b.txt"), "utf8")).toBe(
          "member two\n",
        );
        expect(await continueManagedWorktreeRebase(request, continuationDeps)).toEqual(receipt);
        await expect(
          validateGitConflictContinuationResultEvidence(
            authorization,
            {
              cohort: f.authority.envelope,
              resultCommit: receipt.newHead,
              branch: authorization.branch,
              actualWorktreePath: authorization.worktreePath,
              filesResolved: ["a.txt"],
              conflictReceipts: [receipt],
            },
            deps,
          ),
        ).resolves.toBeUndefined();
        expect(f.ledger.worksetStore().activeAdmissionCount()).toBe(0);
      } finally {
        await f.close();
      }
    });
  });
