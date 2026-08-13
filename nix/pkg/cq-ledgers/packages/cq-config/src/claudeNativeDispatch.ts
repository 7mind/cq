/**
 * D286 — Claude same-harness native transport adapter.
 *
 * Mirrors {@link createPiNativeDispatchAdapter}: resolve manager binding,
 * preflight worktree_manage handle integrity, K238/D287 qualify with
 * handle-shaped evidence, then launch via an injectable native session seam
 * (Claude Agent tool). MUST NOT use the process shellout path.
 */

import type { DispatchHandle, NativeCompletionProof } from "./compactDispatchProtocol.js";
import {
  createNativeDispatchAdapter,
  type DispatchAdapterCompletion,
  type DispatchAdapterLaunchContext,
  type DispatchAdapterLaunchResult,
  type DispatchAdapterLauncher,
  type DispatchTransportAdapter,
} from "./dispatchTransportRouter.js";
import {
  assertNativeAdapterQualified,
  qualifyClaudeNativeAdapter,
  type ClaudeNativeQualificationHandle,
  type NativeAdapterQualification,
} from "./nativeDispatchQualification.js";
import {
  assertClaudeNativeWorktreeBindingIntact,
  preflightClaudeNativeWorktree,
  type ClaudeNativeManagedWorktreeHandle,
  type ClaudeNativeWorktreeBinding,
} from "./claudeNativeWorktree.js";

export interface ClaudeNativeSessionLaunchRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface ClaudeNativeSessionLaunchResult {
  readonly finalText: string;
  readonly cwd: string;
  /** Must be true — Claude Agent native session, not process shellout. */
  readonly usedClaudeNativeAgent: true;
  readonly usedProcessShellout: false;
  readonly childId: string;
  readonly runId: string;
  readonly completedAt: string;
}

export type ClaudeNativeSessionLauncher = (
  request: ClaudeNativeSessionLaunchRequest,
) => Promise<ClaudeNativeSessionLaunchResult> | ClaudeNativeSessionLaunchResult;

export interface ClaudeNativeAdapterBinding {
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly correlation: {
    readonly childId: string;
    readonly runId: string;
  };
  readonly now: () => string;
  readonly signal?: AbortSignal;
  /**
   * Required worktree_manage bind evidence (D286/D287). Handle is mandatory for
   * K238 qualification — free boolean handoffs are refused.
   */
  readonly worktree: {
    readonly absolutePath: string;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly handle: ClaudeNativeManagedWorktreeHandle;
    readonly expectedBinding?: ClaudeNativeWorktreeBinding;
  };
}

export type ClaudeNativeAdapterBindingResolver = (
  context: DispatchAdapterLaunchContext,
) => ClaudeNativeAdapterBinding | Promise<ClaudeNativeAdapterBinding>;

export interface CreateClaudeNativeDispatchAdapterOptions {
  readonly resolve: ClaudeNativeAdapterBindingResolver;
  readonly launchSession: ClaudeNativeSessionLauncher;
  /** Optional precomputed qualification; otherwise derived from handle+cwd. */
  readonly qualification?: NativeAdapterQualification;
}

function handleOf(context: DispatchAdapterLaunchContext): DispatchHandle {
  return Object.freeze({
    attestationId: context.prepared.attestationId,
    generation: context.prepared.generation,
  });
}

function asQualificationHandle(
  handle: ClaudeNativeManagedWorktreeHandle,
): ClaudeNativeQualificationHandle {
  return {
    kind: "cq-managed-worktree-handle",
    version: handle.version,
    token: handle.token,
    worktreeId: handle.worktreeId,
    taskId: handle.taskId,
    branch: handle.branch,
    repositoryRoot: handle.repositoryRoot,
    absolutePath: handle.absolutePath,
    baseCommit: handle.baseCommit,
    createdAt: handle.createdAt,
    nonce: handle.nonce,
  };
}

/**
 * Build the claude:native transport adapter. Pass through
 * {@link buildPositiveOnlyDispatchRegistry} with a K238-qualified entry.
 */
export function createClaudeNativeDispatchAdapter(
  options: CreateClaudeNativeDispatchAdapterOptions,
): DispatchTransportAdapter {
  const launch: DispatchAdapterLauncher = async (
    context,
  ): Promise<DispatchAdapterLaunchResult> => {
    const binding = await options.resolve(context);
    const wt = binding.worktree;

    const preflight = preflightClaudeNativeWorktree({
      absolutePath: wt.absolutePath,
      baseCommit: wt.baseCommit,
      headCommit: wt.headCommit,
      handle: wt.handle,
    });
    if (preflight.status === "refused") {
      return {
        outcome: "aborted",
        reason: "protocol-violation",
        details: {
          violation: "claude-native-worktree-preflight-refused",
          reason: preflight.reason,
          detail: preflight.detail,
        },
      };
    }
    if (preflight.absolutePath !== binding.cwd) {
      return {
        outcome: "aborted",
        reason: "protocol-violation",
        details: {
          violation: "claude-native-worktree-cwd-mismatch",
          cwd: binding.cwd,
          absolutePath: preflight.absolutePath,
        },
      };
    }

    if (wt.expectedBinding !== undefined) {
      try {
        assertClaudeNativeWorktreeBindingIntact(wt.expectedBinding, {
          absolutePath: wt.absolutePath,
          baseCommit: wt.baseCommit,
          headCommit: wt.headCommit,
          handle: wt.handle,
        });
      } catch (error) {
        return {
          outcome: "aborted",
          reason: "protocol-violation",
          details: {
            violation: "claude-native-worktree-binding-mutated",
            detail: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    const qualification =
      options.qualification ??
      qualifyClaudeNativeAdapter({
        cwd: binding.cwd,
        handle: asQualificationHandle(wt.handle),
      });
    try {
      assertNativeAdapterQualified(qualification);
    } catch (error) {
      return {
        outcome: "aborted",
        reason: "protocol-violation",
        details: {
          violation: "claude-native-qualification-refused",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const sessionResult = await options.launchSession({
      cwd: binding.cwd,
      prompt: binding.prompt,
      ...(binding.systemPrompt === undefined ? {} : { systemPrompt: binding.systemPrompt }),
      ...(binding.model === undefined ? {} : { model: binding.model }),
      ...(binding.signal === undefined ? {} : { signal: binding.signal }),
    });

    if (
      sessionResult.usedProcessShellout !== false ||
      sessionResult.usedClaudeNativeAgent !== true
    ) {
      return {
        outcome: "aborted",
        reason: "protocol-violation",
        details: {
          violation: "claude-native-used-process-seam",
          usedProcessShellout: sessionResult.usedProcessShellout,
          usedClaudeNativeAgent: sessionResult.usedClaudeNativeAgent,
        },
      };
    }

    if (sessionResult.cwd !== binding.cwd) {
      return {
        outcome: "aborted",
        reason: "protocol-violation",
        details: {
          violation: "claude-native-cwd-drift",
          expected: binding.cwd,
          observed: sessionResult.cwd,
        },
      };
    }

    const handle = handleOf(context);
    try {
      const parsed = JSON.parse(sessionResult.finalText) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "attestationId" in parsed &&
        Object.keys(parsed as object).some((key) => key !== "attestationId" && key !== "generation")
      ) {
        return {
          outcome: "aborted",
          reason: "protocol-violation",
          details: {
            violation: "claude-native-echoed-body",
            finalTextBytes: sessionResult.finalText.length,
          },
        };
      }
    } catch {
      // non-JSON final text acceptable outside compact handle-only protocol
    }

    const nativeCompletion: NativeCompletionProof = Object.freeze({
      kind: "native-completion",
      actor: "trusted-extension",
      childId: sessionResult.childId || binding.correlation.childId,
      runId: sessionResult.runId || binding.correlation.runId,
      completedAt: sessionResult.completedAt || binding.now(),
    });

    const completion: DispatchAdapterCompletion = {
      outcome: "completed",
      handle,
      nativeCompletion,
      handleOnlyEnforcement: "prompt-best-effort",
    };
    return completion satisfies DispatchAdapterLaunchResult;
  };

  return createNativeDispatchAdapter("claude", launch);
}

/** Structural pin: Claude native session seam name (Agent tool path). */
export const CLAUDE_NATIVE_SESSION_SEAM = "claude-agent-native" as const;
