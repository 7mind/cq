/**
 * T688 — the EXECUTABLE Claude-surface bridge for the ref-first dispatch
 * protocol tasks:T687 defined.
 *
 * T687's {@link ./claudeDispatchProtocol} is inert by design: it classifies,
 * correlates, gates and decides, but it launches nothing and drives no
 * lifecycle. This module is the part that RUNS — it composes T687's decisions
 * with the REAL shared service in {@link ./dispatchAttestation}
 * (`prepareDispatch` / `storeDispatchResult` / `confirmDispatchCompletion` /
 * `abortDispatch` / `fetchDispatchResult`) and re-implements NONE of it.
 *
 * ## What "compact native launch" means, mechanically
 *
 * A native `Agent` call has exactly one text channel — `prompt`. The pre-T688
 * Claude fragment told the orchestrator to "pass the complete task prompt"
 * through it, which is tasks:T975's defect: the parent renders and carries a full
 * role prompt whose copy launches nothing. Two already-landed facts remove the
 * need for it entirely:
 *
 *  1. **Role instructions** reach the child at its OWN system boundary, because
 *     `bun run gen-agents` bakes the role prompt into `agents/<role>.md` and the
 *     harness injects it when `subagent_type` selects that agent. T978 recorded
 *     this as {@link NATIVE_CLAUDE_CHILD_RETRIEVAL}'s
 *     `rolePromptInjectionBoundary`, with BOTH ends' role-prompt retrieval sets
 *     asserted EMPTY.
 *  2. **The role input** is assembled SERVER-SIDE from refs
 *     ({@link assembleDispatchInput}) and retrieved by the child BY HANDLE —
 *     `childRetrievesAssembledInputByHandle`.
 *
 * So the only thing the parent puts in `prompt` is the HANDLE plus the distinct
 * input capability the child needs for one retrieval. That compact reference
 * carries no role prompt or task narrative; the child's final reply remains
 * handle-only.
 *
 * ## What this module does NOT own
 *
 * - Other surfaces' launcher/extension migrations. This module owns only the
 *   Claude compact reference; the held Pi cutover remains outside T977.
 * - Fetch repeatability. defects:D188 owns the cross-surface divergence and
 *   goals:G123's tasks:T1142 makes the shared fetch one-shot. This module
 *   performs EXACTLY ONE fetch per dispatch and therefore does not depend on
 *   repeat-fetch behaviour in either direction —
 *   {@link CLAUDE_BRIDGE_FETCH_COUNT} pins that.
 */

import {
  CLAUDE_CROSS_HARNESS_DELIVERY_MODE,
  CLAUDE_NATIVE_ISOLATION_ARGUMENT,
  CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT,
  assertClaudeChildCorrelation,
  assertSupportedClaudeDeliveryMode,
  claudeExpectedChild,
  claudeLaunchGate,
  decideClaudeCompletion,
  type ClaudeChildCorrelation,
  type ClaudeCorrelationProvenance,
  type ClaudeDeliveryMode,
  type ClaudeEnforcementStrength,
  type ClaudeExitCorroboration,
  type ClaudeLaunchRefusal,
  type ClaudeTerminalSignal,
} from "./claudeDispatchProtocol.js";
import {
  AttestationBindingError,
  AttestationContractError,
  abortDispatch,
  assertDispatchHandle,
  confirmDispatchCompletion,
  fetchDispatchResult,
  inputCapabilityHash,
  prepareDispatch,
  provenanceBindingOf,
  type DispatchServiceDeps,
  type DispatchProvenanceBinding,
  type PrepareDispatchDeps,
  type StoreDispatchResultOutcome,
} from "./dispatchAttestation.js";
import type { AttestationNamespace } from "./dispatchAttestation.js";
import type { DispatchOverlayRegistry } from "./dispatchOverlays.js";
import type { DispatchPreLaunchRejection } from "./dispatchInputValidation.js";
import { DISPATCH_HANDLE_SCHEMA } from "./compactDispatchProtocol.js";
import type { JSONSchema } from "./promptCatalog.js";
import { exposedLedgerToolsForRole } from "./roleToolProfiles.js";
import { withoutWorksetCredentials } from "./worksetManagementCommand.js";
import type {
  AbortedDispatchResult,
  DispatchAbortReason,
  DispatchOverlayApplication,
  DispatchHandle,
  DispatchJSONValue,
  DispatchPrepared,
  FetchDispatchInput,
  InputCapability,
  NativeCompletionProof,
  ResultCapability,
} from "./compactDispatchProtocol.js";

// ---------------------------------------------------------------------------
// 1. The compact native launch envelope
// ---------------------------------------------------------------------------

/**
 * The EXACT argument set a ref-first native dispatch passes to the `Agent` tool.
 *
 * Snake-cased because these are the tool's own parameter names, not this
 * codebase's style — the value of this interface is that it is the call, so a
 * reader can compare it to the tool signature without translating. The `Agent`
 * tool accepts `subagent_type`, `prompt`, `model`, `isolation`,
 * `run_in_background` and NO path parameter (tasks:T722 §8.1b enumerates the
 * whole field table); every one of those five is pinned here, and there is
 * nothing else to pass.
 *
 * `isolation` and `run_in_background` are LITERAL types rather than widened
 * ones, so a launcher that allocated a harness worktree or backgrounded the
 * child cannot type-check. Both literals come from T687, where each has its
 * measured justification.
 */
export interface ClaudeNativeLaunchEnvelope {
  /**
   * The dispatched role. This is the ONLY channel through which role
   * instructions reach the child — the harness injects the gen-agents-baked
   * `agents/<role>.md` for the selected `subagent_type`. A launcher that also
   * put instructions in `prompt` would be sending them twice.
   */
  readonly subagent_type: string;
  /**
   * The compact ref launch: exactly the handle plus input capability, as JSON.
   */
  readonly prompt: string;
  readonly model: string;
  /** `"none"` — keeps the harness out of worktree allocation (defects:D119). */
  readonly isolation: typeof CLAUDE_NATIVE_ISOLATION_ARGUMENT;
  /** `false` explicitly, against the harness default (T722 §4.1/§5.3). */
  readonly run_in_background: typeof CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT;
}

/**
 * A hard upper bound on the compact launch prompt, in bytes.
 *
 * A handle plus input capability is below 200 bytes; 256 leaves room for a
 * longer id without leaving room for narrative. The point of a NUMERIC bound
 * alongside the structural closed-key check is that the
 * two fail on different mutations: a bound catches bulk that happens to be
 * valid JSON, and the structural check catches a small surplus key.
 *
 * For scale, tasks:T722 measured a single dispatched role prompt at 2,689 B of
 * visible completion when unconstrained; a pre-T688 parent carried the whole
 * rendered role prompt, which for `implement-worker` is several kilobytes.
 */
export const CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES = 256;

export interface ClaudeCompactLaunchRequest {
  /** The dispatched role, which becomes `subagent_type`. */
  readonly roleId: string;
  /** The resolved model class for this dispatch. */
  readonly model: string;
  /** The handle `prepare_dispatch` returned. */
  readonly handle: DispatchHandle;
  /** The one-shot child input capability returned by the same prepare. */
  readonly inputCapability: InputCapability;
}

/** Render the compact launch prompt: handle plus input capability, and nothing else. */
export function claudeCompactLaunchPrompt(reference: FetchDispatchInput): string {
  const resolved = assertDispatchHandle(reference, "reference");
  if (reference.inputCapability?.scope !== "fetch-input") {
    throw new AttestationContractError(
      "reference.inputCapability.scope",
      'expected "fetch-input"',
    );
  }
  inputCapabilityHash(reference.inputCapability.token);
  // Key order fixed and explicit so the rendering is stable across callers.
  return JSON.stringify({
    attestationId: resolved.attestationId,
    generation: resolved.generation,
    inputCapability: reference.inputCapability,
  });
}

/**
 * Build the native launch envelope, and REFUSE to build one that is not compact.
 *
 * The two checks are deliberately both applied to the value that will actually
 * be sent, not to an intermediate: a caller cannot pass the structural check by
 * constructing the prompt one way and shipping another.
 */
export function buildClaudeCompactNativeLaunch(
  request: ClaudeCompactLaunchRequest,
): ClaudeNativeLaunchEnvelope {
  const roleId: unknown = request?.roleId;
  if (typeof roleId !== "string" || roleId.trim() === "") {
    throw new AttestationContractError(
      "launch.subagent_type",
      `expected the dispatched role id to select the child's baked instructions, got "${String(roleId)}"`,
    );
  }
  const model: unknown = request.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new AttestationContractError(
      "launch.model",
      `expected a resolved model, got "${String(model)}"`,
    );
  }
  const handle = assertDispatchHandle(request.handle, "launch.handle");
  const reference: FetchDispatchInput = Object.freeze({
    ...handle,
    inputCapability: request.inputCapability,
  });
  const prompt = claudeCompactLaunchPrompt(reference);
  assertCompactClaudeLaunchPrompt(prompt, reference);
  return Object.freeze({
    subagent_type: roleId,
    prompt,
    model,
    isolation: CLAUDE_NATIVE_ISOLATION_ARGUMENT,
    run_in_background: CLAUDE_NATIVE_RUN_IN_BACKGROUND_ARGUMENT,
  });
}

/**
 * Assert that a launch prompt carries exactly the handle plus input capability.
 *
 * This is the detector behind "generated Claude artifacts contain no dispatched
 * prompt copy": a role prompt, a task narrative, or a `{handle, task}` envelope
 * each fail it, and each failure names which of the two bounds it broke.
 */
export function assertCompactClaudeLaunchPrompt(
  prompt: string,
  reference: FetchDispatchInput,
): void {
  if (typeof prompt !== "string") {
    throw new AttestationContractError(
      "launch.prompt",
      `expected a compact launch prompt string, got "${String(prompt)}"`,
    );
  }
  const bytes = new TextEncoder().encode(prompt).length;
  if (bytes > CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES) {
    throw new AttestationContractError(
      "launch.prompt",
      `a compact native launch carries only the input reference, so its prompt must not exceed ` +
        `${CLAUDE_COMPACT_LAUNCH_PROMPT_MAX_BYTES} bytes; got ${bytes} bytes — a dispatched prompt ` +
        "copy belongs at the child's own system boundary (gen-agents), not in the launch",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    throw new AttestationContractError(
      "launch.prompt",
      "a compact native launch prompt must be the JSON input reference",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !==
      "attestationId,generation,inputCapability" ||
    JSON.stringify(parsed) !== JSON.stringify(reference)
  ) {
    throw new AttestationContractError(
      "launch.prompt",
      "a compact native launch prompt must carry exactly the bound handle and input capability",
    );
  }
  claudeCompactLaunchPrompt(reference);
}

/**
 * The delivery mode this executable bridge drives: T722's process-boundary
 * wrapper. A native Agent launch cannot keep its final text out of the parent
 * context on the measured Claude build; the wrapper can.
 */
export const CLAUDE_BRIDGE_MODE: ClaudeDeliveryMode = CLAUDE_CROSS_HARNESS_DELIVERY_MODE;

/**
 * Assert that `mode` is the one this bridge implements. Distinguishes "not a
 * Claude mode at all" (T687's {@link assertSupportedClaudeDeliveryMode} throws)
 * from "a supported mode this bridge is not the implementation of".
 */
export function assertClaudeBridgeMode(mode: string): ClaudeDeliveryMode {
  const supported = assertSupportedClaudeDeliveryMode(mode);
  if (supported !== CLAUDE_BRIDGE_MODE) {
    throw new AttestationContractError(
      "mode",
      `this bridge drives "${CLAUDE_BRIDGE_MODE}"; "${supported}" has a different transport`,
    );
  }
  return supported;
}

/** Validate the correlation this bridge will bind, and freeze it. */
export function claudeBridgeCorrelation(
  correlation: ClaudeChildCorrelation,
): ClaudeChildCorrelation {
  return assertClaudeChildCorrelation(correlation, "launch.expectedChild");
}

// ---------------------------------------------------------------------------
// 2. The launcher seam
// ---------------------------------------------------------------------------

/**
 * What a launcher is HANDED. Everything here is parent-side; nothing comes back
 * through it.
 */
export interface ClaudeNativeLaunchContext {
  readonly envelope: ClaudeNativeLaunchEnvelope;
  /**
   * The exact role/prompt/input binding persisted by prepare. The production
   * launcher verifies its generated role prompt against this binding before it
   * spawns Claude, so the reported role cannot be synthesized from an
   * unverified request envelope.
   */
  readonly preparedProvenance: DispatchProvenanceBinding;
  /**
   * The identity the parent bound at prepare. A production transport carries
   * the nonce on the launch it observes and returns an independently observed
   * correlation in {@link ClaudeNativeLaunchReport}; settlement compares the
   * two instead of copying this value into the observation.
   */
  readonly expectedCorrelation: ClaudeChildCorrelation;
  /**
   * The per-dispatch capability, delivered to the child through an INLINE
   * per-subagent `mcpServers` entry whose server `env` holds it — tasks:T722
   * §8.1a's measured mechanism, in which the PARENT's own tool set reported
   * `hasStoreTool=false`. It is passed to the launcher, never to the child's
   * prompt, because a prompt-carried capability would be readable by the model
   * turn that composed it.
   */
  readonly resultCapability: ResultCapability;
  /**
   * The CONSERVATIVE window, in milliseconds, from T687's launch gate — time
   * remaining until `responseStoreNow`, not until `childCancelAt`. A DURATION,
   * never an instant, so a child with an offset clock still stops on time.
   */
  readonly childWindowMs: number;
}

/**
 * What the transport OBSERVED about the child's turn.
 *
 * Every identity below comes from the trusted transport observation (the
 * native Agent result / hook event), not from the child's final message. This
 * makes a wrong-child result representable and routes it through T687's typed
 * correlation abort instead of silently substituting the parent's expectation.
 */
export interface ClaudeNativeLaunchReport {
  /** Whether the PARENT cancelled. A parent-side fact about the run. */
  readonly cancelled: boolean;
  readonly terminal: ClaudeTerminalSignal;
  /** The child's last message. Checked for handle-only shape, never for identity. */
  readonly finalMessage: string;
  readonly observedAt: string;
  /** Actual role/nonce/session observed on the completed launch. */
  readonly correlation: ClaudeChildCorrelation;
  /** Harness-minted native child id, e.g. Agent's `agentId`. */
  readonly agentId: string;
  /** Harness/API tool-use id that launched this child. */
  readonly parentToolUseId: string;
  /** Canonical model reported by the transport, not the requested alias. */
  readonly resolvedModel: string;
  /**
   * What the child's capability-bound submission produced AT THE PER-DISPATCH
   * ENDPOINT — which is bridge-side infrastructure, so this is an observation,
   * not a child claim. `undefined` means the child never submitted, and the
   * bridge does NOT convert that into a failure itself: it lets
   * `confirm_dispatch_completion` return the authoritative `missing-result`
   * abort, keeping defects:D179's rule where it belongs.
   */
  readonly submission?: StoreDispatchResultOutcome;
}

export type ClaudeNativeLauncher = (context: ClaudeNativeLaunchContext) => ClaudeNativeLaunchReport;

export interface ClaudePrintStoreServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Environment key consumed by the scoped server for this dispatch. */
  readonly capabilityEnv: string;
}

export interface ClaudePrintLaunchOptions {
  readonly claudeExecutable: string;
  /** Empty in production; test recordings use `bun <fixture>`. */
  readonly claudeArgsPrefix: readonly string[];
  readonly cwd: string;
  /** Generated role instructions selected by `envelope.subagent_type`. */
  readonly rolePrompt: string;
  readonly storeServer: ClaudePrintStoreServer;
}

function boundClaudePrintRole(context: ClaudeNativeLaunchContext, rolePrompt: string): string {
  const roleId = context.preparedProvenance.roleId;
  if (context.envelope.subagent_type !== roleId || context.expectedCorrelation.roleId !== roleId) {
    throw new AttestationContractError(
      "launch.rolePrompt.roleId",
      `prepared role "${roleId}" does not match requested role ` +
        `"${context.envelope.subagent_type}" and expected correlation role ` +
        `"${context.expectedCorrelation.roleId}"`,
    );
  }
  const observedPromptDigest = new Bun.CryptoHasher("sha256").update(rolePrompt).digest("hex");
  if (observedPromptDigest !== context.preparedProvenance.promptDigest) {
    throw new AttestationContractError(
      "launch.rolePrompt.promptDigest",
      `generated role prompt for "${roleId}" has digest "${observedPromptDigest}", ` +
        `not the prepared digest "${context.preparedProvenance.promptDigest}"`,
    );
  }
  return roleId;
}

interface ClaudePrintResult {
  readonly type: "result";
  readonly subtype: string;
  readonly is_error: boolean;
  readonly terminal_reason: string;
  readonly session_id: string;
  readonly uuid: string;
  readonly result: string;
  readonly modelUsage: Readonly<Record<string, { readonly canonicalModel?: string }>>;
}

function claudeCliArgumentSchema(schema: JSONSchema): JSONSchema {
  const { $schema: _omit, ...argumentSchema } = schema;
  return argumentSchema;
}

const CLAUDE_DISPATCH_HANDLE_SCHEMA = claudeCliArgumentSchema(DISPATCH_HANDLE_SCHEMA);

function parseClaudePrintResult(value: unknown): ClaudePrintResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result = value as Readonly<Record<string, unknown>>;
  if (
    result["type"] !== "result" ||
    typeof result["subtype"] !== "string" ||
    typeof result["is_error"] !== "boolean" ||
    typeof result["terminal_reason"] !== "string" ||
    typeof result["session_id"] !== "string" ||
    typeof result["uuid"] !== "string" ||
    typeof result["result"] !== "string" ||
    typeof result["modelUsage"] !== "object" ||
    result["modelUsage"] === null ||
    Array.isArray(result["modelUsage"])
  ) {
    return undefined;
  }
  const modelUsage: Record<string, { readonly canonicalModel?: string }> = {};
  for (const [model, rawUsage] of Object.entries(result["modelUsage"])) {
    if (typeof rawUsage !== "object" || rawUsage === null || Array.isArray(rawUsage)) {
      return undefined;
    }
    const canonicalModel = (rawUsage as Readonly<Record<string, unknown>>)["canonicalModel"];
    if (canonicalModel !== undefined && typeof canonicalModel !== "string") return undefined;
    modelUsage[model] = canonicalModel === undefined ? {} : { canonicalModel };
  }
  return {
    type: "result",
    subtype: result["subtype"],
    is_error: result["is_error"],
    terminal_reason: result["terminal_reason"],
    session_id: result["session_id"],
    uuid: result["uuid"],
    result: result["result"],
    modelUsage,
  };
}

/**
 * The production T722 process-boundary transport. It launches a real
 * `claude -p`, supplies one per-dispatch stdio server whose environment carries
 * the result capability, consumes the raw terminal JSON inside this function,
 * and returns only transport facts to the lifecycle sequencer.
 */
interface ClaudePrintInvocation {
  readonly boundRoleId: string;
  readonly argv: readonly string[];
}

function claudePrintInvocation(
  context: ClaudeNativeLaunchContext,
  options: ClaudePrintLaunchOptions,
): ClaudePrintInvocation {
  const boundRoleId = boundClaudePrintRole(context, options.rolePrompt);
  const serverName = assertObservedTransportString(options.storeServer.name, "storeServer.name");
  const allowedToolNames = exposedLedgerToolsForRole(boundRoleId).map(
    (toolName) => `mcp__${serverName}__${toolName}`,
  );
  const mcpConfig = JSON.stringify({
    mcpServers: {
      [serverName]: {
        type: "stdio",
        command: options.storeServer.command,
        args: [...options.storeServer.args, "--tool-profile", boundRoleId],
        cwd: options.storeServer.cwd,
        env: {
          ...withoutWorksetCredentials(options.storeServer.env),
          [options.storeServer.capabilityEnv]: context.resultCapability.token,
        },
      },
    },
  });
  return Object.freeze({
    boundRoleId,
    argv: Object.freeze([
      options.claudeExecutable,
      ...options.claudeArgsPrefix,
      "-p",
      context.envelope.prompt,
      "--model",
      context.envelope.model,
      "--session-id",
      context.expectedCorrelation.sessionId,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(CLAUDE_DISPATCH_HANDLE_SCHEMA),
      "--append-system-prompt",
      options.rolePrompt,
      "--tools",
      "",
      "--allowedTools",
      allowedToolNames.join(","),
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig,
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
    ]),
  });
}

interface ClaudePrintProcessObservation {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly cancelled: boolean;
}

function claudePrintLaunchReport(
  context: ClaudeNativeLaunchContext,
  boundRoleId: string,
  processResult: ClaudePrintProcessObservation,
): ClaudeNativeLaunchReport {
  const raw = processResult.stdout.trim();
  const observedAt = new Date().toISOString();
  if (raw === "") {
    return failedClaudePrintReport(
      context,
      processResult.exitCode,
      observedAt,
      processResult.stderr,
      processResult.cancelled,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return failedClaudePrintReport(
      context,
      processResult.exitCode,
      observedAt,
      raw,
      processResult.cancelled,
    );
  }
  const parsed = parseClaudePrintResult(decoded);
  if (parsed === undefined) {
    return failedClaudePrintReport(
      context,
      processResult.exitCode,
      observedAt,
      "malformed Claude print terminal result",
      processResult.cancelled,
    );
  }
  const model = Object.values(parsed.modelUsage ?? {})
    .map((usage) => usage.canonicalModel)
    .find((candidate): candidate is string => typeof candidate === "string" && candidate !== "");
  return Object.freeze({
    cancelled: processResult.cancelled,
    terminal: Object.freeze({
      subtype: parsed.subtype,
      isError: parsed.is_error || processResult.exitCode !== 0,
      terminalReason: parsed.terminal_reason,
      exitStatus: processResult.exitCode,
    }),
    finalMessage: parsed.result,
    observedAt,
    correlation: Object.freeze({
      roleId: boundRoleId,
      launchNonce: parsed.session_id,
      sessionId: parsed.session_id,
    }),
    agentId: parsed.session_id,
    parentToolUseId: parsed.uuid,
    resolvedModel: assertObservedTransportString(model ?? "", "result.modelUsage.canonicalModel"),
  });
}

export function launchClaudePrint(
  context: ClaudeNativeLaunchContext,
  options: ClaudePrintLaunchOptions,
): ClaudeNativeLaunchReport {
  const invocation = claudePrintInvocation(context, options);
  const processResult = Bun.spawnSync([...invocation.argv], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: context.childWindowMs,
    env: withoutWorksetCredentials(process.env),
  });
  return claudePrintLaunchReport(context, invocation.boundRoleId, {
    stdout: processResult.stdout.toString(),
    stderr: processResult.stderr.toString(),
    exitCode: processResult.exitCode,
    cancelled: Boolean(processResult.signalCode),
  });
}

/** Async form used when the scoped child endpoint is hosted by this process. */
export async function launchClaudePrintAsync(
  context: ClaudeNativeLaunchContext,
  options: ClaudePrintLaunchOptions,
): Promise<ClaudeNativeLaunchReport> {
  const invocation = claudePrintInvocation(context, options);
  const child = Bun.spawn([...invocation.argv], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: withoutWorksetCredentials(process.env),
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
  }, context.childWindowMs);
  const [exitCode, completedStdout, completedStderr] = await Promise.all([
    child.exited,
    stdout,
    stderr,
  ]);
  clearTimeout(timeout);
  if (forceKill !== undefined) clearTimeout(forceKill);
  return claudePrintLaunchReport(context, invocation.boundRoleId, {
    stdout: completedStdout,
    stderr: completedStderr,
    exitCode,
    cancelled: timedOut || child.signalCode !== null,
  });
}

function failedClaudePrintReport(
  context: ClaudeNativeLaunchContext,
  exitStatus: number,
  observedAt: string,
  detail: string,
  cancelled = false,
): ClaudeNativeLaunchReport {
  return Object.freeze({
    cancelled,
    terminal: Object.freeze({
      subtype: "error",
      isError: true,
      terminalReason: detail.trim() === "" ? "transport_error" : detail.trim().slice(0, 512),
      exitStatus,
    }),
    finalMessage: "",
    observedAt,
    correlation: context.expectedCorrelation,
    agentId: "claude-print-transport-failed",
    parentToolUseId: "claude-print-transport-failed",
    resolvedModel: context.envelope.model,
  });
}

// ---------------------------------------------------------------------------
// 3. The parent-visible outcome — HANDLE-ONLY on every branch
// ---------------------------------------------------------------------------

/**
 * The promotion acknowledgement the ORCHESTRATOR receives. It carries the
 * handle, the digest, the native proof, and the two per-mode strengths — and NO
 * `output` property, on purpose: defects:D173 removed the body from confirm
 * after measuring a 45,833-byte payload returned on a 46,510-byte confirm
 * response. The body arrives through {@link ClaudeDispatchMaterializer} and
 * nowhere else.
 *
 * `nativeCompletion` is retained because it is what makes RESTART RECOVERY
 * possible: a parent that lost its in-memory state re-derives the same proof
 * from the correlation and re-confirms idempotently.
 */
export interface ClaudeParentCompletion {
  readonly state: "consumed";
  readonly attestationId: string;
  readonly generation: number;
  readonly consumedAt: string;
  readonly outputDigest: string;
  readonly nativeCompletion: NativeCompletionProof;
  readonly correlationProvenance: ClaudeCorrelationProvenance;
  readonly handleOnlyEnforcement: ClaudeEnforcementStrength;
  readonly exitStatusCorroborates: ClaudeExitCorroboration;
  /** Actual transport provenance, retained beside the shared native proof. */
  readonly transportProvenance: ClaudeTransportProvenance;
}

export interface ClaudeTransportProvenance {
  readonly agentId: string;
  readonly parentToolUseId: string;
  readonly resolvedModel: string;
  readonly correlation: ClaudeChildCorrelation;
}

/**
 * Compile-time proof that the parent completion carries no body. Adding an
 * `output` property to {@link ClaudeParentCompletion} breaks `tsc`, not just a
 * test — the same technique `PreLaunchRejectionOutcomeIsNotALifecycleState` uses.
 */
type NeverOnly<T extends never> = T;
export type ClaudeParentCompletionCarriesNoBody = NeverOnly<
  Extract<keyof ClaudeParentCompletion, "output">
>;

export const CLAUDE_DISPATCH_RUN_OUTCOMES = ["rejected", "aborted", "consumed"] as const;

export type ClaudeDispatchRunOutcome = (typeof CLAUDE_DISPATCH_RUN_OUTCOMES)[number];

/** Nothing was allocated: the launch envelope or the role input failed validation. */
export interface ClaudeDispatchRejected {
  readonly outcome: "rejected";
  readonly rejection: DispatchPreLaunchRejection;
  readonly launched: false;
}

/** A terminal abort. `refusal` is present only when the LAUNCH GATE refused. */
export interface ClaudeDispatchAborted {
  readonly outcome: "aborted";
  readonly handle: DispatchHandle;
  readonly reason: DispatchAbortReason;
  readonly abort: AbortedDispatchResult;
  readonly launched: boolean;
  readonly refusal?: ClaudeLaunchRefusal;
}

export interface ClaudeDispatchConsumed {
  readonly outcome: "consumed";
  readonly handle: DispatchHandle;
  readonly completion: ClaudeParentCompletion;
  readonly launched: true;
}

export type ClaudeDispatchRun =
  ClaudeDispatchRejected | ClaudeDispatchAborted | ClaudeDispatchConsumed;

// ---------------------------------------------------------------------------
// 4. The sequencer
// ---------------------------------------------------------------------------

export interface ClaudeDispatchRequest {
  readonly namespace: AttestationNamespace;
  readonly roleId: string;
  /** The resolved model class handed to `claude -p`. */
  readonly model: string;
  /**
   * The child session UUID pre-assigned through `claude -p --session-id` and
   * required back on the terminal event.
   */
  readonly childSessionId: string;
  /** The assembled role input. Assembled elsewhere (T978); bound here. */
  readonly input: DispatchJSONValue;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly registry: DispatchOverlayRegistry;
  readonly promptDigest: string;
  readonly catalogHash: string;
  readonly overlays?: readonly DispatchOverlayApplication[];
  readonly reprepareOf?: DispatchHandle;
}

export interface ClaudeBridgeDeps extends PrepareDispatchDeps {
  readonly launch: ClaudeNativeLauncher;
}

function serviceDeps(deps: ClaudeBridgeDeps): DispatchServiceDeps {
  return { store: deps.store, now: deps.now };
}

/**
 * Drive ONE Claude ref-first dispatch end to end: prepare → gate → launch →
 * decide → confirm. It does NOT fetch — see {@link CLAUDE_BRIDGE_FETCH_COUNT}
 * and {@link ClaudeDispatchMaterializer}.
 *
 * Every lifecycle write goes through the shared service. Storage and transport
 * failures are deliberately NOT caught: an unavailable store must fail the
 * protocol, because returning any non-error outcome would let a caller book the
 * ref-first saving on a dispatch whose result was never recorded.
 *
 * The routing, and where each verdict comes from:
 *
 * | observed | routed to | decided by |
 * |---|---|---|
 * | invalid role input / launch envelope | `rejected`, nothing allocated | `prepareDispatch` |
 * | launch budget or response window lapsed | `aborted` `deadline-exceeded` | `claudeLaunchGate` |
 * | launch instant off the prepare clock | `aborted` `protocol-violation` | `claudeLaunchGate` |
 * | child stored INVALID output | `aborted` `invalid-output` | `storeDispatchResult`, atomically |
 * | child stored past `childCancelAt` | `aborted` `deadline-exceeded` | `storeDispatchResult`, atomically |
 * | parent cancelled | `aborted` `cancelled` | `decideClaudeCompletion` |
 * | native/API error turn | `aborted` `native-failure` | `decideClaudeCompletion` |
 * | wrong child completed | `aborted` `native-failure` | `decideClaudeCompletion` |
 * | echoed / malformed final message | `aborted` `protocol-violation` | `decideClaudeCompletion` |
 * | nothing stored | `aborted` `missing-result` | `confirmDispatchCompletion` |
 * | conformant | `consumed`, handle-only | `confirmDispatchCompletion` |
 */
export function runClaudeNativeDispatch(
  request: ClaudeDispatchRequest,
  deps: ClaudeBridgeDeps,
): ClaudeDispatchRun {
  const correlation = claudeBridgeCorrelation({
    roleId: request.roleId,
    // T722's wrapper pre-assigns this UUID and observes the terminal event echo.
    // Reusing it as the nonce makes every correlation field observable rather
    // than depending on a second parent-only value.
    launchNonce: request.childSessionId,
    sessionId: request.childSessionId,
  });
  const prepareOutcome = prepareDispatch(
    {
      namespace: request.namespace,
      roleId: request.roleId,
      surface: "claude",
      input: request.input,
      idempotencyKey: request.idempotencyKey,
      timeoutMs: request.timeoutMs,
      registry: request.registry,
      promptDigest: request.promptDigest,
      catalogHash: request.catalogHash,
      expectedChild: claudeExpectedChild(correlation),
      ...(request.overlays === undefined ? {} : { overlays: request.overlays }),
      ...(request.reprepareOf === undefined ? {} : { reprepareOf: request.reprepareOf }),
    },
    deps,
  );
  if (!prepareOutcome.accepted) {
    return Object.freeze({
      outcome: "rejected" as const,
      rejection: prepareOutcome,
      launched: false as const,
    });
  }
  const prepared = prepareOutcome.prepared;
  const handle: DispatchHandle = Object.freeze({
    attestationId: prepared.attestationId,
    generation: prepared.generation,
  });

  const gate = claudeLaunchGate(prepared, deps.now());
  if (!gate.launch) {
    const abort = abortDispatch(
      {
        namespace: request.namespace,
        actor: "trusted-parent",
        ...handle,
        reason: gate.abortReason,
        details: Object.freeze({ refusal: gate.refusal, detail: gate.detail }),
      },
      serviceDeps(deps),
    );
    return Object.freeze({
      outcome: "aborted" as const,
      handle,
      reason: abort.reason,
      abort,
      launched: false,
      refusal: gate.refusal,
    });
  }

  const report = deps.launch(
    Object.freeze({
      envelope: buildClaudeCompactNativeLaunch({
        roleId: request.roleId,
        model: request.model,
        handle,
        inputCapability: prepared.inputCapability,
      }),
      preparedProvenance: provenanceBindingOf(prepared),
      expectedCorrelation: correlation,
      resultCapability: prepared.resultCapability,
      childWindowMs: gate.childWindowMs,
    }),
  );
  return settleClaudeNativeDispatch(
    { request, prepared, handle, correlation, report },
    serviceDeps(deps),
  );
}

interface ClaudeSettleContext {
  readonly request: ClaudeDispatchRequest;
  readonly prepared: DispatchPrepared;
  readonly handle: DispatchHandle;
  readonly correlation: ClaudeChildCorrelation;
  readonly report: ClaudeNativeLaunchReport;
}

/**
 * Settle a launched dispatch. Split out from {@link runClaudeNativeDispatch} so
 * that RESTART RECOVERY has an entry point: a parent that lost its state, and
 * re-reads the prepared record plus the correlation it minted, settles through
 * exactly this function and reaches exactly the same terminal state.
 */
function settleClaudeNativeDispatch(
  context: ClaudeSettleContext,
  deps: DispatchServiceDeps,
): ClaudeDispatchRun {
  const { request, prepared, handle, correlation, report } = context;
  assertSubmissionMatchesHandle(report.submission, handle);

  // The submission is already TERMINAL when the service aborted it atomically
  // (invalid output, or a store past `childCancelAt`). Nothing the parent decides
  // afterwards can move a terminal record, and trying would be a typed conflict
  // rather than a re-route — so this branch is read FIRST.
  if (report.submission?.state === "aborted") {
    const abort = report.submission.result;
    return Object.freeze({
      outcome: "aborted" as const,
      handle,
      reason: abort.reason,
      abort,
      launched: true,
    });
  }

  const decision = decideClaudeCompletion({
    handle,
    expectedChild: correlation,
    observation: {
      source: "transport",
      mode: CLAUDE_BRIDGE_MODE,
      // These values came from the trusted transport, independently of the
      // child-controlled final message. A mismatch reaches the typed abort.
      roleId: report.correlation.roleId,
      launchNonce: report.correlation.launchNonce,
      sessionId: report.correlation.sessionId,
      cancelled: report.cancelled,
      terminal: report.terminal,
      finalMessage: report.finalMessage,
      observedAt: report.observedAt,
    },
  });
  if (decision.action === "abort") {
    const abort = abortDispatch(
      {
        namespace: request.namespace,
        actor: "trusted-parent",
        ...handle,
        reason: decision.reason,
        details: decision.details,
      },
      deps,
    );
    return Object.freeze({
      outcome: "aborted" as const,
      handle,
      reason: abort.reason,
      abort,
      launched: true,
    });
  }

  // Transport provenance belongs to the confirmation proof. Validate every
  // required observation BEFORE the irreversible `result-stored -> consumed`
  // transition; otherwise a malformed report can commit success and only then
  // throw while constructing the parent acknowledgement.
  const transportProvenance = claudeTransportProvenanceOf(report);
  const confirmed = confirmDispatchCompletion(
    {
      namespace: request.namespace,
      ...handle,
      nativeCompletion: decision.nativeCompletion,
      expectedProvenance: provenanceBindingOf(prepared),
    },
    deps,
  );
  if (confirmed.state === "aborted") {
    // `missing-result`: a native completion with nothing stored is not a success,
    // and this module never pretends otherwise from Claude evidence alone.
    return Object.freeze({
      outcome: "aborted" as const,
      handle,
      reason: confirmed.result.reason,
      abort: confirmed.result,
      launched: true,
    });
  }
  return Object.freeze({
    outcome: "consumed" as const,
    handle,
    launched: true as const,
    completion: Object.freeze({
      state: "consumed" as const,
      attestationId: confirmed.result.attestationId,
      generation: confirmed.result.generation,
      consumedAt: confirmed.result.consumedAt,
      outputDigest: confirmed.result.outputDigest,
      nativeCompletion: decision.nativeCompletion,
      correlationProvenance: decision.correlationProvenance,
      handleOnlyEnforcement: decision.handleOnlyEnforcement,
      exitStatusCorroborates: decision.exitStatusCorroborates,
      transportProvenance,
    }),
  });
}

function assertSubmissionMatchesHandle(
  submission: StoreDispatchResultOutcome | undefined,
  handle: DispatchHandle,
): void {
  if (
    submission !== undefined &&
    (submission.result.attestationId !== handle.attestationId ||
      submission.result.generation !== handle.generation)
  ) {
    throw new AttestationBindingError(
      "report.submission",
      `submission belongs to attestation "${submission.result.attestationId}" generation ` +
        `${submission.result.generation}, not "${handle.attestationId}" generation ` +
        `${handle.generation}`,
    );
  }
}

function claudeTransportProvenanceOf(report: ClaudeNativeLaunchReport): ClaudeTransportProvenance {
  return Object.freeze({
    agentId: assertObservedTransportString(report.agentId, "report.agentId"),
    parentToolUseId: assertObservedTransportString(
      report.parentToolUseId,
      "report.parentToolUseId",
    ),
    resolvedModel: assertObservedTransportString(report.resolvedModel, "report.resolvedModel"),
    correlation: Object.freeze({ ...report.correlation }),
  });
}

function assertObservedTransportString(value: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AttestationContractError(path, "expected a non-empty transport-observed value");
  }
  return value;
}

/**
 * Re-settle a dispatch after the parent lost its state — questions:Q363's
 * restart case, and the one path on which the bridge does not launch.
 *
 * Idempotency is the shared service's, not this module's: an identical
 * confirmation retry is idempotent there, so a recovered parent that re-derives
 * the same correlation reaches the same `consumed` record without a second
 * child and without a second promotion.
 */
export function recoverClaudeNativeDispatch(
  context: ClaudeSettleContext,
  deps: DispatchServiceDeps,
): ClaudeDispatchRun {
  return settleClaudeNativeDispatch(context, deps);
}

export type { ClaudeSettleContext };

/**
 * A one-use body materializer. The capability lives in the object identity and
 * is consumed BEFORE the shared fetch runs, so even an unavailable backend
 * cannot turn a retry into a second materialization attempt. The shared fetch
 * itself is one-shot (defects:D188/T1142): fetchDispatchResult CAS-persists
 * `outputMaterializedAt` on the first fetch and a repeat fetch returns
 * `output-already-materialized` without the body.
 */
export class ClaudeDispatchMaterializer {
  private materialized = false;

  constructor(
    private readonly request: { readonly namespace: AttestationNamespace } & DispatchHandle,
    private readonly deps: DispatchServiceDeps,
  ) {}

  materialize(): DispatchJSONValue {
    if (this.materialized) {
      throw new AttestationContractError(
        "fetch",
        "this Claude dispatch result was already materialized",
      );
    }
    this.materialized = true;
    const handle = assertDispatchHandle(this.request, "fetch");
    const result = fetchDispatchResult(
      { namespace: this.request.namespace, actor: "trusted-parent", ...handle },
      this.deps,
    );
    if (result.state !== "consumed") {
      throw new AttestationContractError(
        "fetch.state",
        `only a consumed dispatch carries an output body; attestation ` +
          `"${handle.attestationId}" is "${result.state}"`,
      );
    }
    return result.output;
  }
}

export function createClaudeDispatchMaterializer(
  request: { readonly namespace: AttestationNamespace } & DispatchHandle,
  deps: DispatchServiceDeps,
): ClaudeDispatchMaterializer {
  return new ClaudeDispatchMaterializer(request, deps);
}

// ---------------------------------------------------------------------------
// 5. Generated-artifact conformance
// ---------------------------------------------------------------------------

/**
 * The four ways a generated Claude artifact can defeat ref-first, named exactly
 * as tasks:T688's acceptance names them.
 */
export const CLAUDE_ARTIFACT_VIOLATIONS = [
  "dispatched-prompt-copy",
  "generic-launcher",
  "raw-output-completion",
  "ordinary-validate-output",
] as const;

export type ClaudeArtifactViolation = (typeof CLAUDE_ARTIFACT_VIOLATIONS)[number];

/**
 * A line carrying this token is EXPLICIT inspection/debug and is exempt.
 * tasks:T688 keeps `fetch_prompt` available for inspection but removes the
 * ORDINARY, model-visible validation call; a token makes "ordinary" decidable
 * instead of a matter of reading tone.
 */
export const CLAUDE_ARTIFACT_INSPECTION_TOKEN = "CQ_INSPECTION_ONLY" as const;

interface ClaudeArtifactMarker {
  readonly violation: ClaudeArtifactViolation;
  readonly marker: RegExp;
  /** Why this spelling is the violation, and where it was observed. */
  readonly rationale: string;
}

/**
 * The markers, each matched against a REAL spelling present in a REAL artifact
 * at the time it was written — not invented shapes. A marker that matches
 * nothing anywhere is a defects:D186 dead declaration, so every entry below is
 * witnessed by this module's suite against the artifact it was taken from.
 */
const CLAUDE_ARTIFACT_MARKERS: readonly ClaudeArtifactMarker[] = Object.freeze([
  Object.freeze({
    violation: "dispatched-prompt-copy" as const,
    marker: /\bthe (?:complete|full|entire) (?:task )?prompt\b/i,
    rationale:
      "tasks:T975's defect verbatim: the parent renders a whole role prompt whose copy launches " +
      "nothing, because `bun run gen-agents` already bakes the identical prompt into " +
      "`agents/<role>.md` and the harness injects it at the CHILD's system boundary.",
  }),
  Object.freeze({
    violation: "dispatched-prompt-copy" as const,
    marker: /\bthe prompt MUST carry\b/i,
    rationale:
      "An instruction to fold the task narrative into the launch. Under T978 the narrative is " +
      "assembled server-side and retrieved by the child through a compact handle plus input " +
      "capability, so the launch carries no narrative.",
  }),
  Object.freeze({
    violation: "dispatched-prompt-copy" as const,
    marker: /rendered into the prompt\b/i,
    rationale:
      "The composed INPUT rendered into the launch text — the same cost as a prompt copy, and the " +
      "reason `buildClaudeCompactNativeLaunch` refuses anything but the compact input reference.",
  }),
  Object.freeze({
    violation: "generic-launcher" as const,
    marker: /isolation:\s*"worktree"/,
    rationale:
      'defects:D119\'s root cause. `isolation: "worktree"` makes the HARNESS allocate-or-REUSE a ' +
      "tree at whatever commit it was left; questions:Q363 abolished that in favour of an " +
      'orchestrator-prepared fresh tree, so T687 pins the argument to `"none"`.',
  }),
  Object.freeze({
    violation: "generic-launcher" as const,
    marker: /run_in_background:\s*true/,
    rationale:
      "tasks:T722 §4.1/§5.3: a background subagent's completion arrives as a harness-injected " +
      "synthetic user message that emits NO hook event, leaving no transport-supplied field to " +
      "correlate on.",
  }),
  Object.freeze({
    violation: "raw-output-completion" as const,
    marker: /\bawait its (?:result|reply|evidence-json|structured result)\b/i,
    rationale:
      "defects:D173: a completion that hands back the child's own output is a body-returning " +
      "parent surface. Measured at 46,510 bytes on a 45,833-byte payload, against a 250-byte " +
      "handle-only acknowledgement.",
  }),
  Object.freeze({
    violation: "ordinary-validate-output" as const,
    marker: /validate_output\(/,
    rationale:
      "Under ref-first the output was ALREADY validated against the role's `outputSchema` inside " +
      "`storeDispatchResult`, which is where a child cannot choose what it is validated against. " +
      "A parent-side re-validation therefore adds no check and requires the body in the parent's " +
      "context to perform.",
  }),
]);

export interface ClaudeArtifactFinding {
  readonly artifact: string;
  readonly violation: ClaudeArtifactViolation;
  /** 1-based line number, so a reader can go straight to it. */
  readonly line: number;
  /** The offending line, trimmed. */
  readonly evidence: string;
  readonly rationale: string;
}

/**
 * Scan ONE generated Claude artifact for the four violations. A pure function of
 * the text: it reads no file and resolves no fragment, so a caller decides which
 * artifact is in scope and this function only says what is in it.
 *
 * A line carrying {@link CLAUDE_ARTIFACT_INSPECTION_TOKEN} is exempt, which is
 * how `fetch_prompt` and a deliberate debug `validate_output` stay available
 * without reopening the ordinary path.
 */
export function scanClaudeRefFirstArtifact(
  artifact: string,
  text: string,
): readonly ClaudeArtifactFinding[] {
  if (typeof text !== "string") {
    throw new AttestationContractError(
      "artifact.text",
      `expected the artifact text of "${String(artifact)}", got "${String(text)}"`,
    );
  }
  const findings: ClaudeArtifactFinding[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.includes(CLAUDE_ARTIFACT_INSPECTION_TOKEN)) continue;
    for (const { violation, marker, rationale } of CLAUDE_ARTIFACT_MARKERS) {
      if (marker.test(line)) {
        findings.push(
          Object.freeze({
            artifact,
            violation,
            line: index + 1,
            evidence: line.trim(),
            rationale,
          }),
        );
      }
    }
  }
  return Object.freeze(findings);
}

/** The distinct violations present in an artifact, sorted and de-duplicated. */
export function claudeArtifactViolations(
  artifact: string,
  text: string,
): readonly ClaudeArtifactViolation[] {
  return Object.freeze(
    [...new Set(scanClaudeRefFirstArtifact(artifact, text).map((f) => f.violation))].sort(),
  );
}

/**
 * Assert an artifact is ref-first clean. Throws naming the FIRST finding with its
 * line, so a failure is actionable without re-running the scanner by hand.
 */
export function assertClaudeRefFirstArtifact(artifact: string, text: string): void {
  const findings = scanClaudeRefFirstArtifact(artifact, text);
  const first = findings[0];
  if (first !== undefined) {
    throw new AttestationContractError(
      `artifact:${artifact}:${first.line}`,
      `${first.violation}: ${first.evidence} — ${first.rationale}`,
    );
  }
}

/** The deployed Claude assets that must remain ref-first clean. */
export const CLAUDE_REF_FIRST_ARTIFACTS = Object.freeze([
  "fragments/claude/subagent-dispatch.md",
  "fragments/claude/implement-dispatch-workflow.md",
  "commands/cq/implement/advance.md",
] as const);

// ---------------------------------------------------------------------------
// Deferred
// ---------------------------------------------------------------------------

/** The task that defines the protocol this module implements. */
export const CLAUDE_BRIDGE_DEFINED_BY = "T687" as const;

/** The task that proves this implementation end to end against a live child. */
export const CLAUDE_BRIDGE_PROVEN_BY = "T689" as const;

/**
 * Exactly how many times one dispatch's body crosses into the parent. ONE, on
 * fetch. Pinned as a number so the sequencer's fetch count is asserted rather
 * than reviewed.
 */
export const CLAUDE_BRIDGE_FETCH_COUNT = 1;

/**
 * What T688 deliberately leaves to another owner, so none of it is silently
 * assumed done.
 */
export const CLAUDE_BRIDGE_DEFERRED = Object.freeze([
  "implement-worktree_manage-prepare-and-release",
  "consolidate-the-duplicated-launch-gate-into-the-shared-module",
] as const);
