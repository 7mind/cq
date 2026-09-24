/**
 * G224 — production launch bindings for the CQ-driven dispatch driver: the
 * per-harness child correlation minted before prepare, and each target
 * harness's process adapter bound to this project's configuration.
 *
 * A harness without a process launcher here is refused at `plan`, before
 * anything is prepared, rather than failing after a dispatch exists.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  CODEX_EXPECTED_RUN_ID_ENV,
  CODEX_FALLBACK_DELIVERY_MODE,
  claudeExpectedChild,
  codexDispatchedRoleSandboxMode,
  codexExpectedChild,
  codexLaunchGate,
  createClaudeProcessDispatchAdapter,
  decideCodexCompletion,
  withoutWorksetCredentials,
  type AttestationEnvelope,
  type ClaudeChildCorrelation,
  type CodexChildCorrelation,
  type DispatchAdapterLaunchResult,
  type DispatchAdapterLaunchContext,
  type DispatchHandle,
  type DispatchTransportAdapter,
  type Harness,
  type NativeChildIdentity,
} from "@cq/config";
import type { WorksetEffectAdmissionProvider } from "@cq/process-control";
import { CQ_DISPATCH_RESULT_CAPABILITY_ENV } from "./boundResultCapability.js";
import type { DispatchLaunchPlanner, PlannedDispatchLaunch } from "./dispatchDriver.js";

/** The ledger server name a child sees; role prompts address `mcp__ledger__*`. */
export const CHILD_LEDGER_SERVER_NAME = "ledger";

export interface DispatchLaunchBindingOptions {
  /** The project that owns every prepared dispatch (the parent's ledger cwd). */
  readonly ledgerCwd: string;
  /** The packaged prompt-surfaces root carrying one directory per harness. */
  readonly promptSurfacesRoot: string;
  /** The `cq` executable a child uses to reach its own ledger server. */
  readonly ledgerCommand: string;
  readonly claudeExecutable: string;
  /** The packaged Codex role launcher (`cq-codex-role`), the one production Codex launcher. */
  readonly codexRoleCommand: string;
  readonly effectAdmission: WorksetEffectAdmissionProvider;
  readonly readEnvelope: (handle: DispatchHandle) => Promise<AttestationEnvelope | undefined>;
  readonly now: () => string;
}

export interface DispatchLaunchBindings {
  readonly planner: DispatchLaunchPlanner;
  readonly adapters: readonly DispatchTransportAdapter[];
}

type LaunchCorrelation =
  | { readonly harness: "claude"; readonly correlation: ClaudeChildCorrelation }
  | { readonly harness: "codex"; readonly correlation: CodexChildCorrelation };

/** Bytes of a failed launcher's stderr kept in the abort details. */
const LAUNCHER_DIAGNOSTIC_LIMIT = 1_024;
/** 24 random bytes encode to the 32 base64url characters a Codex correlation id requires. */
const CODEX_CORRELATION_ID_BYTES = 24;

export class DispatchLaunchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchLaunchUnavailableError";
  }
}

function handleKey(handle: DispatchHandle): string {
  return `${handle.attestationId}:${String(handle.generation)}`;
}

/** The directory a child runs in: its dispatch's absolute worktree, else the project. */
async function childCwd(
  options: DispatchLaunchBindingOptions,
  context: DispatchAdapterLaunchContext,
): Promise<string> {
  const envelope = await options.readEnvelope({
    attestationId: context.prepared.attestationId,
    generation: context.prepared.generation,
  });
  if (envelope === undefined) {
    throw new DispatchLaunchUnavailableError("the prepared dispatch has no live envelope to launch");
  }
  const input = envelope.input;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const worktreePath = (input as Readonly<Record<string, unknown>>)["worktreePath"];
    if (typeof worktreePath === "string" && path.isAbsolute(worktreePath)) return worktreePath;
  }
  return options.ledgerCwd;
}

export function createDispatchLaunchBindings(options: DispatchLaunchBindingOptions): DispatchLaunchBindings {
  const correlations = new Map<string, LaunchCorrelation>();

  function planned(expectedChild: NativeChildIdentity, correlation: LaunchCorrelation): PlannedDispatchLaunch {
    return {
      expectedChild,
      bind: (handle) => {
        correlations.set(handleKey(handle), correlation);
      },
      release: (handle) => {
        correlations.delete(handleKey(handle));
      },
    };
  }

  const planner: DispatchLaunchPlanner = {
    plan(targetHarness: Harness, roleId: string): PlannedDispatchLaunch {
      if (targetHarness === "claude") {
        // The print report binds the child's session id as both nonce and run.
        const sessionId = randomUUID();
        const correlation: ClaudeChildCorrelation = { roleId, launchNonce: sessionId, sessionId };
        return planned(claudeExpectedChild(correlation), { harness: "claude", correlation });
      }
      if (targetHarness === "codex") {
        const correlation: CodexChildCorrelation = {
          agentType: roleId,
          correlationId: randomBytes(CODEX_CORRELATION_ID_BYTES).toString("base64url"),
          threadId: `cq-run-${randomUUID()}`,
        };
        return planned(codexExpectedChild(correlation), { harness: "codex", correlation });
      }
      throw new DispatchLaunchUnavailableError(
        `no CQ process launcher is available for target harness ${JSON.stringify(targetHarness)}`,
      );
    },
  };

  const claudeSurfaceRoot = path.join(options.promptSurfacesRoot, "claude");
  const claude = createClaudeProcessDispatchAdapter(options.effectAdmission, async (context) => {
    const launch = correlations.get(
      handleKey({ attestationId: context.prepared.attestationId, generation: context.prepared.generation }),
    );
    if (launch?.harness !== "claude") {
      throw new DispatchLaunchUnavailableError("the Claude launch has no correlation bound to its handle");
    }
    const roleId = context.prepared.promptProvenance.roleId;
    return {
      correlation: launch.correlation,
      model: context.resolvedModel.model,
      now: options.now,
      launchOptions: {
        claudeExecutable: options.claudeExecutable,
        claudeArgsPrefix: [],
        cwd: await childCwd(options, context),
        rolePrompt: await readFile(path.join(claudeSurfaceRoot, "roles", `${roleId}.md`), "utf8"),
        storeServer: {
          name: CHILD_LEDGER_SERVER_NAME,
          command: options.ledgerCommand,
          args: ["mcp", "--cwd", options.ledgerCwd, "--prompt-surface", "claude", "--prompt-root", claudeSurfaceRoot],
          cwd: options.ledgerCwd,
          env: { CQ_HARNESS: "claude", CQ_PROMPT_SURFACE: "claude", CQ_PROMPT_ROOT: claudeSurfaceRoot },
          capabilityEnv: CQ_DISPATCH_RESULT_CAPABILITY_ENV,
        },
      },
    };
  });

  const codexSurfaceRoot = path.join(options.promptSurfacesRoot, "codex");
  const codex: DispatchTransportAdapter = Object.freeze({
    id: "codex:process" as const,
    targetHarness: "codex" as const,
    transport: "process" as const,
    launch: async (context: DispatchAdapterLaunchContext): Promise<DispatchAdapterLaunchResult> => {
      const handle = { attestationId: context.prepared.attestationId, generation: context.prepared.generation };
      const launch = correlations.get(handleKey(handle));
      if (launch?.harness !== "codex") {
        throw new DispatchLaunchUnavailableError("the Codex launch has no correlation bound to its handle");
      }
      const gate = codexLaunchGate(context.prepared, options.now());
      if (!gate.launch) {
        return { outcome: "aborted", reason: gate.abortReason, details: { refusal: gate.refusal, detail: gate.detail } };
      }
      const effort = context.resolvedModel.effort;
      if (effort === undefined || effort === null) {
        throw new DispatchLaunchUnavailableError("a Codex target token must carry a reasoning effort");
      }
      const roleId = context.prepared.promptProvenance.roleId;
      const envelope = await options.readEnvelope(handle);
      const input = envelope?.input;
      const cohort =
        input !== null && typeof input === "object" && !Array.isArray(input)
          ? (input as Readonly<Record<string, unknown>>)["cohort"]
          : undefined;
      // The exact private request the Codex parent contract writes to cq-codex-role.
      const request = {
        roleId,
        handle,
        inputCapability: context.prepared.inputCapability,
        resultCapability: context.prepared.resultCapability,
        effectTargetRef: context.effectTargetRef,
        ...(context.prepared.parentGateCapability === undefined
          ? {}
          : { parentGateCapability: context.prepared.parentGateCapability }),
        ...(context.prepared.gitChangeCapability === undefined
          ? {}
          : { gitChangeCapability: context.prepared.gitChangeCapability }),
        ...(context.prepared.gitConflictCapability === undefined
          ? {}
          : { gitConflictCapability: context.prepared.gitConflictCapability }),
        ...(cohort === undefined ? {} : { cohort }),
        cwd: await childCwd(options, context),
        ledgerCwd: options.ledgerCwd,
        model: context.resolvedModel.model,
        reasoningEffort: effort,
        sandboxMode: codexDispatchedRoleSandboxMode(roleId),
        timeoutMs: gate.childWindowMs,
      };
      const child = Bun.spawn([options.codexRoleCommand], {
        cwd: options.ledgerCwd,
        env: {
          ...withoutWorksetCredentials(process.env),
          CQ_PROMPT_ROOT: codexSurfaceRoot,
          CQ_PROMPT_SURFACE: "codex",
          CQ_CODEX_LEDGER_COMMAND: options.ledgerCommand,
          CQ_CODEX_ROLE_CORRELATION_ID: launch.correlation.correlationId,
          ...(roleId === "implement-worker" ? { [CODEX_EXPECTED_RUN_ID_ENV]: launch.correlation.threadId } : {}),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(`${JSON.stringify(request)}\n`);
      await child.stdin.end();
      const [exitStatus, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitStatus !== 0) {
        return {
          outcome: "aborted",
          reason: "native-failure",
          details: { source: "cq-codex-role", exitStatus, stderr: stderr.slice(-LAUNCHER_DIAGNOSTIC_LIMIT) },
        };
      }
      const decision = decideCodexCompletion({
        handle,
        expectedChild: launch.correlation,
        observation: {
          source: "transport",
          mode: CODEX_FALLBACK_DELIVERY_MODE,
          agentType: roleId,
          correlationId: launch.correlation.correlationId,
          threadId: launch.correlation.threadId,
          outcome: "completed",
          exitStatus,
          finalMessage: stdout.trim().split("\n").at(-1) ?? "",
          observedAt: options.now(),
        },
      });
      if (decision.action === "abort") {
        return { outcome: "aborted", reason: decision.reason, details: decision.details };
      }
      return {
        outcome: "completed",
        handle,
        nativeCompletion: decision.nativeCompletion,
        handleOnlyEnforcement: "structural",
      };
    },
  });

  return { planner, adapters: [claude, codex] };
}
