/**
 * T1699 / D160 — Pi same-harness native isolation.
 *
 * Same-harness `forceShellout=false` launches through createAgentSession({cwd})
 * (or an equivalent injectable session seam) bound to the manager-returned
 * worktree path. It MUST NOT call launchPiChild.
 *
 * Forced shellout and cross-harness Pi continue on the registered process seam
 * ({@link createPiProcessDispatchAdapter}).
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
  qualifyPiNativeAdapter,
  type EscapeCanaryObservation,
  type NativeAdapterQualification,
  type PiNativeQualificationInput,
} from "./nativeDispatchQualification.js";
import {
  assertPiNativeWorktreeBindingIntact,
  preflightPiNativeWorktree,
  type PiNativeManagedWorktreeHandle,
  type PiNativeWorktreeBinding,
} from "./piNativeWorktree.js";

export interface PiNativeSessionLaunchRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  readonly signal?: AbortSignal;
}

export interface PiNativeSessionLaunchResult {
  readonly finalText: string;
  readonly cwd: string;
  readonly usedCreateAgentSession: true;
  readonly usedLaunchPiChild: false;
  readonly childId: string;
  readonly runId: string;
  readonly completedAt: string;
}

/**
 * Injectable session seam. Production binds createAgentSession({cwd}); tests
 * substitute fakes. Implementations MUST set usedLaunchPiChild=false.
 */
export type PiNativeSessionLauncher = (
  request: PiNativeSessionLaunchRequest,
) => Promise<PiNativeSessionLaunchResult> | PiNativeSessionLaunchResult;

export interface PiNativeAdapterBinding {
  /** Manager-returned absolute worktree path. */
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly provider?: string;
  readonly correlation: {
    readonly childId: string;
    readonly runId: string;
  };
  readonly now: () => string;
  readonly escapeCanary?: EscapeCanaryObservation;
  readonly signal?: AbortSignal;
  /**
   * Optional worktree_manage bind evidence. When any of path/handle/base/HEAD
   * is supplied, the launch path preflights integrity (mirror of
   * claudeNativeWorktree) and fails closed on mutation.
   */
  readonly worktree?: {
    readonly absolutePath?: string;
    readonly baseCommit?: string;
    readonly headCommit?: string;
    readonly handle?: PiNativeManagedWorktreeHandle;
    /** Prior bound snapshot used to detect post-bind mutation. */
    readonly expectedBinding?: PiNativeWorktreeBinding;
  };
}

export type PiNativeAdapterBindingResolver = (
  context: DispatchAdapterLaunchContext,
) => PiNativeAdapterBinding | Promise<PiNativeAdapterBinding>;

export interface CreatePiNativeDispatchAdapterOptions {
  readonly resolve: PiNativeAdapterBindingResolver;
  readonly launchSession: PiNativeSessionLauncher;
  /**
   * Optional precomputed qualification. When omitted, qualification is derived
   * from the binding's cwd + escape canary at launch time (fail closed).
   */
  readonly qualification?: NativeAdapterQualification;
}

function handleOf(context: DispatchAdapterLaunchContext): DispatchHandle {
  return Object.freeze({
    attestationId: context.prepared.attestationId,
    generation: context.prepared.generation,
  });
}

/**
 * Build the pi:native transport adapter. Registration is still subject to
 * positive-only qualification — callers should pass the adapter through
 * {@link buildPositiveOnlyDispatchRegistry}.
 */
export function createPiNativeDispatchAdapter(
  options: CreatePiNativeDispatchAdapterOptions,
): DispatchTransportAdapter {
  const launch: DispatchAdapterLauncher = async (context) => {
    const binding = await options.resolve(context);

    // worktree_manage bind preflight (mirror claudeNativeWorktree): when the
    // caller supplies path/handle/base/HEAD, fail closed on any integrity miss
    // or post-bind mutation before opening the native session.
    if (binding.worktree !== undefined) {
      const wt = binding.worktree;
      const hasPreflightInput =
        wt.absolutePath !== undefined ||
        wt.baseCommit !== undefined ||
        wt.headCommit !== undefined ||
        wt.handle !== undefined;
      if (hasPreflightInput) {
        if (
          wt.absolutePath === undefined ||
          wt.baseCommit === undefined ||
          wt.headCommit === undefined
        ) {
          return {
            outcome: "aborted",
            reason: "protocol-violation",
            details: {
              violation: "pi-native-worktree-preflight-incomplete",
              detail:
                "Pi native worktree bind requires absolutePath + baseCommit + headCommit together",
            },
          };
        }
        const preflight = preflightPiNativeWorktree({
          absolutePath: wt.absolutePath,
          baseCommit: wt.baseCommit,
          headCommit: wt.headCommit,
          ...(wt.handle === undefined ? {} : { handle: wt.handle }),
        });
        if (preflight.status === "refused") {
          return {
            outcome: "aborted",
            reason: "protocol-violation",
            details: {
              violation: "pi-native-worktree-preflight-refused",
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
              violation: "pi-native-worktree-cwd-mismatch",
              cwd: binding.cwd,
              absolutePath: preflight.absolutePath,
            },
          };
        }
      }
      if (wt.expectedBinding !== undefined) {
        try {
          assertPiNativeWorktreeBindingIntact(wt.expectedBinding, {
            ...(wt.absolutePath === undefined ? {} : { absolutePath: wt.absolutePath }),
            ...(wt.baseCommit === undefined ? {} : { baseCommit: wt.baseCommit }),
            ...(wt.headCommit === undefined ? {} : { headCommit: wt.headCommit }),
            ...(wt.handle === undefined ? {} : { handle: wt.handle }),
          });
        } catch (error) {
          return {
            outcome: "aborted",
            reason: "protocol-violation",
            details: {
              violation: "pi-native-worktree-binding-mutated",
              detail: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
    }

    const qualification =
      options.qualification ??
      qualifyPiNativeAdapter({
        cwd: binding.cwd,
        ...(binding.escapeCanary === undefined ? {} : { escapeCanary: binding.escapeCanary }),
      } satisfies PiNativeQualificationInput);
    assertNativeAdapterQualified(qualification);

    const sessionResult = await options.launchSession({
      cwd: binding.cwd,
      prompt: binding.prompt,
      ...(binding.systemPrompt === undefined ? {} : { systemPrompt: binding.systemPrompt }),
      ...(binding.model === undefined ? {} : { model: binding.model }),
      ...(binding.effort === undefined ? {} : { effort: binding.effort }),
      ...(binding.provider === undefined ? {} : { provider: binding.provider }),
      ...(binding.signal === undefined ? {} : { signal: binding.signal }),
    });

    if (sessionResult.usedLaunchPiChild !== false || sessionResult.usedCreateAgentSession !== true) {
      return {
        outcome: "aborted",
        reason: "protocol-violation",
        details: {
          violation: "pi-native-used-process-seam",
          usedLaunchPiChild: sessionResult.usedLaunchPiChild,
          usedCreateAgentSession: sessionResult.usedCreateAgentSession,
        },
      };
    }

    if (sessionResult.cwd !== binding.cwd) {
      return {
        outcome: "aborted",
        reason: "protocol-violation",
        details: {
          violation: "pi-native-cwd-drift",
          expected: binding.cwd,
          observed: sessionResult.cwd,
        },
      };
    }

    // Child stores via the adapter child port when the session is driven under
    // the compact protocol. For the transport adapter contract we require the
    // caller-supplied session launcher to have produced a final handle-only
    // text OR the child port already stored. Prefer an already-stored result.
    const handle = handleOf(context);
    let storeState: "stored-or-external" | "missing" = "stored-or-external";
    try {
      // Best-effort: if the launcher embedded a JSON handle and body, reject.
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
          details: { violation: "pi-native-echoed-body", finalTextBytes: sessionResult.finalText.length },
        };
      }
    } catch {
      // non-JSON final text is acceptable for non-compact pi tool dispatches
      storeState = "stored-or-external";
    }
    void storeState;

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
      // Process-equivalent structural handle-only is NOT claimed here; the
      // session launcher owns interception. Native same-harness pi uses
      // trusted-extension completion with prompt-best-effort handle-only unless
      // the launcher proves structural interception.
      handleOnlyEnforcement: "prompt-best-effort",
    };
    return completion satisfies DispatchAdapterLaunchResult;
  };

  return createNativeDispatchAdapter("pi", launch);
}

/**
 * Structural pin: same-harness forceShellout=false source must reference
 * createAgentSession (or the injectable session seam) and must not call
 * launchPiChild on that path.
 */
export const PI_NATIVE_SESSION_SEAM = "createAgentSession" as const;
export const PI_PROCESS_SESSION_SEAM = "launchPiChild" as const;

/**
 * Route decision for Pi child delivery. Pure function so tests pin the matrix
 * without spawning.
 */
export function selectPiChildDelivery(input: {
  readonly activeHarness: "claude" | "codex" | "pi";
  readonly forceShellout: boolean;
}): "native-session" | "process" {
  if (input.activeHarness === "pi" && input.forceShellout === false) {
    return "native-session";
  }
  return "process";
}
