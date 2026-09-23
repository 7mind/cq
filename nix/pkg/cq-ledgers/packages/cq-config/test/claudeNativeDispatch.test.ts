/**
 * D286 — createClaudeNativeDispatchAdapter bind→qualify→launch.
 */
import { describe, expect, test } from "bun:test";
import {
  CLAUDE_DELIVERY_MODES,
  CLAUDE_NATIVE_SESSION_SEAM,
  createClaudeNativeDispatchAdapter,
  qualifyClaudeNativeAdapter,
  type ClaudeNativeAdapterBinding,
  type ClaudeNativeManagedWorktreeHandle,
  type ClaudeNativeSessionLaunchResult,
} from "@cq/config";

const WORKTREE_ID = "018f2c7a-6b21-7c44-9e10-7a3f5d9b2e08";
const CWD = `/tmp/project/.claude/worktrees/${WORKTREE_ID}`;
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function handle(overrides: Partial<Extract<ClaudeNativeManagedWorktreeHandle, { version: 1 }>> = {}): ClaudeNativeManagedWorktreeHandle {
  return {
    kind: "cq-managed-worktree-handle",
    version: 1,
    token: "tok-d286",
    worktreeId: WORKTREE_ID,
    taskId: "T2015",
    branch: "implement/T2015",
    repositoryRoot: "/tmp/project",
    absolutePath: CWD,
    baseCommit: BASE,
    createdAt: "2026-08-07T00:00:00.000Z",
    nonce: "nonce-d286",
    ...overrides,
  };
}

function binding(
  overrides: Partial<ClaudeNativeAdapterBinding> = {},
): ClaudeNativeAdapterBinding {
  const h = handle();
  return {
    cwd: CWD,
    prompt: "implement the task",
    correlation: { childId: "c1", runId: "r1" },
    now: () => "2026-08-07T12:00:00.000Z",
    worktree: {
      absolutePath: CWD,
      baseCommit: BASE,
      headCommit: HEAD,
      handle: h,
    },
    ...overrides,
  };
}

function fakeContext() {
  return {
    prepared: {
      attestationId: "att-1",
      generation: 1,
      roleId: "implement-worker",
      inputDigest: "d".repeat(64),
      promptDigest: "p".repeat(64),
      catalogHash: "c".repeat(64),
      responseStoreNow: "2026-08-07T12:00:00.000Z",
      childCancelAt: "2026-08-07T12:05:00.000Z",
      launchDeadline: "2026-08-07T12:10:00.000Z",
    },
    surface: "claude" as const,
  };
}

describe("D286 createClaudeNativeDispatchAdapter", () => {
  test("seam pin is distinct from process shellout", () => {
    expect(CLAUDE_NATIVE_SESSION_SEAM).toBe("claude-agent-native");
  });

  test("D431: completion actor satisfies the router requirement for its own route", async () => {
    // The router's matrix test already proves claude:native reaches `consumed`
    // when the proof carries `trusted-parent`. What nothing pinned is that THIS
    // adapter produces it: a `trusted-extension` proof on this route aborts the
    // dispatch with `completion-actor-does-not-match-transport`, so the whole
    // same-harness Claude path never completes.
    const verdict = CLAUDE_DELIVERY_MODES.get("native-subagent");
    if (verdict === undefined) throw new Error("native-subagent delivery verdict is missing");
    const declared = verdict.completionActor;
    if (declared === undefined) {
      throw new Error("native-subagent verdict declares no completion actor");
    }
    expect(declared).toBe("trusted-parent");

    const adapter = createClaudeNativeDispatchAdapter({
      resolve: () => binding(),
      launchSession: async (req) =>
        ({
          finalText: JSON.stringify({ attestationId: "att-1", generation: 1 }),
          cwd: req.cwd,
          usedClaudeNativeAgent: true,
          usedProcessShellout: false,
          childId: "c1",
          runId: "r1",
          completedAt: "2026-08-07T12:00:01.000Z",
        }) satisfies ClaudeNativeSessionLaunchResult,
    });

    const result = await adapter.launch(fakeContext() as never);
    if (result.outcome !== "completed") throw new Error(`expected completion, got ${result.reason}`);

    // Re-derive the router's rule from the adapter's own route rather than
    // restating its answer, so a change on either side is caught here.
    const requiredActor =
      adapter.transport === "process" || adapter.targetHarness === "pi"
        ? "trusted-extension"
        : "trusted-parent";
    expect(requiredActor).toBe(declared);
    expect(result.nativeCompletion.actor).toBe(requiredActor);
  });

  // D432: the adapter derives its completion handle from `context.prepared`,
  // so a child claiming a DIFFERENT handle in its compact final text was
  // silently replaced by the expected one. The router compares the returned
  // handle and therefore only ever saw the substituted values, which made
  // attestation-only and generation-only mutations invisible.
  for (const [label, claimed] of [
    ["attestationId", { attestationId: "att-WRONG", generation: 1 }],
    ["generation", { attestationId: "att-1", generation: 99 }],
  ] as const) {
    test(`D432: refuses a compact final handle whose ${label} differs from the prepared one`, async () => {
      const adapter = createClaudeNativeDispatchAdapter({
        resolve: () => binding(),
        launchSession: async (req) =>
          ({
            finalText: JSON.stringify(claimed),
            cwd: req.cwd,
            usedClaudeNativeAgent: true,
            usedProcessShellout: false,
            childId: "c1",
            runId: "r1",
            completedAt: "2026-08-07T12:00:01.000Z",
          }) satisfies ClaudeNativeSessionLaunchResult,
      });
      const result = await adapter.launch(fakeContext() as never);
      expect(result.outcome).toBe("aborted");
      if (result.outcome === "aborted") {
        expect(result.reason).toBe("protocol-violation");
        expect(result.details).toMatchObject({
          violation: "claude-native-final-handle-mismatch",
        });
      }
    });
  }

  test("D432: non-JSON final text remains the accepted prompt-best-effort residual", async () => {
    const adapter = createClaudeNativeDispatchAdapter({
      resolve: () => binding(),
      launchSession: async (req) =>
        ({
          finalText: "done, stored via the result capability",
          cwd: req.cwd,
          usedClaudeNativeAgent: true,
          usedProcessShellout: false,
          childId: "c1",
          runId: "r1",
          completedAt: "2026-08-07T12:00:01.000Z",
        }) satisfies ClaudeNativeSessionLaunchResult,
    });
    expect((await adapter.launch(fakeContext() as never)).outcome).toBe("completed");
  });

  test("launches when handle+path qualify and session is native", async () => {
    let launchedCwd: string | undefined;
    const adapter = createClaudeNativeDispatchAdapter({
      resolve: () => binding(),
      launchSession: async (req) => {
        launchedCwd = req.cwd;
        return {
          finalText: JSON.stringify({ attestationId: "att-1", generation: 1 }),
          cwd: req.cwd,
          usedClaudeNativeAgent: true,
          usedProcessShellout: false,
          childId: "c1",
          runId: "r1",
          completedAt: "2026-08-07T12:00:01.000Z",
        } satisfies ClaudeNativeSessionLaunchResult;
      },
    });
    expect(adapter.id).toBe("claude:native");
    expect(adapter.transport).toBe("native");

    const result = await adapter.launch(fakeContext() as never);
    expect(result.outcome).toBe("completed");
    expect(launchedCwd).toBe(CWD);
    if (result.outcome === "completed") {
      expect(result.handleOnlyEnforcement).toBe("prompt-best-effort");
      expect(result.nativeCompletion.kind).toBe("native-completion");
    }
  });

  test("aborts when session uses process shellout", async () => {
    const adapter = createClaudeNativeDispatchAdapter({
      resolve: () => binding(),
      launchSession: async (req) =>
        ({
          finalText: "ok",
          cwd: req.cwd,
          usedClaudeNativeAgent: false,
          usedProcessShellout: true,
          childId: "c",
          runId: "r",
          completedAt: "2026-08-07T12:00:01.000Z",
        }) as never,
    });
    const result = await adapter.launch(fakeContext() as never);
    expect(result.outcome).toBe("aborted");
    if (result.outcome === "aborted") {
      expect(result.details).toMatchObject({ violation: "claude-native-used-process-seam" });
    }
  });

  test("aborts when handle path mismatches cwd (D287 gate)", async () => {
    const adapter = createClaudeNativeDispatchAdapter({
      resolve: () =>
        binding({
          worktree: {
            absolutePath: CWD,
            baseCommit: BASE,
            headCommit: HEAD,
            handle: handle({ absolutePath: "/tmp/evil/.claude/worktrees/" + WORKTREE_ID }),
          },
        }),
      launchSession: async () => {
        throw new Error("must not launch");
      },
    });
    const result = await adapter.launch(fakeContext() as never);
    expect(result.outcome).toBe("aborted");
  });

  test("precomputed qualification without handle shape is refused at assert", async () => {
    const badQ = qualifyClaudeNativeAdapter();
    expect(badQ.status).toBe("incompatible");
    const adapter = createClaudeNativeDispatchAdapter({
      resolve: () => binding(),
      launchSession: async () => {
        throw new Error("must not launch");
      },
      qualification: badQ,
    });
    const result = await adapter.launch(fakeContext() as never);
    expect(result.outcome).toBe("aborted");
    if (result.outcome === "aborted") {
      expect(result.details).toMatchObject({
        violation: "claude-native-qualification-refused",
      });
    }
  });
});
