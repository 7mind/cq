/**
 * T1698/D263 — Claude native path consumes worktree_manage prepare/release.
 * Path/handle/base mutation fails closed. Escape canaries pin the seams.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_NATIVE_WORKTREE_PREPARE_SEAM,
  CLAUDE_NATIVE_WORKTREE_RELEASE_SEAM,
  ClaudeNativeWorktreeBindingError,
  assertClaudeNativeWorktreeBindingIntact,
  bindClaudeNativeWorktree,
  preflightClaudeNativeWorktree,
  releaseClaudeNativeWorktree,
  type ClaudeNativeManagedWorktreeHandle,
  type ClaudeNativeWorktreeBinding,
  type ClaudeNativeWorktreeManagePort,
} from "@cq/config";

const SRC = fileURLToPath(new URL("../src/claudeNativeWorktree.ts", import.meta.url));
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PATH = "/tmp/project/.claude/worktrees/018f2c7a-6b21-7c44-9e10-7a3f5d9b2e08";
const ADOPTED_PATH = "/tmp/project/.claude/worktrees/implement-T1207";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function handle(overrides: Partial<ClaudeNativeManagedWorktreeHandle> = {}): ClaudeNativeManagedWorktreeHandle {
  return {
    kind: "cq-managed-worktree-handle",
    version: 1,
    token: "tok-1",
    worktreeId: "018f2c7a-6b21-7c44-9e10-7a3f5d9b2e08",
    taskId: "T1698",
    branch: "implement/T1698",
    repositoryRoot: "/tmp/project",
    absolutePath: PATH,
    baseCommit: BASE,
    createdAt: "2026-08-07T00:00:00.000Z",
    nonce: "nonce-1",
    ...overrides,
  };
}

function adoptedHandle(
  overrides: Partial<ClaudeNativeManagedWorktreeHandle> = {},
): ClaudeNativeManagedWorktreeHandle {
  return {
    ...handle(),
    version: 2,
    taskId: "T1207",
    branch: "implement/T1207",
    absolutePath: ADOPTED_PATH,
    ...overrides,
  };
}

function binding(overrides: Partial<ClaudeNativeWorktreeBinding> = {}): ClaudeNativeWorktreeBinding {
  const h = handle();
  return {
    handle: h,
    absolutePath: h.absolutePath,
    baseCommit: h.baseCommit,
    headCommit: HEAD,
    branch: h.branch,
    mode: "fresh",
    ...overrides,
  };
}

function port(opts: {
  prepareStatus?: "prepared" | "resume-required" | "refused";
  mutatePathOnPrepare?: boolean;
  mutateBaseOnPrepare?: boolean;
  mutateEvidenceBranch?: boolean;
  headOnEvidence?: string;
  preparedHandle?: ClaudeNativeManagedWorktreeHandle;
} = {}): ClaudeNativeWorktreeManagePort & {
  releases: number;
  prepares: number;
} {
  const api: ClaudeNativeWorktreeManagePort & { releases: number; prepares: number } = {
    prepares: 0,
    releases: 0,
    async prepare() {
      api.prepares += 1;
      if (opts.prepareStatus === "refused") {
        return { status: "refused", reason: "base-unresolvable", detail: "no base" };
      }
      const h = {
        ...(opts.preparedHandle ?? handle()),
        absolutePath: opts.mutatePathOnPrepare ? "/tmp/escaped" : PATH,
        baseCommit: opts.mutateBaseOnPrepare ? "c".repeat(40) : BASE,
        ...(opts.preparedHandle === undefined
          ? {}
          : {
              absolutePath: opts.preparedHandle.absolutePath,
              baseCommit: opts.preparedHandle.baseCommit,
            }),
      } as ClaudeNativeManagedWorktreeHandle;
      return {
        status: opts.prepareStatus === "resume-required" ? "resume-required" : "prepared",
        handle: h,
        evidence: {
          worktreeId: h.worktreeId,
          absolutePath: h.absolutePath,
          branch: opts.mutateEvidenceBranch ? "implement/T9999" : h.branch,
          baseCommit: h.baseCommit,
          headCommit: opts.headOnEvidence ?? HEAD,
          mode: opts.prepareStatus === "resume-required" ? "resume" : "fresh",
        },
      };
    },
    async release({ handle: released }) {
      api.releases += 1;
      return {
        status: "released",
        handle: released,
        idempotent: false,
        absolutePath: released.absolutePath,
      };
    },
  };
  return api;
}

describe("T1698 Claude native worktree_manage consumption", () => {
  test("seams are worktree_manage only — never raw git worktree lifecycle", () => {
    expect(CLAUDE_NATIVE_WORKTREE_PREPARE_SEAM).toBe("worktree_manage");
    expect(CLAUDE_NATIVE_WORKTREE_RELEASE_SEAM).toBe("worktree_manage");
    const source = readFileSync(SRC, "utf8");
    expect(source).toContain("worktree_manage");
    // Forbid raw lifecycle invocations (allow the phrase in comments that name the ban).
    expect(source).not.toMatch(/git worktree add\b/);
    expect(source).not.toMatch(/git worktree remove\b/);
    expect(source).not.toMatch(/git worktree prune\b/);
  });

  test("preflight verifies absolute path + full SHAs + handle integrity", () => {
    const ok = preflightClaudeNativeWorktree({
      absolutePath: PATH,
      baseCommit: BASE,
      headCommit: HEAD,
      expectedHead: HEAD,
      handle: handle(),
    });
    expect(ok).toEqual({
      status: "verified",
      absolutePath: PATH,
      baseCommit: BASE,
      headCommit: HEAD,
    });
  });

  test("T2047 binds a manager-issued canonical adopted T1207 v2 handle", async () => {
    const h = adoptedHandle();
    expect(
      preflightClaudeNativeWorktree({
        absolutePath: ADOPTED_PATH,
        baseCommit: BASE,
        headCommit: HEAD,
        expectedHead: HEAD,
        handle: h,
      }),
    ).toMatchObject({ status: "verified", absolutePath: ADOPTED_PATH });

    const bound = await bindClaudeNativeWorktree({
      port: port({ preparedHandle: h }),
      handle: h,
      observeHead: () => HEAD,
    });
    expect(bound).toMatchObject({
      status: "bound",
      binding: { absolutePath: ADOPTED_PATH, branch: "implement/T1207", handle: { version: 2 } },
    });
  });

  test("T2047 refuses unknown, mixed, traversal, foreign, and tampered v2 handles", () => {
    const valid = adoptedHandle();
    const invalidHandles = [
      { ...valid, version: 3 },
      { ...valid, version: 1 },
      { ...handle(), version: 2 },
      {
        ...valid,
        absolutePath: "/tmp/project/.claude/worktrees/../worktrees/implement-T1207",
      },
      { ...valid, repositoryRoot: "/tmp/foreign" },
      { ...valid, branch: "implement/T1208" },
      { ...valid, taskId: "T1208" },
    ];
    for (const invalid of invalidHandles) {
      expect(
        preflightClaudeNativeWorktree({
          absolutePath: ADOPTED_PATH,
          baseCommit: BASE,
          headCommit: HEAD,
          handle: invalid as never,
        }),
      ).toMatchObject({ status: "refused", reason: "handle-invalid" });
    }
  });

  test("path/handle/base mutation fails closed at preflight", () => {
    expect(
      preflightClaudeNativeWorktree({
        absolutePath: "relative",
        baseCommit: BASE,
        headCommit: HEAD,
      }).status,
    ).toBe("refused");
    expect(
      preflightClaudeNativeWorktree({
        absolutePath: PATH,
        baseCommit: "short",
        headCommit: HEAD,
      }),
    ).toMatchObject({ status: "refused", reason: "base-not-full-sha" });
    expect(
      preflightClaudeNativeWorktree({
        absolutePath: PATH,
        baseCommit: BASE,
        headCommit: HEAD,
        expectedHead: "d".repeat(40),
      }),
    ).toMatchObject({ status: "refused", reason: "head-mismatch" });
    expect(
      preflightClaudeNativeWorktree({
        absolutePath: PATH,
        baseCommit: BASE,
        headCommit: HEAD,
        handle: handle({ absolutePath: "/tmp/other" }),
      }),
    ).toMatchObject({ status: "refused", reason: "handle-invalid" });
    expect(
      preflightClaudeNativeWorktree({
        absolutePath: PATH,
        baseCommit: BASE,
        headCommit: HEAD,
        handle: handle({ baseCommit: "e".repeat(40) }),
      }),
    ).toMatchObject({ status: "refused", reason: "handle-base-mismatch" });
  });

  test("bind prepares via port, preflights HEAD, supports resume-by-handle", async () => {
    const p = port();
    const bound = await bindClaudeNativeWorktree({
      port: p,
      taskId: "T1698",
      baseCommit: BASE,
      observeHead: () => HEAD,
    });
    expect(bound.status).toBe("bound");
    if (bound.status !== "bound") throw new Error("expected bound");
    expect(bound.binding.mode).toBe("fresh");
    expect(bound.binding.absolutePath).toBe(PATH);
    expect(p.prepares).toBe(1);

    const p2 = port({ prepareStatus: "resume-required" });
    const resumed = await bindClaudeNativeWorktree({
      port: p2,
      handle: handle(),
      observeHead: async () => HEAD,
    });
    expect(resumed.status).toBe("bound");
    if (resumed.status !== "bound") throw new Error("expected bound");
    expect(resumed.binding.mode).toBe("resume");
  });

  test("bind fails closed when prepare path/base/head drifts (escape canaries)", async () => {
    const pathEscaped = await bindClaudeNativeWorktree({
      port: port({ mutatePathOnPrepare: true }),
      taskId: "T1698",
      baseCommit: BASE,
      observeHead: () => HEAD,
    });
    expect(pathEscaped).toMatchObject({ status: "refused", reason: "handle-invalid" });

    const branchEscaped = await bindClaudeNativeWorktree({
      port: port({ mutateEvidenceBranch: true }),
      taskId: "T1698",
      baseCommit: BASE,
      observeHead: () => HEAD,
    });
    expect(branchEscaped).toMatchObject({ status: "refused", reason: "handle-invalid" });

    const baseEscaped = await bindClaudeNativeWorktree({
      port: port({ mutateBaseOnPrepare: true }),
      taskId: "T1698",
      baseCommit: BASE,
      observeHead: () => HEAD,
    });
    expect(baseEscaped.status).toBe("bound");
    if (baseEscaped.status === "bound") {
      expect(() =>
        assertClaudeNativeWorktreeBindingIntact(binding(), {
          baseCommit: baseEscaped.binding.baseCommit,
        }),
      ).toThrow(/base-mutated/);
    }

    const headMismatch = await bindClaudeNativeWorktree({
      port: port({ headOnEvidence: "f".repeat(40) }),
      taskId: "T1698",
      baseCommit: BASE,
      observeHead: () => HEAD,
    });
    expect(headMismatch).toMatchObject({ status: "refused", reason: "head-mismatch" });
  });

  test("release goes only through worktree_manage port; mutated binding refuses", async () => {
    const p = port();
    const b = binding();
    const released = await releaseClaudeNativeWorktree({
      port: p,
      binding: b,
      terminalDisposition: "done",
      resultCommit: HEAD,
    });
    expect(released.status).toBe("released");
    expect(p.releases).toBe(1);

    const refused = await releaseClaudeNativeWorktree({
      port: p,
      binding: binding({
        handle: handle({ absolutePath: "/tmp/mutated" }),
      }),
      terminalDisposition: "abandoned",
    });
    expect(refused.status).toBe("refused");
    expect(p.releases).toBe(1); // no additional release on refusal
  });

  test("MUTATION: closed handle identity field swaps are detected", () => {
    const before = sha256(readFileSync(SRC, "utf8"));
    const expected = binding();
    expect(() =>
      assertClaudeNativeWorktreeBindingIntact(expected, {
        handle: handle({ token: "tok-MUTATED" }),
      }),
    ).toThrow(/handle-mutated/);
    expect(() =>
      assertClaudeNativeWorktreeBindingIntact(expected, {
        handle: handle({ createdAt: "2026-08-08T00:00:00.000Z" }),
      }),
    ).toThrow(/handle-mutated/);
    const after = sha256(readFileSync(SRC, "utf8"));
    expect(after).toBe(before);
  });
});
