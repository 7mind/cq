/**
 * bridgeFacade.test.ts — codex-4 facade behaviour.
 *
 * Verifies that the `Bridge` facade in `bridge.ts`:
 *  (a) routes Claude ChatStart frames to ClaudeBridge,
 *  (b) returns the same activeSessionId as the active backend,
 *  (c) preserves the public broker properties so existing fixtures
 *      (bridge.test.ts, bridge-persist.test.ts, ask-question.test.ts)
 *      continue to compile,
 *  (d) implements BackendBridge by structural compatibility.
 *
 * Codex-platform routing is covered in codex-5 once CodexBridge exists.
 */

import { describe, it, expect } from "bun:test";
import { Bridge, ClaudeBridge } from "../src/agent/bridge";
import type { BackendBridge } from "../src/agent/bridge";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import { InMemoryPersistence } from "../src/persist/InMemoryPersistence";
import { PermissionBroker } from "../src/agent/permission";
import { ElicitationBroker } from "../src/agent/elicitation";
import { AskBroker } from "../src/agent/askUserQuestion";
import {
  noopLogger,
  MockWsSocket,
  makeMockQuery,
  patchStubs,
  makeInitMessage,
  makeChatStart,
  type MockQuery,
} from "./helpers/mockBridge";

/**
 * Build a mock query that emits init then hangs until interrupt/close is
 * called. The hang keeps the runLoop alive so the facade reports an active
 * session — without this the iterator exhausts on init and runLoop's finally
 * clears `active` before the test can observe it.
 */
function hangingMockQuery(): { query: MockQuery; release: () => void } {
  let releaseFn = (): void => {};
  const hangPromise = new Promise<void>((r) => { releaseFn = r; });
  const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
    yield makeInitMessage();
    await hangPromise;
  })();
  const q = gen as unknown as MockQuery;
  patchStubs(q);
  q.interrupt = async (): Promise<void> => { releaseFn(); };
  q.close = (): void => { releaseFn(); };
  return { query: q, release: releaseFn };
}

function makeFacade(opts: { hanging?: boolean } = {}): {
  facade: Bridge;
  persistence: InMemoryPersistence;
  release: () => void;
} {
  const persistence = new InMemoryPersistence();
  const registry = new SessionRegistry();
  if (opts.hanging) {
    const { query, release } = hangingMockQuery();
    const facade = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => query,
      cwd: "/tmp/test",
      persistence,
    });
    return { facade, persistence, release };
  }
  const mockQuery = makeMockQuery([makeInitMessage()]);
  const facade = new Bridge({
    logger: noopLogger,
    registry,
    queryFactory: () => mockQuery,
    cwd: "/tmp/test",
    persistence,
  });
  return { facade, persistence, release: () => {} };
}

describe("Bridge facade (codex-4)", () => {
  it("default-platform ChatStart routes to the Claude backend", async () => {
    const { facade } = makeFacade({ hanging: true });
    const ws = new MockWsSocket();
    await facade.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.started", 1, 3000);
    expect(facade.activeSessionId()).not.toBeNull();
    await facade.shutdown();
    expect(facade.activeSessionId()).toBeNull();
  });

  it("isBusy() reports the underlying backend's status", async () => {
    const { facade } = makeFacade({ hanging: true });
    expect(facade.isBusy()).toBe(false);
    const ws = new MockWsSocket();
    await facade.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.started", 1, 3000);
    expect(facade.isBusy()).toBe(true);
    await facade.shutdown();
    expect(facade.isBusy()).toBe(false);
  });

  it("exposes the Claude brokers via getters (for existing fixture compatibility)", () => {
    const { facade } = makeFacade();
    expect(facade.permissionBroker).toBeInstanceOf(PermissionBroker);
    expect(facade.elicitationBroker).toBeInstanceOf(ElicitationBroker);
    expect(facade.askBroker).toBeInstanceOf(AskBroker);
  });

  it("structurally implements BackendBridge", () => {
    const { facade } = makeFacade();
    const asBackend: BackendBridge = facade;
    expect(typeof asBackend.handleChatStart).toBe("function");
    expect(typeof asBackend.handleChatInput).toBe("function");
    expect(typeof asBackend.handleChatInterrupt).toBe("function");
    expect(typeof asBackend.handleChatRejoin).toBe("function");
    expect(typeof asBackend.handleChatPermissionReply).toBe("function");
    expect(typeof asBackend.handleChatElicitationReply).toBe("function");
    expect(typeof asBackend.handleChatQuestionReply).toBe("function");
    expect(typeof asBackend.handleChatReadFileRequest).toBe("function");
    expect(typeof asBackend.interruptActive).toBe("function");
    expect(typeof asBackend.shutdown).toBe("function");
    expect(typeof asBackend.isBusy).toBe("function");
    expect(typeof asBackend.activeSessionId).toBe("function");
  });

  it("ClaudeBridge is also exported directly and is its own BackendBridge", () => {
    // codex-5 will construct CodexBridge similarly. Test ensures the rename
    // didn't break the direct import path some tests might use.
    const registry = new SessionRegistry();
    const claude = new ClaudeBridge({
      logger: noopLogger,
      registry,
      queryFactory: () => makeMockQuery([makeInitMessage()]),
      cwd: "/tmp/test",
    });
    const asBackend: BackendBridge = claude;
    expect(asBackend.isBusy()).toBe(false);
    expect(asBackend.activeSessionId()).toBeNull();
  });

  it("explicit platform='claude' is accepted and routed to Claude", async () => {
    const { facade } = makeFacade({ hanging: true });
    const ws = new MockWsSocket();
    await facade.handleChatStart(ws, {
      ...makeChatStart(),
      platform: "claude",
    });
    await ws.waitForFrames("chat.started", 1, 3000);
    expect(facade.activeSessionId()).not.toBeNull();
    await facade.shutdown();
  });

  it("a refused start (platform-mismatch) releases the facade's active slot", async () => {
    const { facade, persistence } = makeFacade();

    // Seed a Codex session row + invocation so the platform-mismatch path
    // triggers when the facade routes a Claude resume against it.
    const sessionId = "00000000-0000-4000-d000-000000000001";
    const invId = "00000000-0000-4000-d000-000000000002";
    persistence.sessions.insert({
      id: sessionId,
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 30_000,
      cwd: "/tmp",
      model: "gpt-5.1",
      permissionMode: "default",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheRead: 0,
      totalCacheCreate: 0,
      totalCostUsd: 0,
      endedReason: "completed",
      title: "",
      lastServerSeq: 0,
      sdkSessionId: null,
      platform: "codex",
      effort: "high",
    });
    persistence.invocations.insert({
      id: invId,
      sessionId,
      parentInvocationId: null,
      resumedFromInvocationId: null,
      agentName: "main",
      agentId: null,
      taskId: null,
      toolUseId: null,
      model: "gpt-5.1",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 30_000,
      durationMs: 30_000,
      status: "completed",
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      promptExcerpt: "",
      eventLogPath: `${sessionId}/${invId}.jsonl`,
      ownerPid: null,
    });

    const ws = new MockWsSocket();
    await facade.handleChatStart(ws, {
      type: "chat.start",
      seq: 0,
      ts: Date.now(),
      model: "claude-opus-4-7",
      platform: "claude",
      resumeFromInvocationId: invId,
    });

    // Refusal should produce a chat.error and leave the facade unbusy.
    const errors = ws.framesOfType("chat.error");
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("platform-mismatch");
    expect(facade.isBusy()).toBe(false);
    expect(facade.activeSessionId()).toBeNull();
  });
});
