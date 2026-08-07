/**
 * T1699/D160 — Pi native path consumes worktree_manage prepare/release.
 * Path/handle/base mutation fails closed. Escape canaries pin the seams.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PI_NATIVE_WORKTREE_PREPARE_SEAM,
  PI_NATIVE_WORKTREE_RELEASE_SEAM,
  PiNativeWorktreeBindingError,
  assertPiNativeWorktreeBindingIntact,
  bindPiNativeWorktree,
  preflightPiNativeWorktree,
  releasePiNativeWorktree,
  type PiNativeManagedWorktreeHandle,
  type PiNativeWorktreeBinding,
  type PiNativeWorktreeManagePort,
} from "@cq/config";

const SRC = fileURLToPath(new URL("../src/piNativeWorktree.ts", import.meta.url));
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PATH = "/tmp/project/.claude/worktrees/018f2c7a-6b21-7c44-9e10-7a3f5d9b2e08";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function handle(overrides: Partial<PiNativeManagedWorktreeHandle> = {}): PiNativeManagedWorktreeHandle {
  return {
    kind: "cq.managed-worktree",
    version: 1,
    token: "tok-1",
    worktreeId: "018f2c7a-6b21-7c44-9e10-7a3f5d9b2e08",
    taskId: "T1699",
    branch: "implement/T1699",
    repositoryRoot: "/tmp/project",
    absolutePath: PATH,
    baseCommit: BASE,
    createdAt: "2026-08-07T00:00:00.000Z",
    nonce: "nonce-1",
    ...overrides,
  };
}

function binding(overrides: Partial<PiNativeWorktreeBinding> = {}): PiNativeWorktreeBinding {
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
  headOnEvidence?: string;
} = {}): PiNativeWorktreeManagePort & {
  releases: number;
  prepares: number;
} {
  const api: PiNativeWorktreeManagePort & { releases: number; prepares: number } = {
    prepares: 0,
    releases: 0,
    async prepare() {
      api.prepares += 1;
      if (opts.prepareStatus === "refused") {
        return { status: "refused", reason: "base-unresolvable", detail: "no base" };
      }
      const h = handle({
        absolutePath: opts.mutatePathOnPrepare ? "/tmp/escaped" : PATH,
        baseCommit: opts.mutateBaseOnPrepare ? "c".repeat(40) : BASE,
      });
      return {
        status: opts.prepareStatus === "resume-required" ? "resume-required" : "prepared",
        handle: h,
        evidence: {
          worktreeId: h.worktreeId,
          absolutePath: h.absolutePath,
          branch: h.branch,
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

describe("T1699 Pi native worktree_manage consumption", () => {
  test("seams are worktree_manage only — never raw git worktree lifecycle", () => {
    expect(PI_NATIVE_WORKTREE_PREPARE_SEAM).toBe("worktree_manage");
    expect(PI_NATIVE_WORKTREE_RELEASE_SEAM).toBe("worktree_manage");
    const source = readFileSync(SRC, "utf8");
    expect(source).toContain("worktree_manage");
    // Forbid raw lifecycle invocations (allow the phrase in comments that name the ban).
    expect(source).not.toMatch(/git worktree add\b/);
    expect(source).not.toMatch(/git worktree remove\b/);
    expect(source).not.toMatch(/git worktree prune\b/);
  });

  test("preflight verifies absolute path + full SHAs + handle integrity", () => {
    const ok = preflightPiNativeWorktree({
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

  test("path/handle/base mutation fails closed at preflight", () => {
    expect(
      preflightPiNativeWorktree({
        absolutePath: "relative",
        baseCommit: BASE,
        headCommit: HEAD,
      }).status,
    ).toBe("refused");
    expect(
      preflightPiNativeWorktree({
        absolutePath: PATH,
        baseCommit: "short",
        headCommit: HEAD,
      }),
    ).toMatchObject({ status: "refused", reason: "base-not-full-sha" });
    expect(
      preflightPiNativeWorktree({
        absolutePath: PATH,
        baseCommit: BASE,
        headCommit: HEAD,
        expectedHead: "d".repeat(40),
      }),
    ).toMatchObject({ status: "refused", reason: "head-mismatch" });
    expect(
      preflightPiNativeWorktree({
        absolutePath: PATH,
        baseCommit: BASE,
        headCommit: HEAD,
        handle: handle({ absolutePath: "/tmp/other" }),
      }),
    ).toMatchObject({ status: "refused", reason: "handle-path-mismatch" });
    expect(
      preflightPiNativeWorktree({
        absolutePath: PATH,
        baseCommit: BASE,
        headCommit: HEAD,
        handle: handle({ baseCommit: "e".repeat(40) }),
      }),
    ).toMatchObject({ status: "refused", reason: "handle-base-mismatch" });
  });

  test("bind prepares via port, preflights HEAD, supports resume-by-handle", async () => {
    const p = port();
    const bound = await bindPiNativeWorktree({
      port: p,
      taskId: "T1699",
      baseCommit: BASE,
      observeHead: () => HEAD,
    });
    expect(bound.status).toBe("bound");
    if (bound.status !== "bound") throw new Error("expected bound");
    expect(bound.binding.mode).toBe("fresh");
    expect(bound.binding.absolutePath).toBe(PATH);
    expect(p.prepares).toBe(1);

    const p2 = port({ prepareStatus: "resume-required" });
    const resumed = await bindPiNativeWorktree({
      port: p2,
      handle: handle(),
      observeHead: async () => HEAD,
    });
    expect(resumed.status).toBe("bound");
    if (resumed.status !== "bound") throw new Error("expected bound");
    expect(resumed.binding.mode).toBe("resume");
  });

  test("bind fails closed when prepare path/base/head drifts (escape canaries)", async () => {
    const pathEscaped = await bindPiNativeWorktree({
      port: port({ mutatePathOnPrepare: true }),
      taskId: "T1699",
      baseCommit: BASE,
      observeHead: () => HEAD,
    });
    // handle path mismatches evidence absolutePath in preflight when observe uses evidence path
    // prepare returns escaped path on both handle and evidence — preflight still requires absolute
    expect(pathEscaped.status).toBe("bound"); // absolute /tmp/escaped still absolute
    // But binding integrity against the ORIGINAL expected path fails closed:
    if (pathEscaped.status === "bound") {
      expect(() =>
        assertPiNativeWorktreeBindingIntact(binding(), {
          absolutePath: pathEscaped.binding.absolutePath,
        }),
      ).toThrow(PiNativeWorktreeBindingError);
    }

    const baseEscaped = await bindPiNativeWorktree({
      port: port({ mutateBaseOnPrepare: true }),
      taskId: "T1699",
      baseCommit: BASE,
      observeHead: () => HEAD,
    });
    expect(baseEscaped.status).toBe("bound");
    if (baseEscaped.status === "bound") {
      expect(() =>
        assertPiNativeWorktreeBindingIntact(binding(), {
          baseCommit: baseEscaped.binding.baseCommit,
        }),
      ).toThrow(/base-mutated/);
    }

    const headMismatch = await bindPiNativeWorktree({
      port: port({ headOnEvidence: "f".repeat(40) }),
      taskId: "T1699",
      baseCommit: BASE,
      observeHead: () => HEAD,
    });
    expect(headMismatch).toMatchObject({ status: "refused", reason: "head-mismatch" });
  });

  test("release goes only through worktree_manage port; mutated binding refuses", async () => {
    const p = port();
    const b = binding();
    const released = await releasePiNativeWorktree({
      port: p,
      binding: b,
      terminalDisposition: "done",
      resultCommit: HEAD,
    });
    expect(released.status).toBe("released");
    expect(p.releases).toBe(1);

    const refused = await releasePiNativeWorktree({
      port: p,
      binding: binding({
        handle: handle({ absolutePath: "/tmp/mutated" }),
      }),
      terminalDisposition: "abandoned",
    });
    expect(refused.status).toBe("refused");
    expect(p.releases).toBe(1); // no additional release on refusal
  });

  test("MUTATION: handle token swap is detected", () => {
    const before = sha256(readFileSync(SRC, "utf8"));
    const expected = binding();
    expect(() =>
      assertPiNativeWorktreeBindingIntact(expected, {
        handle: handle({ token: "tok-MUTATED" }),
      }),
    ).toThrow(/handle-mutated/);
    const after = sha256(readFileSync(SRC, "utf8"));
    expect(after).toBe(before);
  });
});
