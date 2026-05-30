/**
 * bridge-activity.test.ts — ACTIVITY-01-D01: the chat lane's activity signal is
 * PER-TURN, not per-session.
 *
 * In cq's multi-turn streaming model the `query()` (and thus `isBusy()` /
 * `active !== null`) stays alive across turns. The aggregate-activity badge must
 * NOT show BUSY between turns while the model is idle. `isTurnInFlight()` is the
 * per-turn signal: true while a turn streams, false once `chat.done` lands,
 * true again on the next `chat.input`. The `onBusyChange` callback fires on each
 * such transition so the tracker can recompute.
 *
 * Harness: a mock query that yields init → result (turn 1 done) → then HANGS on
 * a never-resolving promise so the session stays alive (no iteration-end, no
 * shutdown). This reproduces the live multi-turn idle gap.
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

/** Build a mock query that yields the given head messages then hangs forever. */
function makeHangingQuery(head: SDKMessage[]): { query: MockQuery; release: () => void } {
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
  return { query, release };
}

/**
 * A query whose end-of-turn `result` is GATED behind `openGate()`, then hangs
 * (session stays alive). Yields `init` immediately, blocks on the gate, then
 * yields `result`. Mirrors production ordering (the SDK emits `result` only after
 * it has the user's input), so turn 1's BUSY window can be observed before it
 * settles — ACTIVITY-01-D03 made the construction-time `turnInFlight` false, so a
 * turn is in flight only once a real `chat.input` starts it.
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

describe("Bridge chat-lane activity is per-turn (ACTIVITY-01-D01)", () => {
  it("isTurnInFlight clears on chat.done but isBusy stays true between turns", async () => {
    // init → (gate) → result (turn 1 completes) → hang (session stays alive,
    // idle). The result is gated so turn 1's BUSY window is observed before it
    // settles. ACTIVITY-01-D03: a fresh session is NOT in flight; turn 1 begins
    // only when the first chat.input arrives, not at construction.
    const { query, openGate } = makeGatedTurnQuery();
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
    const [started] = await ws.waitForFrames("chat.started");
    const sessionId = started!.sessionId as string;

    // Fresh session: no turn yet (ACTIVITY-01-D03) — the warm-up auto-start must
    // NOT report BUSY before any real input.
    expect(bridge.isTurnInFlight()).toBe(false);

    // The first chat.input begins turn 1 → in flight. The result is still gated,
    // so the turn cannot have completed.
    await bridge.handleChatInput(ws, makeChatInput(sessionId, "turn one"));
    expect(bridge.isTurnInFlight()).toBe(true);

    // Release turn 1: the result message drives a per-turn chat.done;
    // turnInFlight must clear, but the session stays alive (isBusy stays true)
    // because the query hangs.
    openGate();
    await ws.waitForFrames("chat.done");
    await waitFor(() => !bridge.isTurnInFlight());
    expect(bridge.isTurnInFlight()).toBe(false); // idle between turns
    expect(bridge.isBusy()).toBe(true); // session still alive

    // A new chat.input begins turn 2 → in flight again.
    await bridge.handleChatInput(ws, makeChatInput(sessionId, "next turn"));
    expect(bridge.isTurnInFlight()).toBe(true);

    // onBusyChange fired across the transitions: input(true) → done(false) →
    // input(true). (The exact sequence must contain these in order.)
    expect(busyChanges).toContain(true);
    expect(busyChanges).toContain(false);
    // First notification was the turn-start (true); a later one was the
    // turn-end (false); the next input re-raised it (true).
    const firstFalseIdx = busyChanges.indexOf(false);
    expect(firstFalseIdx).toBeGreaterThanOrEqual(0);
    expect(busyChanges.slice(firstFalseIdx + 1)).toContain(true);

    await bridge.shutdown();
  });

  it("isTurnInFlight is false once the session shuts down", async () => {
    const { query } = makeHangingQuery([makeInitMessage(), makeResultMessage()]);
    const registry = new SessionRegistry();
    const bridge = new Bridge({
      logger: noopLogger,
      registry,
      queryFactory: () => query,
      cwd: "/tmp/test",
    });
    const ws = new MockWsSocket();
    await bridge.handleChatStart(ws, makeChatStart());
    await ws.waitForFrames("chat.started");
    await ws.waitForFrames("chat.done");

    await bridge.shutdown();
    await Bun.sleep(20);
    expect(bridge.isTurnInFlight()).toBe(false);
    expect(bridge.isBusy()).toBe(false);
  });
});
