import { describe, expect, test } from "bun:test";
import { preflightClaudeNativeWorktree, bindClaudeNativeWorktree, releaseClaudeNativeWorktree,
  assertClaudeNativeWorktreeBindingIntact, type ClaudeNativeWorktreeManagePort } from "../src/claudeNativeWorktree.js";
import { preflightPiNativeWorktree, bindPiNativeWorktree, releasePiNativeWorktree,
  assertPiNativeWorktreeBindingIntact } from "../src/piNativeWorktree.js";
import { assertCodexBoundaryEffectTargetRef } from "../src/codexRoleBoundary.js";
import { nativeManagedWorktreeEffectTarget, resolveNativeManagedWorktreeSubject } from "../src/nativeManagedWorktreeSubject.js";
import { cohortEffectTargetRefV1, cohortValueDigestV1 } from "@cq/process-control";
import { qualifyClaudeNativeAdapter, qualifyCodexNativeAdapter,
  type CodexProviderGateObservation } from "../src/nativeDispatchQualification.js";
import { createClaudeNativeDispatchAdapter } from "../src/claudeNativeDispatch.js";
import { createPiNativeDispatchAdapter } from "../src/piNativeDispatch.js";
import type { ManagedWorktreeHandleV3 } from "../src/managedWorktreeHandle.js";
import { cohortRoleEnvelope, cohortRoleMembers } from "./workCohortRoleFixture.js";
import { InMemoryAttestationStore, prepareDispatch, DISPATCH_OVERLAY_REGISTRY,
  sequentialDispatchRandomBytes, DispatchTransportAdapterRegistry,
  createNativeDispatchAdapter, dispatchEffectTargetRef, type DispatchJSONValue } from "../src/index.js";
import { runPreparedDispatchOverService } from "./fixtures/routedDispatchOverService.js";

function wire(value: unknown): DispatchJSONValue {
  return JSON.parse(JSON.stringify(value)) as DispatchJSONValue;
}

function nativeCohortHandleFixture() {
  const cohort = cohortRoleEnvelope();
  const worktreeId = "018f2c7a-6b21-7c44-9e10-7a3f5d9b2e08";
  const handle: ManagedWorktreeHandleV3 = {
    kind: "cq-managed-worktree-handle", version: 3, token: "cohort-native-token", worktreeId,
    repositoryRoot: "/repo", absolutePath: `/repo/.claude/worktrees/${worktreeId}`,
    branch: `implement/cohort-${cohort.intent.intentDigest}`, baseCommit: "1".repeat(40),
    createdAt: "2026-09-22T00:00:00.000Z", nonce: "cohort-native-nonce",
    cohort: { kind: "cq-cohort-worktree-identity", version: 1, cohortId: cohort.definition.cohortId,
      definitionDigest: cohort.definition.definitionDigest, candidateIntentDigest: cohort.intent.intentDigest,
      memberSetDigest: cohort.memberSetDigest, memberAuthorities: cohort.memberAuthorities },
  };
  return { cohort, handle };
}

describe("native full-cohort provider binding [Blackbox-Atomic]", () => {
  for (const harness of ["claude", "codex", "pi"] as const) {
    test(`${harness} public router derives the complete persisted cohort effect target`, async () => {
      const namespace = { backend: "xdg" as const, projectKey: "cohort-router" };
      const store = new InMemoryAttestationStore(namespace);
      const now = () => "2026-09-22T00:00:00.000Z";
      const cohort = cohortRoleEnvelope();
      const branch = `implement/cohort-${cohort.intent.intentDigest}`;
      const prepared = prepareDispatch({ namespace, roleId: "implement-worker", surface: harness,
        input: wire({ cohort, members: cohortRoleMembers(cohort), worktreePath: "/tmp/cohort-router", branch,
          baseCommit: "1".repeat(40), startingCommit: "1".repeat(40), round: 0, validationIntent: "final" }),
        idempotencyKey: harness, timeoutMs: 600_000, registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest: "a".repeat(64), catalogHash: "b".repeat(64), expectedChild: { childId: `${harness}-child`, runId: `${harness}-run` },
        gitEffectBinding: { cohort, branch, handleToken: "cohort-handle", handleFingerprint: "5".repeat(64),
          repositoryRoot: "/tmp", repositoryId: cohort.definition.repository.repositoryId, commonDir: "/tmp/.git",
          worktreePath: "/tmp/cohort-router", ref: `refs/heads/${branch}`, baseCommit: "1".repeat(40) },
      }, { store, now, randomBytes: sequentialDispatchRandomBytes() });
      if (!prepared.accepted) throw new Error(JSON.stringify(prepared));
      const targets: string[] = [];
      const registry = new DispatchTransportAdapterRegistry([createNativeDispatchAdapter(harness, async (context) => {
        targets.push(context.effectTargetRef);
        expect((await context.child.materializeInput()).input).toMatchObject({ cohort });
        return { outcome: "aborted", reason: "native-failure" };
      })]);
      const result = await runPreparedDispatchOverService({ namespace, prepared: prepared.prepared,
        activeHarness: harness, targetHarness: harness, forceShellout: false,
        resolvedModel: { harness, model: "test-model", provider: harness === "pi" ? "test-provider" : null, effort: null },
      }, registry, { store, now });
      expect(result.outcome).toBe("aborted");
      expect(targets).toEqual([cohortEffectTargetRefV1(cohort)]);
    });
  }

  test("cohort router rejects anchor substitution and changed envelope bytes", () => {
    const cohort = cohortRoleEnvelope();
    for (const field of ["taskId", "goalId", "defectId", "researchId"]) {
      expect(() => dispatchEffectTargetRef(wire({ cohort, [field]: "T701" }))).toThrow();
    }
    expect(() => dispatchEffectTargetRef(wire({ cohort: { ...cohort, executionEpoch: "substituted" } }))).toThrow();
  });
  for (const [name, preflight, bind, release, assertIntact] of [
    ["Claude", preflightClaudeNativeWorktree, bindClaudeNativeWorktree, releaseClaudeNativeWorktree, assertClaudeNativeWorktreeBindingIntact],
    ["Pi", preflightPiNativeWorktree, bindPiNativeWorktree, releasePiNativeWorktree, assertPiNativeWorktreeBindingIntact],
  ] as const) {
    test(`${name} accepts an exact V3 handle and full envelope`, () => {
      const { handle, cohort } = nativeCohortHandleFixture();
      const input = { handle, cohort, absolutePath: handle.absolutePath,
        baseCommit: handle.baseCommit, headCommit: handle.baseCommit };
      expect(preflight(input).status).toBe("verified");
    });

    test(`${name} refuses missing, substituted, or anchored full cohort identities`, () => {
      const { handle, cohort } = nativeCohortHandleFixture();
      const input = { handle, absolutePath: handle.absolutePath,
        baseCommit: handle.baseCommit, headCommit: handle.baseCommit };
      expect(preflight(input).status).toBe("refused");
      const { handle: _handle, ...missingHandle } = input;
      expect(preflight({ ...missingHandle, cohort }).status).toBe("refused");
      expect(preflight({ ...input, cohort, taskId: "T701" } as Parameters<typeof preflight>[0]).status).toBe("refused");
      expect(preflight({ ...input, cohort, handle: { ...handle,
        cohort: { ...handle.cohort, memberAuthorities: handle.cohort.memberAuthorities.slice(0, 1) } } }).status).toBe("refused");
      expect(preflight({ ...input, cohort: { ...cohort, executionEpoch: "substituted-without-digest" } }).status).toBe("refused");
    });

    test(`${name} forwards the complete envelope through managed prepare and release`, async () => {
      const { handle, cohort } = nativeCohortHandleFixture();
      const prepares: Parameters<ClaudeNativeWorktreeManagePort["prepare"]>[0][] = [];
      const releases: Parameters<ClaudeNativeWorktreeManagePort["release"]>[0][] = [];
      const port: ClaudeNativeWorktreeManagePort = {
        async prepare(request) {
          prepares.push(request);
          return { status: "prepared", handle, evidence: { worktreeId: handle.worktreeId,
            absolutePath: handle.absolutePath, branch: handle.branch, baseCommit: handle.baseCommit,
            headCommit: handle.baseCommit, mode: "resume" } };
        },
        async release(request) {
          releases.push(request);
          return { status: "released", handle, absolutePath: handle.absolutePath, idempotent: false };
        },
      };
      const result = await bind({ port, handle, cohort, observeHead: () => handle.baseCommit });
      expect(result.status).toBe("bound");
      if (result.status !== "bound") throw new Error(result.detail);
      expect(prepares).toEqual([{ handle, cohort }]);
      expect(Object.hasOwn(prepares[0]!, "taskId")).toBe(false);
      expect(result.binding.cohort).toEqual(cohort);
      const { envelopeDigest: _oldDigest, ...payload } = cohort;
      const renewedPayload = { ...payload, executionEpoch: "renewed-epoch" };
      const renewed = { ...renewedPayload, envelopeDigest: cohortValueDigestV1(renewedPayload) };
      expect(() => assertIntact(result.binding, { cohort: renewed })).toThrow("cohort-mutated");
      expect((await release({ port, binding: result.binding, terminalDisposition: "done" })).status).toBe("released");
      expect(releases).toEqual([{ handle, cohort, terminalDisposition: "done" }]);
    });

    test(`${name} refuses substitution of an opaque resumed cohort handle`, async () => {
      const { handle, cohort } = nativeCohortHandleFixture();
      const port: ClaudeNativeWorktreeManagePort = {
        async prepare() {
          return { status: "prepared", handle: { ...handle, token: "substituted-token" },
            evidence: { worktreeId: handle.worktreeId, absolutePath: handle.absolutePath,
              branch: handle.branch, baseCommit: handle.baseCommit, headCommit: handle.baseCommit, mode: "resume" } };
        },
        async release() { throw new Error("refused handle must not release"); },
      };
      expect((await bind({ port, handle, cohort, observeHead: () => handle.baseCommit })).status).toBe("refused");
    });
  }

  test("Codex uses the full cohort target and refuses a representative task", () => {
    const { handle, cohort } = nativeCohortHandleFixture();
    const target = nativeManagedWorktreeEffectTarget({ handle, cohort });
    expect(target).toBe(cohortEffectTargetRefV1(cohort));
    expect(assertCodexBoundaryEffectTargetRef(target, cohort)).toBe(target);
    expect(() => nativeManagedWorktreeEffectTarget({ handle })).toThrow("full cohort envelope");
    expect(() => assertCodexBoundaryEffectTargetRef(target)).toThrow("canonical");
    expect(() => assertCodexBoundaryEffectTargetRef("tasks:T701", cohort)).toThrow("full envelope");
    expect(() => resolveNativeManagedWorktreeSubject({ handle, cohort, taskId: "T701" })).toThrow("anchor task");
  });

  test("Claude registration requires the V3 envelope as well as the handle", () => {
    const { handle, cohort } = nativeCohortHandleFixture();
    const input = { cwd: handle.absolutePath, handle, cohort };
    expect(qualifyClaudeNativeAdapter({ cwd: handle.absolutePath, handle }).status).toBe("incompatible");
    expect(qualifyClaudeNativeAdapter(input).status).toBe("qualified");
  });

  test("Codex full-cohort identity never substitutes for authenticated provider evidence", () => {
    const { handle, cohort } = nativeCohortHandleFixture();
    const untrusted = {} as CodexProviderGateObservation;
    const input = { cwd: handle.absolutePath, handle, cohort, repositoryRoot: handle.repositoryRoot,
      workerGate: untrusted, resolverGate: untrusted };
    const { cohort: _cohort, ...missingEnvelope } = input;
    expect(qualifyCodexNativeAdapter(input)).toMatchObject({ status: "incompatible", reason: "provider-gate-failed" });
    expect(qualifyCodexNativeAdapter(missingEnvelope)).toMatchObject({ status: "incompatible", reason: "handle-task-mismatch" });
    expect(qualifyCodexNativeAdapter({ ...input, taskId: "T701" })).toMatchObject({ status: "incompatible", reason: "handle-task-mismatch" });
  });

  for (const [name, create] of [["Claude", createClaudeNativeDispatchAdapter], ["Pi", createPiNativeDispatchAdapter]] as const) {
    test(`${name} native launch carries the full cohort through preflight and qualification`, async () => {
      const { handle, cohort } = nativeCohortHandleFixture();
      let launches = 0;
      const adapter = create({
        resolve: () => ({ cwd: handle.absolutePath, prompt: "Inspect every member",
          correlation: { childId: "cohort-child", runId: "cohort-run" }, now: () => "2026-09-22T00:00:00.000Z",
          escapeCanary: { escaped: false, insideWriteOk: true, evidence: "manual native seam canary" },
          worktree: { absolutePath: handle.absolutePath, baseCommit: handle.baseCommit,
            headCommit: handle.baseCommit, handle, cohort } }),
        launchSession: async ({ cwd }: { cwd: string }) => {
          launches += 1;
          return { cwd, finalText: JSON.stringify({ attestationId: "native-cohort", generation: 1 }),
            usedClaudeNativeAgent: true, usedProcessShellout: false,
            usedCreateAgentSession: true, usedLaunchPiChild: false,
            childId: "cohort-child", runId: "cohort-run", completedAt: "2026-09-22T00:00:01.000Z" };
        },
      });
      const result = await adapter.launch({ prepared: { attestationId: "native-cohort", generation: 1 } } as never);
      expect(result).toMatchObject({ outcome: "completed" });
      expect(launches).toBe(1);
    });
  }
});
