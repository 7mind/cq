/**
 * G224 — production launch bindings for the CQ-driven dispatch driver: the
 * per-harness child correlation minted before prepare, and each target
 * harness's process adapter bound to this project's configuration.
 *
 * A harness without a process launcher here is refused at `plan`, before
 * anything is prepared, rather than failing after a dispatch exists.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  PiChildResultError,
  piChildArgv,
  piChildFinalText,
  piChildResult,
  piDispatchBuiltinTools,
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
import { WorksetEffectBroker, type WorksetEffectAdmissionProvider } from "@cq/process-control";
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
  readonly piExecutable: string;
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
  | { readonly harness: "codex"; readonly correlation: CodexChildCorrelation }
  | { readonly harness: "pi"; readonly correlation: NativeChildIdentity };

/** Pi child ids follow the `<roleId>#<nonce>` shape staged-worker qualification checks. */
const PI_CHILD_ID_SEPARATOR = "#";
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

  function planned(
    expectedChild: NativeChildIdentity,
    correlation: LaunchCorrelation,
    qualificationIdentity: PlannedDispatchLaunch["qualificationIdentity"],
  ): PlannedDispatchLaunch {
    return {
      expectedChild,
      qualificationIdentity,
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
        return planned(
          claudeExpectedChild(correlation),
          { harness: "claude", correlation },
          { correlationId: sessionId, childThreadId: sessionId, runId: sessionId },
        );
      }
      if (targetHarness === "codex") {
        const correlation: CodexChildCorrelation = {
          agentType: roleId,
          correlationId: randomBytes(CODEX_CORRELATION_ID_BYTES).toString("base64url"),
          threadId: `cq-run-${randomUUID()}`,
        };
        return planned(codexExpectedChild(correlation), { harness: "codex", correlation }, {
          correlationId: correlation.correlationId,
          childThreadId: correlation.threadId,
          runId: correlation.threadId,
        });
      }
      const nonce = randomUUID();
      const runId = `cq-pi-run-${randomUUID()}`;
      const correlation: NativeChildIdentity = { childId: `${roleId}${PI_CHILD_ID_SEPARATOR}${nonce}`, runId };
      return planned(correlation, { harness: "pi", correlation }, {
        correlationId: nonce,
        childThreadId: runId,
        runId,
      });
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

  const piSurfaceRoot = path.join(options.promptSurfacesRoot, "pi");
  const pi: DispatchTransportAdapter = Object.freeze({
    id: "pi:process" as const,
    targetHarness: "pi" as const,
    transport: "process" as const,
    launch: async (context: DispatchAdapterLaunchContext): Promise<DispatchAdapterLaunchResult> => {
      const handle = { attestationId: context.prepared.attestationId, generation: context.prepared.generation };
      const launch = correlations.get(handleKey(handle));
      if (launch?.harness !== "pi") {
        throw new DispatchLaunchUnavailableError("the Pi launch has no correlation bound to its handle");
      }
      // The same prepared-deadline gate every process adapter applies.
      const gate = codexLaunchGate(context.prepared, options.now());
      if (!gate.launch) {
        return { outcome: "aborted", reason: gate.abortReason, details: { refusal: gate.refusal, detail: gate.detail } };
      }
      const roleId = context.prepared.promptProvenance.roleId;
      const rolePrompt = await readFile(path.join(piSurfaceRoot, "roles", `${roleId}.md`), "utf8");
      const tools = piDispatchBuiltinTools(rolePrompt, roleId);
      // The server is the Pi child's parent: it materializes the typed input
      // and stores the fenced result, so the child needs no ledger tool.
      const materialized = await context.child.materializeInput();
      const scratch = await mkdtemp(path.join(tmpdir(), "cq-pi-role-"));
      try {
        const rolePromptFile = path.join(scratch, `${roleId}.md`);
        await writeFile(rolePromptFile, rolePrompt, { mode: 0o600 });
        const argv = piChildArgv({
          piExecutable: options.piExecutable,
          token: context.resolvedModel,
          tools,
          rolePromptFile,
          task: JSON.stringify(materialized.input),
        });
        const broker = new WorksetEffectBroker({ provider: options.effectAdmission });
        const launched = await broker.launch({
          kind: "child-dispatch",
          targetRef: context.effectTargetRef,
          argv,
          cwd: await childCwd(options, context),
          env: withoutWorksetCredentials(process.env),
          stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" } as const,
          timeoutMs: gate.childWindowMs,
          launchBootstrap: (specification) => {
            const child = Bun.spawn([...specification.argv], {
              cwd: specification.cwd,
              detached: specification.detached,
              env: specification.env,
              stdin: specification.stdio.stdin,
              stdout: specification.stdio.stdout,
              stderr: specification.stdio.stderr,
            });
            const stdout = new Response(child.stdout).text();
            const stderr = new Response(child.stderr).text();
            return {
              process: { stdout, stderr },
              pid: child.pid,
              exited: child.exited,
              outputDrained: Promise.all([stdout, stderr]).then(() => undefined),
              resultFromTargetOutcome: (outcome) => outcome.exitCode ?? 1,
              terminate: (signal: NodeJS.Signals) => child.kill(signal),
            };
          },
        });
        const [exitStatus, stdout, stderr] = await Promise.all([
          launched.exited,
          launched.process.stdout,
          launched.process.stderr,
        ]);
        if (exitStatus !== 0) {
          return {
            outcome: "aborted",
            reason: launched.terminationReason === "timeout" ? "deadline-exceeded" : "native-failure",
            details: { source: "pi-process", exitStatus, stderr: stderr.slice(-LAUNCHER_DIAGNOSTIC_LIMIT) },
          };
        }
        let output;
        try {
          output = piChildResult(piChildFinalText(stdout));
        } catch (error) {
          if (!(error instanceof PiChildResultError)) throw error;
          return { outcome: "aborted", reason: "invalid-output", details: { source: "pi-process", detail: error.message } };
        }
        const stored = await context.child.storeResult(output);
        if (stored.state === "aborted") {
          return { outcome: "aborted", reason: stored.result.reason, storeResultAbortReason: stored.result.reason };
        }
        return {
          outcome: "completed",
          handle,
          nativeCompletion: {
            kind: "native-completion",
            actor: "trusted-extension",
            childId: launch.correlation.childId,
            runId: launch.correlation.runId,
            completedAt: options.now(),
          },
          handleOnlyEnforcement: "structural",
        };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  });

  return { planner, adapters: [claude, codex, pi] };
}
