/**
 * T1699 / D160 — Pi same-harness native session seam.
 *
 * Binds createAgentSession({ cwd, model, thinkingLevel }) to the
 * manager-returned worktree path. Same-harness forceShellout=false MUST use
 * this module and MUST NOT call launchPiChild (the registered process seam for
 * forced/cross-harness).
 *
 * Model/effort parity with the process path:
 *   pi -p --provider P --model M[:effort]
 * is applied here as createAgentSession({ model, thinkingLevel }).
 */

import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

export const PI_NATIVE_SESSION_SEAM = "createAgentSession" as const;
export const PI_PROCESS_SESSION_SEAM = "launchPiChild" as const;

/** Pi thinking-level / effort vocabulary (parity with process `--model …:effort`). */
export type PiNativeEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface PiNativeSessionRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  /**
   * Model id (or `provider/model` pattern). Parity with process `--model`.
   * When `provider` is also set, production resolves via resolveCliModel.
   */
  readonly model?: string;
  /** Provider id. Parity with process `--provider`. */
  readonly provider?: string;
  /**
   * Effort / thinking level. Parity with process `--model provider/model:effort`
   * trailing suffix. Applied as createAgentSession thinkingLevel.
   */
  readonly effort?: string;
  readonly excludeTools?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface PiNativeSessionResult {
  readonly finalText: string;
  readonly cwd: string;
  readonly usedCreateAgentSession: true;
  readonly usedLaunchPiChild: false;
  readonly childId: string;
  readonly runId: string;
  readonly completedAt: string;
  readonly messages: readonly unknown[];
  /** Echo of the model/effort actually handed to createAgentSession. */
  readonly appliedModel: string | null;
  readonly appliedProvider: string | null;
  readonly appliedEffort: string | null;
}

/**
 * Options observed by the injectable createAgentSession seam. Production wires
 * the pi-coding-agent SDK (resolving model+effort); tests substitute fakes.
 * MUST NOT call launchPiChild.
 */
export interface PiNativeCreateAgentSessionOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  readonly tools?: string[];
  readonly excludeTools?: string[];
}

export interface PiNativeSessionDependencies {
  readonly createAgentSession: (options: PiNativeCreateAgentSessionOptions) => Promise<{
    session: {
      /** Pi 0.84.2 AgentSession.prompt takes PromptOptions (no AbortSignal). */
      prompt: (text: string) => Promise<void>;
      /** Pi 0.84.2 abort path; PromptOptions no longer carries signal. */
      abort?: () => Promise<void> | void;
      agent: { waitForIdle: () => Promise<void>; state?: { messages?: unknown[] } };
      /** Observed model id after session open (optional; tests may set). */
      model?: { id?: string; provider?: string } | null;
      thinkingLevel?: string;
      dispose?: () => Promise<void> | void;
    };
  }>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

/**
 * True when `candidate` resolves inside `cwd` (path-scoped placement check).
 * Used by escape canaries; absolute paths outside fail.
 */
export function isPathInsideCwd(candidate: string, cwd: string): boolean {
  const root = resolvePath(cwd);
  const target = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(root, candidate);
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Escape canary: a relative write target must stay inside cwd; an absolute
 * outside target must be reported as an escape.
 */
export function observePathEscapeCanary(input: {
  readonly cwd: string;
  readonly relativeTarget: string;
  readonly absoluteOutsideTarget: string;
}): { readonly escaped: boolean; readonly evidence: string; readonly insideWriteOk: boolean } {
  const insideOk = isPathInsideCwd(input.relativeTarget, input.cwd);
  const outsideEscapes = !isPathInsideCwd(input.absoluteOutsideTarget, input.cwd);
  // Canary harness itself refuses outside paths — "escaped" means the SURFACE
  // would have allowed the outside write. Here the canary observes placement
  // geometry: inside ok + outside detected as outside ⇒ confinement geometry holds.
  const geometryHolds = insideOk && outsideEscapes;
  return {
    escaped: !geometryHolds,
    insideWriteOk: insideOk,
    evidence: geometryHolds
      ? `relative ${JSON.stringify(input.relativeTarget)} stays under cwd; absolute outside ${JSON.stringify(input.absoluteOutsideTarget)} detected`
      : `path geometry failed insideOk=${String(insideOk)} outsideDetected=${String(outsideEscapes)}`,
  };
}

function defaultIdFactory(): string {
  return randomUUID();
}

/**
 * Compose the process-equivalent `--model` token: `model` or `model:effort`.
 * Pure helper so tests pin parity with the process path.
 */
export function composePiModelArg(input: {
  readonly model: string | null | undefined;
  readonly effort: string | null | undefined;
}): string | null {
  if (input.model === undefined || input.model === null || input.model.trim() === "") {
    return null;
  }
  if (input.effort === undefined || input.effort === null || input.effort.trim() === "") {
    return input.model;
  }
  return `${input.model}:${input.effort}`;
}

/**
 * Run one Pi native child turn via createAgentSession({cwd, model, thinkingLevel}).
 * Never spawns launchPiChild.
 */
export async function runPiNativeSession(
  request: PiNativeSessionRequest,
  dependencies: PiNativeSessionDependencies,
): Promise<PiNativeSessionResult> {
  if (typeof request.cwd !== "string" || request.cwd.trim() === "" || !isAbsolute(request.cwd)) {
    throw new Error(
      `Pi native session requires an absolute manager-returned cwd; got ${JSON.stringify(request.cwd)}`,
    );
  }

  const now = dependencies.now ?? (() => new Date());
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const childId = idFactory();
  const runId = createHash("sha256").update(`${childId}:${request.cwd}`).digest("hex").slice(0, 32);

  const appliedModel = request.model ?? null;
  const appliedProvider = request.provider ?? null;
  const appliedEffort = request.effort ?? null;

  const { session } = await dependencies.createAgentSession({
    cwd: request.cwd,
    ...(appliedModel === null ? {} : { model: appliedModel }),
    ...(appliedProvider === null ? {} : { provider: appliedProvider }),
    ...(appliedEffort === null ? {} : { effort: appliedEffort }),
    ...(request.excludeTools === undefined
      ? {}
      : { excludeTools: [...request.excludeTools] }),
  });

  try {
    const promptText =
      request.systemPrompt === undefined || request.systemPrompt.trim() === ""
        ? request.prompt
        : `${request.systemPrompt}\n\n${request.prompt}`;
    const abortSession = async (): Promise<void> => {
      if (session.abort !== undefined) {
        await session.abort();
      }
    };
    if (request.signal !== undefined) {
      if (request.signal.aborted) {
        await abortSession();
        throw request.signal.reason ?? new Error("aborted");
      }
      const onAbort = (): void => {
        void abortSession();
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      try {
        await session.prompt(promptText);
        await session.agent.waitForIdle();
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    } else {
      await session.prompt(promptText);
      await session.agent.waitForIdle();
    }
    const messages = session.agent.state?.messages ?? [];
    return {
      finalText: extractFinalAssistantText(messages),
      cwd: request.cwd,
      usedCreateAgentSession: true,
      usedLaunchPiChild: false,
      childId,
      runId,
      completedAt: now().toISOString(),
      messages,
      appliedModel,
      appliedProvider,
      appliedEffort,
    };
  } finally {
    if (session.dispose !== undefined) {
      await session.dispose();
    }
  }
}

function extractFinalAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === null || typeof msg !== "object") continue;
    const record = msg as { role?: unknown; content?: unknown };
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    const texts = record.content
      .filter(
        (part): part is { type: string; text: string } =>
          part !== null &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

/**
 * Production dependency wiring. Dynamic import keeps this module loadable in
 * unit tests that inject fakes without resolving the full pi SDK graph.
 *
 * Resolves `provider` + `model` + optional `effort` via the same CLI model
 * resolver the process path uses for `--provider` / `--model M[:effort]`.
 */
export async function createProductionPiNativeSessionDependencies(): Promise<PiNativeSessionDependencies> {
  const mod = await import("@earendil-works/pi-coding-agent");
  return {
    createAgentSession: async (options) => {
      const modelRuntime = await mod.ModelRuntime.create({ allowModelNetwork: false });
      let resolvedModel: unknown = undefined;
      let thinkingLevel: string | undefined = options.effort;

      if (options.model !== undefined || options.provider !== undefined) {
        const cliModel = composePiModelArg({
          model: options.model,
          // Prefer resolveCliModel's own `:effort` parse when effort is set —
          // pass the composed token so process/native share one pattern.
          effort: options.effort,
        });
        const resolved = mod.resolveCliModel({
          ...(options.provider === undefined ? {} : { cliProvider: options.provider }),
          ...(cliModel === null ? {} : { cliModel }),
          modelRuntime,
        });
        if (resolved.error !== undefined) {
          throw new Error(
            `Pi native session model resolution failed (parity with process --model): ${resolved.error}`,
          );
        }
        resolvedModel = resolved.model;
        if (resolved.thinkingLevel !== undefined) {
          thinkingLevel = resolved.thinkingLevel;
        } else if (options.effort !== undefined) {
          thinkingLevel = options.effort;
        }
      }

      const result = await mod.createAgentSession({
        cwd: options.cwd,
        ...(resolvedModel === undefined ? {} : { model: resolvedModel as never }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as never }),
        ...(options.excludeTools === undefined ? {} : { excludeTools: options.excludeTools }),
        sessionManager: mod.SessionManager.inMemory(options.cwd),
        modelRuntime,
      });
      return { session: result.session };
    },
  };
}
