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
    // init → result (turn 1 completes) → hang (session stays alive, idle).
    const { query } = makeHangingQuery([makeInitMessage(), makeResultMessage()]);
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

    // Turn 1 begins immediately on start → in flight.
    expect(bridge.isTurnInFlight()).toBe(true);

    // The result message drives a per-turn chat.done; turnInFlight must clear,
    // but the session stays alive (isBusy stays true) because the query hangs.
    await ws.waitForFrames("chat.done");
    await waitFor(() => !bridge.isTurnInFlight());
    expect(bridge.isTurnInFlight()).toBe(false); // idle between turns
    expect(bridge.isBusy()).toBe(true); // session still alive

    // A new chat.input begins turn 2 → in flight again.
    await bridge.handleChatInput(ws, makeChatInput(sessionId, "next turn"));
    expect(bridge.isTurnInFlight()).toBe(true);

    // onBusyChange fired across the transitions: start(true) → done(false) →
    // input(true). (The exact sequence must contain these in order.)
    expect(busyChanges).toContain(true);
    expect(busyChanges).toContain(false);
    // First notification was the turn-start (true); a later one was the
    // turn-end (false); the input re-raised it (true).
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
