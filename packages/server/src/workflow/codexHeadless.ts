/**
 * codexHeadless.ts — shared plumbing for the HEADLESS Codex workflow lane
 * (codexwf). The Codex analogue of `headlessQuery.ts` (which serves the Claude
 * lane).
 *
 * Both the Codex producer and the Codex phase subagents dispatch a headless
 * `Codex` thread that NEVER goes through the interactive `Bridge` facade: own
 * Codex instance, own thread, no `SessionRegistry` session, no `chat.*` frames.
 * The pool=1 interactive-chat invariant is therefore held by construction —
 * `CodexBridge.active` is untouched.
 *
 * Structured output is forced via the harness-owned `submit_workflow_phase`
 * MCP tool exposed by a per-dispatch `cq-mcp` child (spawned by the Codex CLI
 * from `config.mcp_servers.cq`). The child is primed via env with
 * `CQ_WORKFLOW_SUBMIT_ID` + `CQ_WORKFLOW_PHASE` so its submit tool relays
 * `workflow.submit` correlated to THIS dispatch. The server-side
 * `WorkflowSubmitProxy` validates the relayed payload against the phase schema
 * and resolves the promise this module awaits. cq-mcp NEVER writes ledgers for
 * the submit tool — the HARNESS (WorkflowRuntime) does.
 *
 * The dispatch resolves with the validated payload (when the proxy resolves the
 * registered promise) and rejects on timeout / abort / a thread that ends
 * without the model ever calling the submit tool. On every exit path it calls
 * `proxy.reject(submitId)` so a torn-down dispatch never leaves a dangling
 * correlation, and surfaces a `registerTeardown` awaitable that settles when
 * the codex thread's event stream is drained.
 */

import type { z } from "zod";
import type { Codex, CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import type { Logger } from "../log/logger";
import type { WorkflowSubmitPhase } from "@cq/shared";
import type { CqMcpBin } from "../agent/codexBridge.js";
import { defaultResolveCqMcpBin } from "../agent/codexBridge.js";
import type { WorkflowSubmitProxy } from "./workflowSubmitProxy.js";
import type { TeardownSink } from "./producer.js";

/** Factory the headless lane calls to obtain a `Codex`. Injectable for tests. */
export type CodexFactory = (options?: CodexOptions) => Promise<Codex>;

/** Default 120 s dispatch timeout (matches the Claude headless lane). */
export const DEFAULT_CODEX_TIMEOUT_MS = 120_000;

/** Everything the shared dispatch needs that is constant across phases. */
export interface CodexHeadlessDeps {
  logger: Logger;
  /** Working directory for the codex thread + the cq-mcp child's --cwd. */
  cwd: string;
  /** The WorkflowSubmitProxy this server owns — register/await/reject here. */
  submitProxy: WorkflowSubmitProxy;
  /** Internal-WS URL the spawned cq-mcp dials (set after the server binds). */
  internalWsUrl: string;
  /** Internal-WS token for the spawned cq-mcp. */
  internalWsToken: string;
  /** Mints a unique-per-process submitId. */
  nextSubmitId: () => string;
  /** Codex factory (default: real SDK). */
  codexFactory?: CodexFactory;
  /** How to launch cq-mcp (default: defaultResolveCqMcpBin()). */
  cqMcpBin?: CqMcpBin;
  /** Dispatch timeout in ms (default 120_000). */
  timeoutMs?: number;
}

/** Per-dispatch inputs that vary by phase. */
export interface CodexDispatchInput<O> {
  /** Which /plan phase (selects the cq-mcp submit env + the proxy schema). */
  readonly phase: WorkflowSubmitPhase;
  /** The Zod schema the proxy validates the relayed payload against. */
  readonly schema: z.ZodType<O>;
  /** Short label for logs. */
  readonly label: string;
  /** The fully-built prompt for this dispatch. */
  readonly prompt: string;
  /** Optional model override. */
  readonly model?: string;
  /** Abort signal — the runtime aborts on shutdown / preempt. */
  readonly signal?: AbortSignal;
  /** Optional sink for the event-stream-drain awaitable. */
  readonly registerTeardown?: TeardownSink;
}

/**
 * The Codex submit instruction appended to every phase prompt. The shared
 * prompt-builders (`phases.ts` / `producer.ts`) instruct the model to call a
 * Claude-style `submit_<phase>` in-process tool which does NOT exist on the
 * Codex path; this suffix overrides that with the single relay tool
 * `submit_workflow_phase`, called with the structured result wrapped in
 * `{ payload: ... }`. Kept explicit so the model reliably picks the relay tool.
 */
export const CODEX_SUBMIT_INSTRUCTION = [
  "",
  "",
  "IMPORTANT (Codex): ignore any earlier instruction naming a `submit_*` tool.",
  "On THIS run there is exactly one submit tool available: `submit_workflow_phase`.",
  "Call `submit_workflow_phase` with a SINGLE argument named `payload` whose value",
  "is the ENTIRE structured result object described above — do NOT spread the",
  "result's fields as separate tool arguments, and do NOT flatten nested objects",
  "into strings. The call shape is exactly: submit_workflow_phase({ payload: <the",
  "whole result object, with its nested objects/arrays intact> }). If the tool",
  "replies that the payload was rejected, fix it per the error and call again.",
  "Do NOT write to any ledger, file, or call any other tool. Do NOT ask the user",
  "anything.",
].join("\n");

/**
 * Mint a unique-per-process submitId generator: `<prefix>-<pid>-<counter>`.
 * The pid disambiguates across processes; the counter within one process.
 */
export function makeSubmitIdGenerator(pid: number): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `wfsubmit-${pid}-${counter}`;
  };
}

/**
 * Dispatch one headless Codex phase and resolve with the validated structured
 * payload relayed back through cq-mcp + the WorkflowSubmitProxy.
 *
 * Ordering is load-bearing: we `register` the submit correlation on the proxy
 * BEFORE starting the codex thread, so a fast relay cannot arrive before the
 * proxy can correlate it.
 */
export async function dispatchCodexPhase<O>(
  deps: CodexHeadlessDeps,
  input: CodexDispatchInput<O>,
): Promise<O> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  const submitId = deps.nextSubmitId();

  // Register the correlation FIRST so a fast relay is never orphaned.
  const submittedPayload = deps.submitProxy.register(submitId, input.phase, input.schema);

  let onAbort: (() => void) | undefined;
  // The promise we actually await: the relayed+validated payload, OR a
  // timeout / abort / stream-ended rejection — whichever settles first.
  let rejectRace!: (err: Error) => void;
  const raceReject = new Promise<never>((_resolve, reject) => {
    rejectRace = reject;
  });

  const timer = setTimeout(() => {
    rejectRace(new Error(`codex ${input.label} timed out after ${timeoutMs}ms without submitting`));
  }, timeoutMs);

  if (input.signal !== undefined) {
    onAbort = (): void => rejectRace(new Error(`codex ${input.label} aborted`));
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Build the Codex options: point mcp_servers.cq at the cq-mcp bin and prime
  // it with the internal-WS connection + the per-dispatch submitId + phase.
  const cqMcpBin = deps.cqMcpBin ?? defaultResolveCqMcpBin();
  const cqMcpEntry: Record<string, string | string[] | Record<string, string>> = {
    command: cqMcpBin.command,
    args: [...cqMcpBin.args, "--cwd", deps.cwd],
    env: {
      CQ_INTERNAL_WS_URL: deps.internalWsUrl,
      CQ_INTERNAL_WS_TOKEN: deps.internalWsToken,
      CQ_WORKFLOW_SUBMIT_ID: submitId,
      CQ_WORKFLOW_PHASE: input.phase,
    },
  };
  const codexOptions: CodexOptions = {
    config: {
      mcp_servers: {
        cq: cqMcpEntry as unknown as Record<string, string | string[]>,
      },
    },
  };

  const factory = deps.codexFactory ?? defaultCodexFactory;
  const codex = await factory(codexOptions);

  const threadOptions: ThreadOptions = {
    workingDirectory: deps.cwd,
    skipGitRepoCheck: true,
    // The phase subagent only reads context + calls the submit tool; deny disk
    // writes so a misbehaving model cannot mutate the working tree.
    sandboxMode: "danger-full-access",
    // The Codex CLI's default approval policy ("on-request") gates MCP tool
    // calls — with no interactive approver in the headless lane the CLI
    // auto-CANCELS the model's `submit_workflow_phase` call ("user cancelled
    // MCP tool call"), so the relay never fires. "never" auto-approves tool
    // calls; combined with read-only sandbox the model can call the harness
    // submit tool (which writes nothing locally) but cannot mutate the tree.
    approvalPolicy: "never",
  };
  if (input.model !== undefined && input.model.length > 0) threadOptions.model = input.model;

  const thread = codex.startThread(threadOptions);

  // Drive the codex event stream in the background. The stream ending before
  // the model calls submit is a failure — reject the race. The drain promise
  // doubles as the teardown awaitable.
  const drain = (async (): Promise<void> => {
    try {
      const fullPrompt = input.prompt + CODEX_SUBMIT_INSTRUCTION;
      const turnOptions = input.signal !== undefined ? { signal: input.signal } : {};
      const streamed = await thread.runStreamed(fullPrompt, turnOptions);
      const debug = process.env["CQ_CODEXWF_DEBUG"] === "1";
      for await (const event of streamed.events as AsyncGenerator<ThreadEvent>) {
        // Events are intentionally discarded — the headless lane does not
        // stream to any UI; the structured result arrives via the relay.
        if (debug) {
          const e = event as { type: string; item?: { type?: string; tool?: string; text?: string; error?: unknown } };
          process.stderr.write(
            `[codexwf-debug] event=${e.type}` +
              (e.item ? ` item=${e.item.type ?? ""}${e.item.tool ? `/${e.item.tool}` : ""}${e.item.error ? ` err=${JSON.stringify(e.item.error)}` : ""}${e.item.text ? ` text=${e.item.text.slice(0, 200)}` : ""}` : "") +
              "\n",
          );
        }
      }
      // Stream ended. If the proxy already resolved, the race below has the
      // payload; otherwise the model finished without submitting → reject.
      rejectRace(new Error(`codex ${input.label} finished without calling submit_workflow_phase`));
    } catch (err: unknown) {
      rejectRace(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  try {
    return await Promise.race([submittedPayload, raceReject]);
  } finally {
    clearTimeout(timer);
    if (input.signal !== undefined && onAbort !== undefined) {
      input.signal.removeEventListener("abort", onAbort);
    }
    // Always drop the correlation so a late relay after we've settled is
    // treated as unknown (acked false) rather than resolving a dead dispatch.
    deps.submitProxy.reject(submitId, `codex ${input.label} dispatch settled`);
    // Surface the stream-drain awaitable so the runtime can await teardown.
    const teardown = drain.then(
      () => undefined,
      () => undefined,
    );
    if (input.registerTeardown !== undefined) input.registerTeardown(teardown);
    else void teardown;
  }
}

/**
 * Default Codex factory — lazy ESM import (codex-sdk is ESM-only). Mirrors
 * CodexBridge's default factory.
 */
const defaultCodexFactory: CodexFactory = async (options?: CodexOptions): Promise<Codex> => {
  const mod = await import("@openai/codex-sdk");
  const Ctor = (mod as { Codex: new (o?: CodexOptions) => Codex }).Codex;
  return new Ctor(options);
};
