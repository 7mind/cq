/**
 * warmup-activity.test.ts — ACTIVITY-01-D03: a freshly-started (warm-up) session
 * must NOT report a turn in flight until a real turn actually begins.
 *
 * Regression for the production defect where `ActiveSession` was constructed with
 * `turnInFlight: true`, so `isTurnInFlight()` returned true the instant the
 * session was created — before any `chat.input` and with an EMPTY input queue.
 * The aggregate-activity badge (which reads `isTurnInFlight()` via the tracker's
 * `isChatBusy`) therefore latched "BUSY (1)" on the auto-started warm-up session
 * and never settled to NEW/IDLE, because that warm-up turn never runs a real
 * turn through to `chat.done` (the only place that clears the flag).
 *
 * The correct lifecycle: a fresh session is IDLE (`isTurnInFlight() === false`);
 * a real turn (`chat.input`) sets it true (BUSY); `chat.done` clears it (IDLE).
 *
 * Harness: a mock query that yields NOTHING and hangs forever, so the session is
 * constructed and stays alive but no turn ever streams — exactly the warm-up
 * shape (chat.start with an empty queue, no chat.input yet). A second case drives
 * a real turn (input → result → chat.done) and asserts BUSY-then-IDLE.
 */

import { describe, it, expect } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionRegistry } from "../src/seq/sessionRegistry";
import { Bridge } from "../src/agent/bridge";
import {
  noopLogger,
  MockWsSocket,
  patchStubs,
  makeInitMessage,
  makeResultMessage,
  makeChatStart,
  makeChatInput,
  type MockQuery,
} from "./helpers/mockBridge";

/** A mock query that yields the given head messages then hangs forever. */
function makeHangingQuery(head: SDKMessage[]): MockQuery {
  let release!: () => void;
  const hang = new Promise<void>((r) => {
    release = r;
  });
  const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
    for (const m of head) yield m;
    await hang;
  })();
  const query = gen as unknown as MockQuery;
  patchStubs(query);
  query.interrupt = async () => {};
  query.close = () => release();
  return query;
}

/**
 * A mock query whose `result` (end-of-turn) message is GATED behind `openGate()`
 * and which then hangs (session stays alive). It yields `init` immediately, then
 * blocks until the gate opens before yielding `result`. This mirrors production
 * ordering — the SDK emits its end-of-turn `result` only AFTER it has received
 * the user's first input on stdin — so the test can deterministically observe the
 * BUSY window (input sent, result not yet landed) before the turn completes.
 */
function makeGatedTurnQuery(): { query: MockQuery; openGate: () => void } {
  let openGate!: () => void;
  const gate = new Promise<void>((r) => {
    openGate = r;
  });
  let release!: () => void;
  const hang = new Promise<void>((r) => {
    release = r;
  });
  const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
    yield makeInitMessage();
    await gate;
    yield makeResultMessage();
    await hang;
  })();
  const query = gen as unknown as MockQuery;
  patchStubs(query);
  query.interrupt = async () => {};
  query.close = () => release();
  return { query, openGate };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for predicate");
}

describe("Warm-up session activity (ACTIVITY-01-D03)", () => {
  it("a freshly-started session with no turn yet is NOT in flight (badge IDLE, not BUSY)", async () => {
    // Warm-up shape: chat.start, empty input queue, NO chat.input. The query
    // yields nothing and hangs, so the session is alive but no turn streams.
    const query = makeHangingQuery([]);
    const registry = new SessionRegistry();
    const busyChanges: boolean[] = [];
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => query,
      cwd: "/tmp/test",
      onBusyChange: () => busyChanges.push(bridge.isTurnInFlight()),
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.started");

    // The session is alive (pool=1 busy) but NO turn is in flight — nothing is
    // streaming and the input queue is empty. This is the warm-up state the
    // badge must render as NEW/IDLE (running=0), not BUSY (1).
    expect(bridge.isBusy()).toBe(true); // session alive
    expect(bridge.isTurnInFlight()).toBe(false); // but no turn → tracker running=0

    // It must STAY false — give the background runLoop time to spin; the flag
    // must never latch true on its own without a real chat.input.
    await Bun.sleep(50);
    expect(bridge.isTurnInFlight()).toBe(false);
    // No spurious turn-start notification was emitted.
    expect(busyChanges).not.toContain(true);

    await bridge.shutdown();
  });

  it("a real turn drives the warm-up session BUSY then back to IDLE", async () => {
    // After warm-up start, a real chat.input begins a turn (BUSY); when the turn
    // completes, the result message drives chat.done which clears the flag (IDLE).
    // The result is GATED so the BUSY window is observed deterministically before
    // the turn settles (mirrors production: result lands only after input).
    const { query, openGate } = makeGatedTurnQuery();
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => query,
      cwd: "/tmp/test",
    });

    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());
    const [started] = await ws.waitForFrames("chat.started");
    const sessionId = started!.sessionId as string;

    // Fresh: not in flight (warm-up, no turn yet).
    expect(bridge.isTurnInFlight()).toBe(false);

    // A real user turn → BUSY. The result is still gated, so the turn is in
    // flight and cannot have completed yet.
    await bridge.handleChatInput(ws, makeChatInput(sessionId, "do work"));
    expect(bridge.isTurnInFlight()).toBe(true);

    // Release the turn: result → per-turn chat.done → flag clears → IDLE.
    openGate();
    await ws.waitForFrames("chat.done");
    await waitFor(() => !bridge.isTurnInFlight());
    expect(bridge.isTurnInFlight()).toBe(false);
    expect(bridge.isBusy()).toBe(true); // session still alive (query hangs)

    await bridge.shutdown();
  });
});
