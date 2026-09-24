/**
 * G224: the Codex sandbox a CQ-launched child runs in, per role. It must agree
 * with the Claude surface's attested write denials, so one role never gets
 * write access on one harness and not the other.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  CODEX_DISPATCHED_ROLE_SANDBOX_MODES,
  codexDispatchedRoleSandboxMode,
} from "../src/codexRoleSandboxPolicy.js";

const CLAUDE_ROLE_FRAGMENTS = path.resolve(
  import.meta.dir, "..", "..", "..", "..", "cq-assets", "fragments", "claude", "agents",
);
const WRITE_TOOLS = ["Write", "Edit"] as const;

function claudeDeniesWrites(roleId: string): boolean {
  const declaration = readFileSync(path.join(CLAUDE_ROLE_FRAGMENTS, roleId, "host-tool-vocabulary.md"), "utf8")
    .split("\n")
    .find((line) => line.startsWith("disallowedTools:"));
  if (declaration === undefined) throw new Error(`${roleId} declares no disallowedTools`);
  const denied = declaration.slice("disallowedTools:".length).split(",").map((tool) => tool.trim());
  return WRITE_TOOLS.every((tool) => denied.includes(tool));
}

describe("codexDispatchedRoleSandboxMode", () => {
  test("worktree-changing roles write; every other role is read-only", () => {
    expect(codexDispatchedRoleSandboxMode("implement-worker")).toBe("workspace-write");
    expect(codexDispatchedRoleSandboxMode("implement-conflict-resolver")).toBe("workspace-write");
    expect(codexDispatchedRoleSandboxMode("implement-reviewer")).toBe("read-only");
    expect(codexDispatchedRoleSandboxMode("research-explorer")).toBe("read-only");
  });

  test("agrees with the Claude surface's attested write denials for every dispatched role", () => {
    for (const [roleId, mode] of Object.entries(CODEX_DISPATCHED_ROLE_SANDBOX_MODES)) {
      expect(mode === "read-only", roleId).toBe(claudeDeniesWrites(roleId));
    }
  });

  test("covers exactly the roles the Claude surface dispatches", () => {
    expect(Object.keys(CODEX_DISPATCHED_ROLE_SANDBOX_MODES).sort()).toEqual(readdirSync(CLAUDE_ROLE_FRAGMENTS).sort());
  });

  test("refuses a role it does not know", () => {
    expect(() => codexDispatchedRoleSandboxMode("advance")).toThrow(/advance/);
  });
});
