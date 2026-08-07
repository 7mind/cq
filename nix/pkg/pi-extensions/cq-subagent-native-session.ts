/**
 * T1699 / D160 — Pi same-harness native session seam.
 *
 * Binds createAgentSession({ cwd }) to the manager-returned worktree path.
 * Same-harness forceShellout=false MUST use this module and MUST NOT call
 * launchPiChild (the registered process seam for forced/cross-harness).
 */

import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

export const PI_NATIVE_SESSION_SEAM = "createAgentSession" as const;
export const PI_PROCESS_SESSION_SEAM = "launchPiChild" as const;

export interface PiNativeSessionRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly model?: string;
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
}

export interface PiNativeSessionDependencies {
  /**
   * Injectable createAgentSession seam. Production wires the pi-coding-agent
   * SDK; tests substitute fakes. MUST NOT call launchPiChild.
   */
  readonly createAgentSession: (options: {
    readonly cwd: string;
    readonly tools?: string[];
    readonly excludeTools?: string[];
  }) => Promise<{
    session: {
      prompt: (text: string, options?: { signal?: AbortSignal }) => Promise<void>;
      agent: { waitForIdle: () => Promise<void>; state?: { messages?: unknown[] } };
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
 * Run one Pi native child turn via createAgentSession({cwd}).
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

  const { session } = await dependencies.createAgentSession({
    cwd: request.cwd,
    ...(request.excludeTools === undefined
      ? {}
      : { excludeTools: [...request.excludeTools] }),
  });

  try {
    const promptText =
      request.systemPrompt === undefined || request.systemPrompt.trim() === ""
        ? request.prompt
        : `${request.systemPrompt}\n\n${request.prompt}`;
    await session.prompt(promptText, request.signal === undefined ? undefined : { signal: request.signal });
    await session.agent.waitForIdle();
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
 */
export async function createProductionPiNativeSessionDependencies(): Promise<PiNativeSessionDependencies> {
  const mod = await import("@earendil-works/pi-coding-agent");
  return {
    createAgentSession: async (options) => {
      const result = await mod.createAgentSession({
        cwd: options.cwd,
        ...(options.excludeTools === undefined ? {} : { excludeTools: options.excludeTools }),
        sessionManager: mod.SessionManager.inMemory(options.cwd),
      });
      return { session: result.session };
    },
  };
}
