/**
 * T2047 — versioned managed-worktree handle contract.
 * Behavioral-Active Blackbox-Atomic tests through the public ledger core seam.
 */
import { describe, expect, it } from "bun:test";
import {
  validateManagedWorktreeHandle,
  type ManagedWorktreeHandle,
} from "../src/index.js";

const WORKTREE_ID = "019f2c7a-6b21-7c44-9e10-7a3f5d9b2e08";
const BASE = "a".repeat(40);

function v1Handle(): Extract<ManagedWorktreeHandle, { readonly version: 1 }> {
  return {
    kind: "cq-managed-worktree-handle",
    version: 1,
    token: "opaque-v1-token",
    worktreeId: WORKTREE_ID,
    taskId: "T1207",
    branch: "implement/T1207",
    repositoryRoot: "/tmp/project",
    absolutePath: `/tmp/project/.claude/worktrees/${WORKTREE_ID}`,
    baseCommit: BASE,
    createdAt: "2026-08-10T00:00:00.000Z",
    nonce: "opaque-v1-nonce",
  };
}

function v2Handle(): Extract<ManagedWorktreeHandle, { readonly version: 2 }> {
  return {
    ...v1Handle(),
    version: 2,
    token: "opaque-v2-token",
    absolutePath: "/tmp/project/.claude/worktrees/implement-T1207",
    nonce: "opaque-v2-nonce",
  };
}

describe("T2047 managed-worktree handle version union [BA]", () => {
  it("keeps the version 1 wire object byte-for-byte unchanged", () => {
    const handle = v1Handle();
    const validation = validateManagedWorktreeHandle(handle, "/tmp/project");
    expect(validation).toEqual({ status: "valid", handle });
    expect(JSON.stringify(handle)).toBe(
      `{"kind":"cq-managed-worktree-handle","version":1,"token":"opaque-v1-token",` +
        `"worktreeId":"${WORKTREE_ID}","taskId":"T1207","branch":"implement/T1207",` +
        `"repositoryRoot":"/tmp/project","absolutePath":"/tmp/project/.claude/worktrees/${WORKTREE_ID}",` +
        `"baseCommit":"${BASE}","createdAt":"2026-08-10T00:00:00.000Z",` +
        `"nonce":"opaque-v1-nonce"}`,
    );
  });

  it("accepts version 2 with opaque UUIDv7 registry identity and canonical T1207 identity", () => {
    const handle = v2Handle();
    expect(validateManagedWorktreeHandle(handle, "/tmp/project")).toEqual({
      status: "valid",
      handle,
    });
    expect(handle.absolutePath.endsWith(handle.worktreeId)).toBe(false);
  });

  it.each([
    ["unknown version", { ...v2Handle(), version: 3 }, "handle-invalid"],
    ["v1 fields with v2 placement", { ...v2Handle(), version: 1 }, "handle-path-traversal"],
    ["v2 fields with v1 placement", { ...v1Handle(), version: 2 }, "handle-invalid"],
    [
      "path traversal",
      {
        ...v2Handle(),
        absolutePath: "/tmp/project/.claude/worktrees/../worktrees/implement-T1207",
      },
      "handle-path-traversal",
    ],
    [
      "foreign path",
      { ...v2Handle(), absolutePath: "/tmp/foreign/.claude/worktrees/implement-T1207" },
      "handle-foreign",
    ],
    ["branch tampering", { ...v2Handle(), branch: "implement/T1208" }, "handle-invalid"],
    ["task tampering", { ...v2Handle(), taskId: "T1208" }, "handle-invalid"],
    ["mixed extra field", { ...v2Handle(), placement: "adopted" }, "handle-invalid"],
  ])("refuses %s", (_name, handle, reason) => {
    expect(validateManagedWorktreeHandle(handle, "/tmp/project")).toMatchObject({
      status: "invalid",
      reason,
    });
  });
});
