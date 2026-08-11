/**
 * T1698 / D263 — Claude same-harness native path consumes worktree_manage.
 *
 * The orchestrator prepares via worktree_manage(prepare), preflights base/HEAD,
 * resumes by opaque handle, and releases ONLY through worktree_manage(release).
 * This module is the typed binding between that lifecycle and a Claude native
 * launch context. It does NOT register `claude:native` — registration is
 * positive-only and gated by {@link qualifyClaudeNativeAdapter}.
 *
 * Path/handle/base mutations fail closed: a binding is either intact or refused.
 */

import {
  isManagedWorktreeHandle,
  managedWorktreeHandlesEqual,
  type ManagedWorktreeHandle,
} from "./managedWorktreeHandle.js";
import { isAbsoluteFilesystemPath } from "./nativeDispatchQualification.js";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Structural handle shape returned by worktree_manage prepare (opaque to callers). */
export type ClaudeNativeManagedWorktreeHandle = ManagedWorktreeHandle;

export interface ClaudeNativePreparedEvidence {
  readonly worktreeId: string;
  readonly absolutePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly mode: "fresh" | "resume" | "adopted";
}

export type ClaudeNativeWorktreePrepareResult =
  | {
      readonly status: "prepared" | "resume-required";
      readonly handle: ClaudeNativeManagedWorktreeHandle;
      readonly evidence: ClaudeNativePreparedEvidence;
    }
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly detail: string;
    };

export type ClaudeNativeWorktreeReleaseResult =
  | {
      readonly status: "released";
      readonly handle: ClaudeNativeManagedWorktreeHandle;
      readonly idempotent: boolean;
      readonly absolutePath: string;
    }
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly detail: string;
    };

export interface ClaudeNativeWorktreePreflightRequest {
  readonly absolutePath: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly expectedHead?: string;
  readonly handle?: ClaudeNativeManagedWorktreeHandle;
}

export type ClaudeNativeWorktreePreflightResult =
  | {
      readonly status: "verified";
      readonly absolutePath: string;
      readonly baseCommit: string;
      readonly headCommit: string;
    }
  | {
      readonly status: "refused";
      readonly reason:
        | "path-not-absolute"
        | "base-not-full-sha"
        | "head-not-full-sha"
        | "head-mismatch"
        | "handle-path-mismatch"
        | "handle-base-mismatch"
        | "handle-invalid";
      readonly detail: string;
    };

export interface ClaudeNativeWorktreeBinding {
  readonly handle: ClaudeNativeManagedWorktreeHandle;
  readonly absolutePath: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly branch: string;
  readonly mode: "fresh" | "resume" | "adopted";
}

export type ClaudeNativeWorktreeBindResult =
  | { readonly status: "bound"; readonly binding: ClaudeNativeWorktreeBinding }
  | { readonly status: "refused"; readonly reason: string; readonly detail: string };

/**
 * Lifecycle port. Production wires MCP worktree_manage; tests inject fakes.
 * Release is the ONLY teardown path — no raw git worktree lifecycle commands.
 */
export interface ClaudeNativeWorktreeManagePort {
  prepare(request: {
    readonly taskId?: string;
    readonly baseCommit?: string;
    readonly handle?: ClaudeNativeManagedWorktreeHandle;
    readonly allowResumeRequired?: boolean;
    readonly priorResultCommit?: string | null;
    readonly adoptWorktreePath?: string;
    readonly expectedHead?: string;
  }): Promise<ClaudeNativeWorktreePrepareResult>;
  release(request: {
    readonly handle: ClaudeNativeManagedWorktreeHandle;
    readonly terminalDisposition: "done" | "abandoned";
    readonly resultCommit?: string | null;
    readonly deleteBranch?: boolean;
  }): Promise<ClaudeNativeWorktreeReleaseResult>;
}

export class ClaudeNativeWorktreeBindingError extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(`Claude native worktree binding refused (${reason}): ${detail}`);
    this.name = "ClaudeNativeWorktreeBindingError";
    this.reason = reason;
  }
}

function isHandleShape(value: unknown): value is ClaudeNativeManagedWorktreeHandle {
  return isManagedWorktreeHandle(value);
}

/** Preflight base/HEAD and optional handle integrity. Mutations fail closed. */
export function preflightClaudeNativeWorktree(
  request: ClaudeNativeWorktreePreflightRequest,
): ClaudeNativeWorktreePreflightResult {
  if (!isAbsoluteFilesystemPath(request.absolutePath)) {
    return Object.freeze({
      status: "refused" as const,
      reason: "path-not-absolute" as const,
      detail: `absolutePath must be absolute; got ${JSON.stringify(request.absolutePath)}`,
    });
  }
  if (!FULL_COMMIT_SHA.test(request.baseCommit)) {
    return Object.freeze({
      status: "refused" as const,
      reason: "base-not-full-sha" as const,
      detail: `baseCommit must be a full 40-char lowercase SHA; got ${JSON.stringify(request.baseCommit)}`,
    });
  }
  if (!FULL_COMMIT_SHA.test(request.headCommit)) {
    return Object.freeze({
      status: "refused" as const,
      reason: "head-not-full-sha" as const,
      detail: `headCommit must be a full 40-char lowercase SHA; got ${JSON.stringify(request.headCommit)}`,
    });
  }
  if (
    request.expectedHead !== undefined &&
    request.expectedHead !== request.headCommit
  ) {
    return Object.freeze({
      status: "refused" as const,
      reason: "head-mismatch" as const,
      detail:
        `HEAD ${JSON.stringify(request.headCommit)} does not equal expected ` +
        `${JSON.stringify(request.expectedHead)}`,
    });
  }
  if (request.handle !== undefined) {
    if (!isHandleShape(request.handle)) {
      return Object.freeze({
        status: "refused" as const,
        reason: "handle-invalid" as const,
        detail: "handle failed structural validation",
      });
    }
    if (request.handle.absolutePath !== request.absolutePath) {
      return Object.freeze({
        status: "refused" as const,
        reason: "handle-path-mismatch" as const,
        detail:
          `handle.absolutePath ${JSON.stringify(request.handle.absolutePath)} !== ` +
          `absolutePath ${JSON.stringify(request.absolutePath)}`,
      });
    }
    if (request.handle.baseCommit !== request.baseCommit) {
      return Object.freeze({
        status: "refused" as const,
        reason: "handle-base-mismatch" as const,
        detail:
          `handle.baseCommit ${JSON.stringify(request.handle.baseCommit)} !== ` +
          `baseCommit ${JSON.stringify(request.baseCommit)}`,
      });
    }
  }
  return Object.freeze({
    status: "verified" as const,
    absolutePath: request.absolutePath,
    baseCommit: request.baseCommit,
    headCommit: request.headCommit,
  });
}

/**
 * Prepare (or resume-by-handle) via worktree_manage, then preflight base/HEAD.
 * Returns a bound launch context or a typed refusal.
 */
export async function bindClaudeNativeWorktree(input: {
  readonly port: ClaudeNativeWorktreeManagePort;
  readonly taskId?: string;
  readonly baseCommit?: string;
  readonly handle?: ClaudeNativeManagedWorktreeHandle;
  readonly allowResumeRequired?: boolean;
  readonly priorResultCommit?: string | null;
  readonly adoptWorktreePath?: string;
  readonly expectedHead?: string;
  /** Observed HEAD after prepare; required for preflight. */
  readonly observeHead: (absolutePath: string) => Promise<string> | string;
}): Promise<ClaudeNativeWorktreeBindResult> {
  const adoptionFieldCount =
    Number(input.adoptWorktreePath !== undefined) + Number(input.expectedHead !== undefined);
  if (adoptionFieldCount === 1 || (adoptionFieldCount > 0 && input.handle !== undefined)) {
    return Object.freeze({
      status: "refused" as const,
      reason: "adoption-invalid",
      detail:
        "adoptWorktreePath and expectedHead must appear together on handle-free prepare",
    });
  }
  // worktree_manage requires taskId even on resume-by-handle; prefer explicit,
  // else take it from the opaque handle when present.
  const taskId =
    input.taskId ??
    (input.handle !== undefined && typeof input.handle.taskId === "string"
      ? input.handle.taskId
      : undefined);
  const prepared = await input.port.prepare({
    ...(taskId === undefined ? {} : { taskId }),
    ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    ...(input.handle === undefined ? {} : { handle: input.handle }),
    ...(input.allowResumeRequired === undefined
      ? {}
      : { allowResumeRequired: input.allowResumeRequired }),
    ...(input.priorResultCommit === undefined
      ? {}
      : { priorResultCommit: input.priorResultCommit }),
    ...(input.adoptWorktreePath === undefined
      ? {}
      : { adoptWorktreePath: input.adoptWorktreePath }),
    ...(input.expectedHead === undefined ? {} : { expectedHead: input.expectedHead }),
  });

  if (prepared.status === "refused") {
    return Object.freeze({
      status: "refused" as const,
      reason: prepared.reason,
      detail: prepared.detail,
    });
  }

  if (!isHandleShape(prepared.handle)) {
    return Object.freeze({
      status: "refused" as const,
      reason: "handle-invalid",
      detail: "prepare returned a non-structural handle",
    });
  }
  if (
    prepared.evidence.worktreeId !== prepared.handle.worktreeId ||
    prepared.evidence.branch !== prepared.handle.branch
  ) {
    return Object.freeze({
      status: "refused" as const,
      reason: "handle-invalid",
      detail: "prepare evidence worktreeId/branch diverged from the versioned handle identity",
    });
  }

  const headCommit = await input.observeHead(prepared.evidence.absolutePath);
  const preflight = preflightClaudeNativeWorktree({
    absolutePath: prepared.evidence.absolutePath,
    baseCommit: prepared.evidence.baseCommit,
    headCommit,
    expectedHead: prepared.evidence.headCommit,
    handle: prepared.handle,
  });
  if (preflight.status === "refused") {
    return Object.freeze({
      status: "refused" as const,
      reason: preflight.reason,
      detail: preflight.detail,
    });
  }

  return Object.freeze({
    status: "bound" as const,
    binding: Object.freeze({
      handle: prepared.handle,
      absolutePath: preflight.absolutePath,
      baseCommit: preflight.baseCommit,
      headCommit: preflight.headCommit,
      branch: prepared.evidence.branch,
      mode: prepared.evidence.mode,
    }),
  });
}

/**
 * Release ONLY through worktree_manage. Callers must not raw-remove the tree.
 */
export async function releaseClaudeNativeWorktree(input: {
  readonly port: ClaudeNativeWorktreeManagePort;
  readonly binding: ClaudeNativeWorktreeBinding;
  readonly terminalDisposition: "done" | "abandoned";
  readonly resultCommit?: string | null;
  readonly deleteBranch?: boolean;
}): Promise<ClaudeNativeWorktreeReleaseResult> {
  // Integrity check before release — mutated bindings fail closed.
  const preflight = preflightClaudeNativeWorktree({
    absolutePath: input.binding.absolutePath,
    baseCommit: input.binding.baseCommit,
    headCommit: input.binding.headCommit,
    handle: input.binding.handle,
  });
  if (preflight.status === "refused") {
    return Object.freeze({
      status: "refused" as const,
      reason: preflight.reason,
      detail: preflight.detail,
    });
  }
  return input.port.release({
    handle: input.binding.handle,
    terminalDisposition: input.terminalDisposition,
    ...(input.resultCommit === undefined ? {} : { resultCommit: input.resultCommit }),
    ...(input.deleteBranch === undefined ? {} : { deleteBranch: input.deleteBranch }),
  });
}

/**
 * Fail closed when a caller mutates path, handle identity, or base after bind.
 * Used by launch gates and tests (escape / mutation canaries).
 */
export function assertClaudeNativeWorktreeBindingIntact(
  expected: ClaudeNativeWorktreeBinding,
  observed: {
    readonly absolutePath?: string;
    readonly baseCommit?: string;
    readonly headCommit?: string;
    readonly handle?: ClaudeNativeManagedWorktreeHandle;
  },
): void {
  if (
    observed.absolutePath !== undefined &&
    observed.absolutePath !== expected.absolutePath
  ) {
    throw new ClaudeNativeWorktreeBindingError(
      "path-mutated",
      `absolutePath changed from ${JSON.stringify(expected.absolutePath)} to ` +
        JSON.stringify(observed.absolutePath),
    );
  }
  if (observed.baseCommit !== undefined && observed.baseCommit !== expected.baseCommit) {
    throw new ClaudeNativeWorktreeBindingError(
      "base-mutated",
      `baseCommit changed from ${JSON.stringify(expected.baseCommit)} to ` +
        JSON.stringify(observed.baseCommit),
    );
  }
  if (observed.headCommit !== undefined && observed.headCommit !== expected.headCommit) {
    throw new ClaudeNativeWorktreeBindingError(
      "head-mutated",
      `headCommit changed from ${JSON.stringify(expected.headCommit)} to ` +
        JSON.stringify(observed.headCommit),
    );
  }
  if (observed.handle !== undefined) {
    if (!isHandleShape(observed.handle)) {
      throw new ClaudeNativeWorktreeBindingError("handle-invalid", "observed handle is not structural");
    }
    if (!managedWorktreeHandlesEqual(observed.handle, expected.handle)) {
      throw new ClaudeNativeWorktreeBindingError(
        "handle-mutated",
        "one or more closed handle identity fields diverged from the bound handle",
      );
    }
    if (observed.handle.absolutePath !== expected.absolutePath) {
      throw new ClaudeNativeWorktreeBindingError(
        "handle-path-mutated",
        "handle.absolutePath diverged from the bound path",
      );
    }
    if (observed.handle.baseCommit !== expected.baseCommit) {
      throw new ClaudeNativeWorktreeBindingError(
        "handle-base-mutated",
        "handle.baseCommit diverged from the bound base",
      );
    }
  }
}

/**
 * Release policy pin: Claude native teardown vocabulary is worktree_manage only.
 * Tests grep this constant so a regression to raw lifecycle commands fails.
 */
export const CLAUDE_NATIVE_WORKTREE_RELEASE_SEAM = "worktree_manage" as const;

/** Prepare/resume vocabulary pin. */
export const CLAUDE_NATIVE_WORKTREE_PREPARE_SEAM = "worktree_manage" as const;
