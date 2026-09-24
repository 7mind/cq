/**
 * G224 — the Codex sandbox a CQ-launched child runs in. Roles that change the
 * managed worktree write it; every other dispatched role is read-only. The
 * `[dispatch] unsafeDisableCodexReadOnlySandbox` override is applied later by
 * the launcher itself (`resolveCodexRoleSandboxPolicy`), not here.
 */

import type { CodexRoleSandboxMode } from "./codexRoleBoundary.js";

export const CODEX_DISPATCHED_ROLE_SANDBOX_MODES: Readonly<Record<string, CodexRoleSandboxMode>> =
  Object.freeze({
    "implement-worker": "workspace-write",
    "implement-conflict-resolver": "workspace-write",
    "investigate-prober": "workspace-write",
    "research-experimenter": "workspace-write",
    "implement-reviewer": "read-only",
    "implementation-auditor": "read-only",
    "investigate-explorer": "read-only",
    "plan-advance": "read-only",
    "plan-reviewer": "read-only",
    "research-explorer": "read-only",
  });

export function codexDispatchedRoleSandboxMode(roleId: string): CodexRoleSandboxMode {
  const mode = CODEX_DISPATCHED_ROLE_SANDBOX_MODES[roleId];
  if (mode === undefined) {
    throw new Error(`no Codex sandbox policy for role ${JSON.stringify(roleId)}`);
  }
  return mode;
}
