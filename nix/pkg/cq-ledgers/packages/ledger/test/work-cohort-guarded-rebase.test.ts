import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { materializeGuardedRebaseBridge, reverifyGuardedRebaseBridge, resolveUniquePendingGuardedRebaseConflict, runGuardedRebase, type RunGuardedRebaseOptions } from "../src/guardedRebaseContinuation.js";
import { commitManagedWorktreeChanges } from "../src/gitChangeBroker.js";
import { cohortBrokerGit as git, cohortChangeRequest, cohortGitBrokerFixture, rawDigest } from "./workCohortGitBrokerFixture.js";
import { continueManagedWorktreeRebase, gitRebaseConflictStateDigest, observeManagedRebaseConflict } from "../src/gitConflictContinuation.js";
import { assertDispatchGuardedRebaseBridge } from "../../cq-config/src/guardedRebaseBridge.js";

async function seed(backend: "memory" | "sqlite", conflict: boolean) {
  const f = await cohortGitBrokerFixture(backend);
  try {
    const deps = { stateDir: f.deps.stateDir, cohortAuthority: f.authority, authorize: () => undefined };
    await commitManagedWorktreeChanges(await cohortChangeRequest(f.authorization, "member-a", "a", "base a\n", "member a\n"), deps);
    const receipt = await commitManagedWorktreeChanges(await cohortChangeRequest(f.authorization, "member-b", "b", "base b\n", "member b\n"), deps);
    const integrationFile = conflict ? "a.txt" : "unrelated.txt";
    await writeFile(join(f.root, integrationFile), "integration\n");
    await git(f.root, ["add", integrationFile]);
    await git(f.root, ["commit", "-qm", "integration"]);
    const ontoCommit = await git(f.root, ["rev-parse", "HEAD"]);
    const options = { binding: f.authorization, operationId: "cohort-rebase", ontoCommit,
      cohortAuthority: f.authority, store: f.ledger, stateDir: f.deps.stateDir } satisfies RunGuardedRebaseOptions;
    return { ...f, options, receipt, deps };
  } catch (error) { await f.close(); throw error; }
}

for (const backend of ["memory", "sqlite"] as const) {
  describe(`${backend} cohort guarded rebase [Behavioral-Active Blackbox-GoodCommunication]`, () => {
    // D590: the cohort rebase runs with the global Git config hidden. In a
    // repository whose identity lives only there (the production checkout),
    // every pick failed at its commit ("empty ident name") and was misread as
    // a content conflict.
    test("clean rebase commits without any repository-local Git identity", async () => {
      const f = await cohortGitBrokerFixture(backend);
      try {
        const request = await cohortChangeRequest(f.authorization, "candidate", "a", "base a\n", "candidate a\n");
        await commitManagedWorktreeChanges(request, { stateDir: f.deps.stateDir, cohortAuthority: f.authority, authorize: () => undefined });
        await writeFile(join(f.root, "unrelated.txt"), "integration\n");
        await git(f.root, ["add", "unrelated.txt"]);
        await git(f.root, ["commit", "-qm", "integration"]);
        const ontoCommit = await git(f.root, ["rev-parse", "HEAD"]);
        await git(f.root, ["config", "--unset", "user.name"]);
        await git(f.root, ["config", "--unset", "user.email"]);
        const result = await runGuardedRebase({ binding: f.authorization, operationId: "cohort-rebase-no-identity", ontoCommit,
          cohortAuthority: f.authority, store: f.ledger, stateDir: f.deps.stateDir });
        expect(result.kind).toBe("finalized");
        expect(await git(f.authorization.worktreePath, ["log", "-1", "--format=%cn <%ce>"])).toBe(
          "cq guarded rebase <cq-guarded-rebase@example.invalid>");
      } finally { await f.close(); }
    });

    test("clean rebase retains full cohort identity and exact replay", async () => {
      const f = await cohortGitBrokerFixture(backend);
      try {
        const request = await cohortChangeRequest(f.authorization, "candidate", "a", "base a\n", "candidate a\n");
        await commitManagedWorktreeChanges(request, { stateDir: f.deps.stateDir, cohortAuthority: f.authority, authorize: () => undefined });
        await writeFile(join(f.root, "unrelated.txt"), "integration\n");
        await git(f.root, ["add", "unrelated.txt"]);
        await git(f.root, ["commit", "-qm", "integration"]);
        const ontoCommit = await git(f.root, ["rev-parse", "HEAD"]);
        const options = { binding: f.authorization, operationId: "cohort-rebase", ontoCommit,
          cohortAuthority: f.authority, store: f.ledger, stateDir: f.deps.stateDir,
        };
        const result = await runGuardedRebase(options satisfies RunGuardedRebaseOptions);
        expect(result.kind).toBe("finalized");
        if (result.kind !== "finalized") throw new Error("expected finalized cohort rebase");
        expect(result.bridge).toMatchObject({ version: 2, cohort: f.authority.envelope });
        expect(Object.hasOwn(result.bridge, "taskId")).toBe(false);
        expect(await runGuardedRebase(options)).toEqual({ ...result, effect: null });
      } finally { await f.close(); }
    });
    test("all members, current epoch, and unchanged operation are required; interrupted intent resumes under a renewed epoch", async () => {
      const f = await seed(backend, false);
      try {
        await f.ledger.worksetStore().setRoots(["tasks:T1"]);
        await expect(runGuardedRebase(f.options)).rejects.toThrow("outside the admitted workset");
        expect(await git(f.authorization.worktreePath, ["rev-parse", "HEAD"])).toBe(f.receipt.newHead);
        await f.ledger.worksetStore().setRoots(["tasks:T1", "tasks:T2"]);
        await expect(runGuardedRebase({ ...f.options, onIntent: async () => { throw new Error("interrupted intent"); } })).rejects.toThrow("interrupted intent");
        await f.store.beginNewExecutionEpoch();
        await expect(runGuardedRebase(f.options)).rejects.toThrow("execution epoch");
        const authority = await f.makeAuthority("resumed");
        const current = { ...f.authorization, cohort: authority.envelope };
        const options = { ...f.options, binding: current, cohortAuthority: authority };
        await expect(runGuardedRebase({ ...options, ontoCommit: f.baseCommit })).rejects.toThrow("different request");
        const result = await runGuardedRebase(options);
        if (result.kind !== "finalized") throw new Error("expected clean resumed rebase");
        expect(result.bridge.cohort).toEqual(authority.envelope);
        expect(await runGuardedRebase(options)).toEqual({ ...result, effect: null });
        const bridge = await materializeGuardedRebaseBridge({ reference: result.reference, prior: f.authorization,
          current, cohortAuthority: authority, stateDir: f.deps.stateDir, baseCommitInput: result.bridge.ontoCommit,
          startingCommitInput: result.bridge.rebasedStartCommit, priorResultCommitInput: f.receipt.newHead });
        expect(bridge).toEqual(result.bridge);
        expect(() => assertDispatchGuardedRebaseBridge(bridge)).not.toThrow();
        expect(() => assertDispatchGuardedRebaseBridge({ ...bridge, taskId: "T1" })).toThrow("closed");
        await expect(reverifyGuardedRebaseBridge({ bridge, current, cohortAuthority: authority,
          stateDir: f.deps.stateDir, baseCommitInput: bridge.ontoCommit, startingCommitInput: bridge.rebasedStartCommit,
          firstInheritedOldHead: null })).resolves.toEqual(bridge);
        await expect(runGuardedRebase({ ...options, binding: { ...current, handleToken: "substituted" } })).rejects.toThrow();
      } finally { await f.close(); }
    });
    test("a registered conflicted rebase binds both member edits and exact ordered continuation receipts", async () => {
      const f = await seed(backend, true);
      try {
        expect((await runGuardedRebase(f.options)).kind).toBe("conflict-pending");
        const resolver = { ...f.authorization, generation: 2, roleId: "implement-conflict-resolver" as const };
        const state = await observeManagedRebaseConflict(resolver, f.deps);
        const pending = await resolveUniquePendingGuardedRebaseConflict(f.authorization, state, f.deps);
        await expect(materializeGuardedRebaseBridge({ reference: `cq-guarded-rebase:v1:${pending.requestDigest}`,
          prior: f.authorization, current: f.authorization, cohortAuthority: f.authority,
          stateDir: f.deps.stateDir, baseCommitInput: f.options.ontoCommit, startingCommitInput: state.currentHead,
          priorResultCommitInput: f.receipt.newHead })).rejects.toThrow("verified terminal tip");
        expect((await runGuardedRebase(f.options)).kind).toBe("conflict-pending");
        const resolution = "integration + member a\n";
        await writeFile(join(resolver.worktreePath, "a.txt"), resolution);
        const receipt = await continueManagedWorktreeRebase({ authorization: { ...resolver, conflictStateDigest: gitRebaseConflictStateDigest(state) },
          operationId: "resolve-all", expectedState: state, resolutions: [{ kind: "regular", path: "a.txt",
            newState: { mode: "100644", digest: rawDigest(resolution) } }] }, { ...f.deps, runRebaseContinue: f.runRebaseContinue });
        const result = await runGuardedRebase(f.options);
        if (result.kind !== "finalized" || result.bridge.version !== 2) throw new Error("expected finalized cohort conflict");
        expect(result.bridge.outcome).toBe("conflicted");
        expect(result.bridge.exactTip).toBe(false);
        expect(result.bridge.journals).toHaveLength(1);
        expect(result.bridge.journals[0]!.conflictReceiptDigests).toHaveLength(1);
        expect(result.bridge.rebasedStartCommit).toBe(receipt.newHead);
        expect(await readFile(join(resolver.worktreePath, "a.txt"), "utf8")).toBe(resolution);
        expect(await readFile(join(resolver.worktreePath, "b.txt"), "utf8")).toBe("member b\n");
        expect(await runGuardedRebase(f.options)).toEqual({ ...result, effect: null });
        const bridge = await materializeGuardedRebaseBridge({ reference: result.reference, prior: f.authorization,
          current: f.authorization, cohortAuthority: f.authority, stateDir: f.deps.stateDir,
          baseCommitInput: result.bridge.ontoCommit, startingCommitInput: result.bridge.rebasedStartCommit,
          priorResultCommitInput: f.receipt.newHead });
        expect(bridge).toEqual(result.bridge);
        expect(() => assertDispatchGuardedRebaseBridge({ ...bridge, journals: [] })).toThrow("ordered journal");
      } finally { await f.close(); }
    });
    test("multiple clean rebases compose an ordered immutable bridge and reject substituted order", async () => {
      const f = await seed(backend, false);
      try {
        const first = await runGuardedRebase(f.options);
        if (first.kind !== "finalized") throw new Error("expected first terminal journal");
        await f.store.beginNewExecutionEpoch();
        const authority = await f.makeAuthority("second-rebase");
        const current = { ...f.authorization, cohort: authority.envelope };
        expect(await runGuardedRebase({ ...f.options, binding: current, cohortAuthority: authority })).toEqual({ ...first, effect: null });
        await writeFile(join(f.root, "next.txt"), "next integration\n");
        await git(f.root, ["add", "next.txt"]);
        await git(f.root, ["commit", "-qm", "next integration"]);
        const ontoCommit = await git(f.root, ["rev-parse", "HEAD"]);
        const second = await runGuardedRebase({ ...f.options, binding: current, cohortAuthority: authority, operationId: "second-rebase", ontoCommit });
        if (second.kind !== "finalized") throw new Error("expected second terminal journal");
        const materialize = { reference: second.reference, prior: f.authorization, current, cohortAuthority: authority,
          stateDir: f.deps.stateDir, baseCommitInput: ontoCommit, startingCommitInput: second.bridge.rebasedStartCommit,
          priorResultCommitInput: f.receipt.newHead };
        const bridge = await materializeGuardedRebaseBridge(materialize);
        if (bridge.version !== 2) throw new Error("expected cohort bridge");
        expect(bridge.journals.map((entry) => entry.requestDigest)).toEqual([first.bridge.requestDigest, second.bridge.requestDigest]);
        expect(bridge.journals.map((entry) => entry.cohortEnvelopeDigest)).toEqual([f.authority.envelope.envelopeDigest, authority.envelope.envelopeDigest]);
        expect(() => assertDispatchGuardedRebaseBridge(bridge)).not.toThrow();
        const substituted = { ...bridge, journals: [...bridge.journals].reverse() };
        expect(() => assertDispatchGuardedRebaseBridge(substituted)).toThrow("contiguous");
        await expect(reverifyGuardedRebaseBridge({ ...materialize, bridge: substituted, firstInheritedOldHead: null })).rejects.toThrow("terminal journal");
        await expect(materializeGuardedRebaseBridge({ ...materialize, current: { ...current, handleFingerprint: "f".repeat(64) } })).rejects.toThrow("handleFingerprint");
      } finally { await f.close(); }
    });
    test("a crash after Git completion resumes under a renewed holder without repeating the rebase or rewriting producing epoch", async () => {
      const f = await seed(backend, false);
      try {
        let clocks = 0;
        await expect(runGuardedRebase({ ...f.options, now: () => {
          if (++clocks === 2) throw new Error("interrupted terminal persistence");
          return new Date();
        } })).rejects.toThrow("interrupted terminal persistence");
        const rebased = await git(f.authorization.worktreePath, ["rev-parse", "HEAD"]);
        expect(rebased).not.toBe(f.receipt.newHead);
        await f.store.beginNewExecutionEpoch();
        const authority = await f.makeAuthority("terminal-reconcile");
        const current = { ...f.authorization, cohort: authority.envelope };
        const result = await runGuardedRebase({ ...f.options, binding: current, cohortAuthority: authority });
        if (result.kind !== "finalized") throw new Error("expected terminal reconciliation");
        expect(result.effect).toBeNull();
        expect(result.bridge.rebasedStartCommit).toBe(rebased);
        expect(result.bridge.cohort).toEqual(f.authority.envelope);
        expect(await git(f.authorization.worktreePath, ["rev-list", "--count", `${f.options.ontoCommit}..HEAD`])).toBe("2");
      } finally { await f.close(); }
    });
  });
}
