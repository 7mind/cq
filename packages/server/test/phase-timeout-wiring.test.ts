/**
 * phase-timeout-wiring.test.ts — proves all three headless lanes (claudeProducer,
 * claudePhaseSubagent, codexHeadless via CodexProducer) resolve their dispatch
 * timeout through the shared `resolvePhaseTimeoutMs` helper (PHASE-TIMEOUT-01).
 *
 * Rather than wait out the 300_000 default wall-clock, each lane is driven with
 * a subagent that NEVER submits and a stream that NEVER ends, so the ONLY way
 * the dispatch settles is the timer. The `CQ_WORKFLOW_PHASE_TIMEOUT_MS` env var
 * is set to a tiny value and the rejection message — which echoes the effective
 * timeout (`timed out after <ms>ms`) — is asserted to carry THAT value. This
 * proves the env flows through each lane. A second case proves an explicit
 * `timeoutMs` opt still wins over the env.
 *
 * Env is set/restored in try/finally so nothing leaks across tests (testhyg).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type {
  Codex,
  CodexOptions,
  Thread,
  ThreadEvent,
  ThreadOptions,
  RunStreamedResult,
} from "@openai/codex-sdk";
import { ClaudeProducer } from "../src/workflow/claudeProducer";
import { ClaudePhaseSubagent } from "../src/workflow/claudePhaseSubagent";
import {
  CodexProducer,
  WorkflowSubmitProxy,
  makeSubmitIdGenerator,
  PHASE_TIMEOUT_ENV_VAR,
} from "../src/workflow/index";
import { CLARIFY_REVIEW_SPEC } from "../src/workflow/phases";
import { noopLogger, makeMockQuery, makeInitMessage } from "./helpers/mockBridge";

// A Claude mock query that emits an init message then never ends (next() pends
// forever), so only the timeout can settle the dispatch.
function makeNeverEndingClaudeQuery(): ReturnType<typeof makeMockQuery> {
  const q = makeMockQuery([makeInitMessage()]);
  (q as unknown as { next: () => Promise<never> }).next = () => new Promise<never>(() => {});
  return q;
}

// A Codex factory whose thread's runStreamed never yields and never ends, so
// only the timeout can settle the dispatch.
function makeNeverEndingCodexFactory(): (options?: CodexOptions) => Promise<Codex> {
  const thread: Thread = {
    id: "never-ending",
    async runStreamed(_input: string, _turnOptions?: unknown): Promise<RunStreamedResult> {
      // An async iterable whose next() never settles → the event stream never
      // yields and never ends, so only the dispatch timeout can resolve it.
      const events: AsyncIterable<ThreadEvent> = {
        [Symbol.asyncIterator](): AsyncIterator<ThreadEvent> {
          return { next: () => new Promise<never>(() => {}) };
        },
      };
      return { events } as unknown as RunStreamedResult;
    },
    async run(): Promise<never> {
      throw new Error("not exercised");
    },
  } as unknown as Thread;
  const codex = {
    startThread: (_o?: ThreadOptions): Thread => thread,
    resumeThread: (_id: string, _o?: ThreadOptions): Thread => thread,
  } as unknown as Codex;
  return async (_options?: CodexOptions): Promise<Codex> => codex;
}

function makeCodexProducer(timeoutMs?: number): CodexProducer {
  const submitProxy = new WorkflowSubmitProxy({ logger: noopLogger, sendAck: () => {} });
  return new CodexProducer({
    logger: noopLogger,
    cwd: "/tmp/phase-timeout-wiring",
    submitProxy,
    internalWsUrl: "ws://127.0.0.1:1/__internal/cq-mcp",
    internalWsToken: "tok",
    nextSubmitId: makeSubmitIdGenerator(7000),
    codexFactory: makeNeverEndingCodexFactory(),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

const TINY_ENV_MS = 40;
const TINY_OPT_MS = 25;

// Snapshot the env unconditionally per test (independent of whether a test
// mutates it) and restore after, so nothing leaks across tests.
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env[PHASE_TIMEOUT_ENV_VAR];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[PHASE_TIMEOUT_ENV_VAR];
  else process.env[PHASE_TIMEOUT_ENV_VAR] = savedEnv;
});
function setEnv(value: string): void {
  process.env[PHASE_TIMEOUT_ENV_VAR] = value;
}

describe("phase-timeout wiring — env override flows through every lane", () => {
  it("ClaudeProducer honors CQ_WORKFLOW_PHASE_TIMEOUT_MS", async () => {
    setEnv(String(TINY_ENV_MS));
    const producer = new ClaudeProducer({
      logger: noopLogger,
      cwd: "/tmp",
      queryFactory: () => makeNeverEndingClaudeQuery(),
    });
    await expect(producer.produce({ text: "build X" })).rejects.toThrow(
      new RegExp(`timed out after ${TINY_ENV_MS}ms`),
    );
  });

  it("ClaudePhaseSubagent honors CQ_WORKFLOW_PHASE_TIMEOUT_MS", async () => {
    setEnv(String(TINY_ENV_MS));
    const sub = new ClaudePhaseSubagent({
      logger: noopLogger,
      cwd: "/tmp",
      queryFactory: () => makeNeverEndingClaudeQuery(),
    });
    await expect(
      sub.dispatch(CLARIFY_REVIEW_SPEC, { prompt: "review" }),
    ).rejects.toThrow(new RegExp(`timed out after ${TINY_ENV_MS}ms`));
  });

  it("Codex lane honors CQ_WORKFLOW_PHASE_TIMEOUT_MS", async () => {
    setEnv(String(TINY_ENV_MS));
    await expect(makeCodexProducer().produce({ text: "build X" })).rejects.toThrow(
      new RegExp(`timed out after ${TINY_ENV_MS}ms`),
    );
  });
});

describe("phase-timeout wiring — explicit opt wins over env in every lane", () => {
  it("ClaudeProducer: explicit timeoutMs overrides the env", async () => {
    setEnv("999999");
    const producer = new ClaudeProducer({
      logger: noopLogger,
      cwd: "/tmp",
      queryFactory: () => makeNeverEndingClaudeQuery(),
      timeoutMs: TINY_OPT_MS,
    });
    await expect(producer.produce({ text: "build X" })).rejects.toThrow(
      new RegExp(`timed out after ${TINY_OPT_MS}ms`),
    );
  });

  it("ClaudePhaseSubagent: explicit timeoutMs overrides the env", async () => {
    setEnv("999999");
    const sub = new ClaudePhaseSubagent({
      logger: noopLogger,
      cwd: "/tmp",
      queryFactory: () => makeNeverEndingClaudeQuery(),
      timeoutMs: TINY_OPT_MS,
    });
    await expect(
      sub.dispatch(CLARIFY_REVIEW_SPEC, { prompt: "review" }),
    ).rejects.toThrow(new RegExp(`timed out after ${TINY_OPT_MS}ms`));
  });

  it("Codex lane: explicit timeoutMs overrides the env", async () => {
    setEnv("999999");
    await expect(makeCodexProducer(TINY_OPT_MS).produce({ text: "build X" })).rejects.toThrow(
      new RegExp(`timed out after ${TINY_OPT_MS}ms`),
    );
  });
});
