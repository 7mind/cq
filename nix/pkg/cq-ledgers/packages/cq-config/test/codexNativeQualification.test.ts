/** T2044 — Codex native registration requires both trusted Git provider gates. */
import { describe, expect, test } from "bun:test";
import {
  CODEX_PROVIDER_FAILURE_CONTROLS,
  CODEX_PROVIDER_PRETURN_BINDINGS,
  CODEX_PROVIDER_ROUTES,
  buildPositiveOnlyDispatchRegistry,
  createNativeDispatchAdapter,
  qualifyCodexNativeAdapter,
  type CodexProviderGateObservation,
  type ManagedWorktreeHandle,
  type NativeQualificationRefusalReason,
} from "@cq/config";

const taskId = "T2044";
const worktreeId = "019fef67-3aa4-73a7-90f0-60c2fa5b3a9b";
const repositoryRoot = "/tmp/cq";
const cwd = `${repositoryRoot}/.claude/worktrees/${worktreeId}`;

const handle: ManagedWorktreeHandle = {
  kind: "cq-managed-worktree-handle",
  version: 1,
  token: "t2044-managed-handle-token",
  worktreeId,
  taskId,
  branch: `implement/${taskId}`,
  repositoryRoot,
  absolutePath: cwd,
  baseCommit: "a".repeat(40),
  createdAt: "2026-08-11T00:00:00.000Z",
  nonce: "t2044-nonce",
};

function gate(
  roleId: "implement-worker" | "implement-conflict-resolver",
): CodexProviderGateObservation {
  return {
    kind: "cq-codex-provider-gate",
    version: 1,
    roleId,
    effect: roleId === "implement-worker" ? "git-commit" : "git-conflict-continue",
    packagedBoundary: true,
    substituted: false,
    preturnBindings: CODEX_PROVIDER_PRETURN_BINDINGS,
    routes: CODEX_PROVIDER_ROUTES,
    receiptChainVerified: true,
    directGitDenied: true,
    confinementVerified: true,
    objectAttributionVerified: true,
    parentReleaseVerified: true,
    lifecycle: "single-or-typed-abort",
    behavior: roleId === "implement-worker" ? "commit-and-resume" : "multi-step-rebase",
    failureControls: CODEX_PROVIDER_FAILURE_CONTROLS,
    runnerExecution: {} as never,
  };
}

function verdict(input: Parameters<typeof qualifyCodexNativeAdapter>[0] | undefined) {
  const qualification = qualifyCodexNativeAdapter(input);
  const registry = buildPositiveOnlyDispatchRegistry({
    adapters: [
      createNativeDispatchAdapter("codex", () => {
        throw new Error("qualification test never launches");
      }),
    ],
    nativeQualifications: [qualification],
  });
  return {
    status: qualification.status,
    reason: qualification.status === "incompatible" ? qualification.reason : null,
    defect:
      qualification.status === "incompatible"
        ? qualification.defect
        : qualification.defectClosed,
    confinement: qualification.confinement,
    registered: registry.has("codex:native"),
  };
}

function incompatible(reason: NativeQualificationRefusalReason) {
  return {
    status: "incompatible" as const,
    reason,
    defect: "D307" as const,
    confinement: "unproven" as const,
    registered: false,
  };
}

describe("T2044 Codex native composed qualification", () => {
  test("rejects caller-authored provider observations without runner authentication", () => {
    const qualification = verdict({
      cwd,
      handle,
      repositoryRoot,
      taskId,
      workerGate: gate("implement-worker"),
      resolverGate: gate("implement-conflict-resolver"),
    });
    expect(qualification).toEqual(incompatible("provider-gate-failed"));
    const fabricatedRegistry = buildPositiveOnlyDispatchRegistry({
      adapters: [
        createNativeDispatchAdapter("codex", () => {
          throw new Error("fabricated qualification must not launch");
        }),
      ],
      nativeQualifications: [
        {
          status: "qualified",
          adapterId: "codex:native",
          targetHarness: "codex",
          transport: "native",
          confinement: "structural",
          evidence: "caller-authored",
          defectClosed: "D307",
        },
      ],
    });
    expect(fabricatedRegistry.has("codex:native")).toBe(false);
  });

  test("registers only after the exact managed binding and both unsubstituted provider gates", () => {
    const workerGate = gate("implement-worker");
    const resolverGate = gate("implement-conflict-resolver");
    const valid = { cwd, handle, repositoryRoot, taskId, workerGate, resolverGate };
    expect([
      verdict(undefined),
      verdict({ ...valid, resolverGate: undefined } as never),
      verdict({ ...valid, resolverGate: { ...resolverGate, substituted: true } } as never),
      verdict({
        ...valid,
        resolverGate: {
          ...resolverGate,
          preturnBindings: resolverGate.preturnBindings.slice(1),
        },
      }),
      verdict({ ...valid, cwd: "relative/worktree" }),
      verdict({ ...valid, handle: { ...handle, token: "" } }),
      verdict({
        ...valid,
        cwd: `${repositoryRoot}/.claude/worktrees/11111111-1111-1111-1111-111111111111`,
      }),
      verdict({ ...valid, repositoryRoot: "/tmp/foreign" }),
      verdict({ ...valid, taskId: "T2045" }),
      verdict({
        ...valid,
        workerGate: {
          ...workerGate,
          roleId: "implement-conflict-resolver",
          effect: "git-conflict-continue",
        },
      } as never),
      verdict({ ...valid, workerGate: { ...workerGate, routes: ["native"] } }),
      verdict({ ...valid, workerGate: { ...workerGate, receiptChainVerified: false } } as never),
      verdict({ ...valid, workerGate: { ...workerGate, behavior: "multi-step-rebase" } }),
      verdict({
        ...valid,
        workerGate: {
          ...workerGate,
          failureControls: workerGate.failureControls.slice(0, -1),
        },
      }),
      verdict(valid),
    ]).toEqual([
      incompatible("provider-gates-required"),
      incompatible("provider-gates-required"),
      incompatible("provider-gate-failed"),
      incompatible("provider-gate-failed"),
      incompatible("cwd-not-absolute"),
      incompatible("handle-invalid"),
      incompatible("handle-path-mismatch"),
      incompatible("handle-repository-mismatch"),
      incompatible("handle-task-mismatch"),
      incompatible("provider-gate-failed"),
      incompatible("provider-gate-failed"),
      incompatible("provider-gate-failed"),
      incompatible("provider-gate-failed"),
      incompatible("provider-gate-failed"),
      incompatible("provider-gate-failed"),
    ]);
  });
});
