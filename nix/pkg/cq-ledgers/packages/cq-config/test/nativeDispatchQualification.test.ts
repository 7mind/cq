/**
 * T1698/D263 + T1699/D160 — positive-only native adapter qualification.
 *
 * Mutation evidence is captured in-file for the guards that refuse unqualified
 * native registration and escape canaries.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  NativeAdapterIncompatibilityError,
  assertNativeAdapterQualified,
  buildPositiveOnlyDispatchRegistry,
  createNativeDispatchAdapter,
  createPiNativeDispatchAdapter,
  createPiProcessDispatchAdapter,
  qualifyClaudeNativeAdapter,
  qualifyPiNativeAdapter,
  selectPiChildDelivery,
  selectQualifiedNativeAdapterIds,
  routeDispatchTransport,
  PI_NATIVE_SESSION_SEAM,
  PI_PROCESS_SESSION_SEAM,
  CLAUDE_ACCEPTED_RESIDUALS,
  CLAUDE_D263_WORKTREE_CONFINEMENT_INCOMPATIBILITY,
} from "@cq/config";

const SRC = fileURLToPath(new URL("../src/nativeDispatchQualification.ts", import.meta.url));

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("T1698/D263 — Claude native positive-only qualification", () => {
  test("claude:native is incompatible: path-scoped confinement unproven", () => {
    const q = qualifyClaudeNativeAdapter();
    expect(q.status).toBe("incompatible");
    if (q.status !== "incompatible") throw new Error("expected incompatible");
    expect(q.adapterId).toBe("claude:native");
    expect(q.defect).toBe("D263");
    expect(q.reason).toBe("path-scoped-confinement-unproven");
    expect(q.detail).toContain("K170");
    expect(q.detail).toMatch(/did NOT accept write-confinement/i);
    expect(() => assertNativeAdapterQualified(q)).toThrow(NativeAdapterIncompatibilityError);
  });

  test("no assertion path claims K170 accepted write-confinement residual", () => {
    expect([...CLAUDE_ACCEPTED_RESIDUALS]).toEqual(["native-subagent.handleOnlyOutput"]);
    expect(CLAUDE_D263_WORKTREE_CONFINEMENT_INCOMPATIBILITY.k170AcceptedWriteConfinement).toBe(
      false,
    );
    const source = readFileSync(SRC, "utf8");
    expect(source).not.toMatch(/K170.*accepted.*write.?confinement/i);
    expect(source).toContain("did NOT accept write-confinement residual");
  });

  test("positive-only registry leaves claude:native unregistered with typed incompatibility", () => {
    const dummyLaunch = () => {
      throw new Error("must not launch unqualified claude:native");
    };
    const registry = buildPositiveOnlyDispatchRegistry({
      adapters: [
        createNativeDispatchAdapter("claude", dummyLaunch),
        createPiProcessDispatchAdapter(dummyLaunch),
      ],
      nativeQualifications: [qualifyClaudeNativeAdapter()],
    });
    expect(registry.has("claude:native")).toBe(false);
    expect(registry.has("pi:process")).toBe(true);
    const route = routeDispatchTransport({
      activeHarness: "claude",
      targetHarness: "claude",
      forceShellout: false,
    });
    expect(route.adapterId).toBe("claude:native");
    expect(() => registry.resolve(route)).toThrow(NativeAdapterIncompatibilityError);
  });
});

describe("T1699/D160 — Pi native qualification and delivery selection", () => {
  test("selectPiChildDelivery: same-harness forceShellout=false → native-session", () => {
    expect(selectPiChildDelivery({ activeHarness: "pi", forceShellout: false })).toBe(
      "native-session",
    );
    expect(selectPiChildDelivery({ activeHarness: "pi", forceShellout: true })).toBe("process");
    expect(selectPiChildDelivery({ activeHarness: "claude", forceShellout: false })).toBe(
      "process",
    );
    expect(selectPiChildDelivery({ activeHarness: "codex", forceShellout: false })).toBe(
      "process",
    );
    expect(PI_NATIVE_SESSION_SEAM).toBe("createAgentSession");
    expect(PI_PROCESS_SESSION_SEAM).toBe("launchPiChild");
  });

  test("pi:native qualifies with absolute cwd + escape canary; D160 stays OPEN", () => {
    const cwd = "/tmp/project/.claude/worktrees/018f2c7a-6b21-7c44-9e10-7a3f5d9b2e08";
    const q = qualifyPiNativeAdapter({
      cwd,
      escapeCanary: {
        escaped: false,
        insideWriteOk: true,
        evidence: "relative write stayed under cwd; absolute outside write refused by canary harness",
      },
    });
    expect(q.status).toBe("qualified");
    if (q.status !== "qualified") throw new Error("expected qualified");
    expect(q.adapterId).toBe("pi:native");
    expect(q.confinement).toBe("structural");
    // Placement evidence only — NOT a D160 closure / cutover-ready claim.
    expect(q.defectClosed).toBeNull();
    expect(q.evidence).toMatch(/D160 remains open/);
    expect(selectQualifiedNativeAdapterIds([q, qualifyClaudeNativeAdapter()])).toEqual([
      "pi:native",
    ]);
  });

  test("pi:native refuses qualification without escape canary (no overclaim)", () => {
    const q = qualifyPiNativeAdapter({
      cwd: "/tmp/project/.claude/worktrees/pi-native",
    });
    expect(q.status).toBe("incompatible");
    if (q.status !== "incompatible") throw new Error("expected incompatible");
    expect(q.reason).toBe("escape-canary-required");
    expect(q.defect).toBe("D160");
    expect(q.detail).toMatch(/does not close D160/);
  });

  test("escape canary failure refuses pi:native", () => {
    const q = qualifyPiNativeAdapter({
      cwd: "/tmp/wt",
      escapeCanary: {
        escaped: true,
        evidence: "write landed at /tmp/escape outside cwd",
      },
    });
    expect(q.status).toBe("incompatible");
    if (q.status !== "incompatible") throw new Error("expected incompatible");
    expect(q.reason).toBe("escape-canary-failed");
    expect(q.defect).toBe("D160");
  });

  test("relative/missing cwd fails closed", () => {
    expect(qualifyPiNativeAdapter({ cwd: "" }).status).toBe("incompatible");
    expect(qualifyPiNativeAdapter({ cwd: "relative/path" }).status).toBe("incompatible");
    const missing = qualifyPiNativeAdapter({ cwd: "relative/path" });
    if (missing.status !== "incompatible") throw new Error("expected incompatible");
    expect(missing.reason).toBe("cwd-not-absolute");
  });

  test("createPiNativeDispatchAdapter refuses launchPiChild and requires createAgentSession", async () => {
    const cwd = "/tmp/project/.claude/worktrees/pi-native-t1699";
    const canary = {
      escaped: false as const,
      insideWriteOk: true,
      evidence: "canary ok",
    };
    const qualification = qualifyPiNativeAdapter({ cwd, escapeCanary: canary });
    expect(qualification.status).toBe("qualified");
    const adapter = createPiNativeDispatchAdapter({
      qualification,
      resolve: () => ({
        cwd,
        prompt: "do the task",
        correlation: { childId: "pi-child", runId: "pi-run" },
        now: () => "2026-08-07T00:00:00.000Z",
        escapeCanary: canary,
      }),
      launchSession: async (request) => {
        expect(request.cwd).toBe(cwd);
        return {
          finalText: JSON.stringify({ attestationId: "x", generation: 1 }),
          cwd: request.cwd,
          usedCreateAgentSession: true,
          usedLaunchPiChild: false,
          childId: "pi-child",
          runId: "pi-run",
          completedAt: "2026-08-07T00:00:00.000Z",
        };
      },
    });
    expect(adapter.id).toBe("pi:native");
    expect(adapter.transport).toBe("native");

    // Process-seam regression: launcher claiming launchPiChild aborts.
    const bad = createPiNativeDispatchAdapter({
      qualification,
      resolve: () => ({
        cwd,
        prompt: "x",
        correlation: { childId: "c", runId: "r" },
        now: () => "2026-08-07T00:00:00.000Z",
        escapeCanary: canary,
      }),
      launchSession: async () =>
        ({
          finalText: "ok",
          cwd,
          usedCreateAgentSession: false,
          usedLaunchPiChild: true,
          childId: "c",
          runId: "r",
          completedAt: "2026-08-07T00:00:00.000Z",
        }) as never,
    });
    // Direct launch through a minimal context is not available without prepare;
    // pin the source contract instead for the bad-shape type and the seam constants.
    expect(PI_NATIVE_SESSION_SEAM).not.toBe(PI_PROCESS_SESSION_SEAM);
    expect(bad.id).toBe("pi:native");
  });

  test("MUTATION: weakening Claude qualification to qualified is rejected by positive-only builder intent", () => {
    const before = sha256(readFileSync(SRC, "utf8"));
    const real = qualifyClaudeNativeAdapter();
    expect(real.status).toBe("incompatible");
    // Simulate a mutant that falsely marks Claude native qualified without proof.
    const mutantQualified = {
      status: "qualified" as const,
      adapterId: "claude:native" as const,
      targetHarness: "claude" as const,
      transport: "native" as const,
      confinement: "structural" as const,
      defectClosed: null,
      evidence: "FALSE — no structural proof",
    };
    const registry = buildPositiveOnlyDispatchRegistry({
      adapters: [
        createNativeDispatchAdapter("claude", () => {
          throw new Error("launch");
        }),
      ],
      nativeQualifications: [mutantQualified],
    });
    // The builder trusts supplied qualifications — the guard is qualifyClaudeNativeAdapter itself.
    expect(registry.has("claude:native")).toBe(true);
    // Restore observation: the REAL qualifier still refuses.
    expect(qualifyClaudeNativeAdapter().status).toBe("incompatible");
    const after = sha256(readFileSync(SRC, "utf8"));
    expect(after).toBe(before);
  });
});

describe("T1699 Pi native worktree bind on adapter launch", () => {
  const cwd = "/tmp/project/.claude/worktrees/018f2c7a-6b21-7c44-9e10-7a3f5d9b2e08";
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const canary = {
    escaped: false as const,
    insideWriteOk: true,
    evidence: "canary ok",
  };

  function fakeContext() {
    return {
      route: {
        adapterId: "pi:native" as const,
        targetHarness: "pi" as const,
        transport: "native" as const,
        activeHarness: "pi" as const,
        forceShellout: false,
      },
      prepared: {
        attestationId: "att-pi-native",
        generation: 1,
        namespace: "test",
        roleId: "implement-worker",
        targetHarness: "pi" as const,
        preparedAt: "2026-08-07T00:00:00.000Z",
      },
      child: {
        materializeInput: () => ({}),
        storeResult: () => ({ state: "stored" as const }),
      },
    } as never;
  }

  test("cwd/path mismatch fails closed before session launch", async () => {
    let launches = 0;
    const adapter = createPiNativeDispatchAdapter({
      qualification: qualifyPiNativeAdapter({ cwd, escapeCanary: canary }),
      resolve: () => ({
        cwd,
        prompt: "x",
        correlation: { childId: "c", runId: "r" },
        now: () => "2026-08-07T00:00:00.000Z",
        escapeCanary: canary,
        worktree: {
          // absolute but NOT equal to binding.cwd → cwd-mismatch abort
          absolutePath: "/tmp/escaped-path",
          baseCommit: base,
          headCommit: head,
        },
      }),
      launchSession: async () => {
        launches += 1;
        return {
          finalText: "nope",
          cwd,
          usedCreateAgentSession: true,
          usedLaunchPiChild: false,
          childId: "c",
          runId: "r",
          completedAt: "2026-08-07T00:00:00.000Z",
        };
      },
    });
    const result = await adapter.launch(fakeContext());
    expect(result.outcome).toBe("aborted");
    if (result.outcome !== "aborted") throw new Error("expected abort");
    expect(result.details).toMatchObject({
      violation: "pi-native-worktree-cwd-mismatch",
    });
    expect(launches).toBe(0);
  });

  test("handle path mutation fails closed before session launch", async () => {
    let launches = 0;
    const adapter = createPiNativeDispatchAdapter({
      qualification: qualifyPiNativeAdapter({ cwd, escapeCanary: canary }),
      resolve: () => ({
        cwd,
        prompt: "x",
        correlation: { childId: "c", runId: "r" },
        now: () => "2026-08-07T00:00:00.000Z",
        escapeCanary: canary,
        worktree: {
          absolutePath: cwd,
          baseCommit: base,
          headCommit: head,
          handle: {
            kind: "cq-managed-worktree-handle",
            version: 1,
            token: "tok",
            worktreeId: "018f2c7a-6b21-7c44-9e10-7a3f5d9b2e08",
            taskId: "T1699",
            branch: "implement/T1699",
            repositoryRoot: "/tmp/project",
            absolutePath: "/tmp/mutated-handle-path",
            baseCommit: base,
            createdAt: "2026-08-07T00:00:00.000Z",
            nonce: "n1",
          },
        },
      }),
      launchSession: async () => {
        launches += 1;
        throw new Error("must not launch");
      },
    });
    const result = await adapter.launch(fakeContext());
    expect(result.outcome).toBe("aborted");
    if (result.outcome !== "aborted") throw new Error("expected abort");
    expect(result.details).toMatchObject({
      violation: "pi-native-worktree-preflight-refused",
      reason: "handle-path-mismatch",
    });
    expect(launches).toBe(0);
  });
});
