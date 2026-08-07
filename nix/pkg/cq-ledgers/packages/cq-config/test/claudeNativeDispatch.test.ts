/**
 * D286 — createClaudeNativeDispatchAdapter bind→qualify→launch.
 */
import { describe, expect, test } from "bun:test";
import {
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

function handle(overrides: Partial<ClaudeNativeManagedWorktreeHandle> = {}): ClaudeNativeManagedWorktreeHandle {
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
