/**
 * LiveManager tests driven by a fake WebSocket (no network, no real timers
 * beyond short ones). Covers: connect→heartbeat→alive, pong→rtt, `changed`
 * dispatch, missed-pong → stale → reconnect, non-retriable close → terminal,
 * and max-attempts → terminal.
 */

import { describe, it, expect } from "bun:test";
import { LiveManager } from "../src/index.js";

type Handler = ((ev: unknown) => void) | null;

class FakeWS {
  static instances: FakeWS[] = [];
  static reset(): void {
    FakeWS.instances = [];
  }
  readyState = 0;
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
  }
  // test drivers
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  lastPing(): { type: string; nonce: string; ts: number } {
    const ping = [...this.sent].reverse().find((s) => s.includes('"ping"'));
    return JSON.parse(ping ?? "{}") as { type: string; nonce: string; ts: number };
  }
}

const Ctor = FakeWS as unknown as { new (url: string): WebSocket };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("LiveManager", () => {
  it("connects, goes alive, heartbeats, measures RTT, and dispatches changed", async () => {
    FakeWS.reset();
    const changed: Array<string | null> = [];
    const mgr = new LiveManager({
      url: "ws://x/ws",
      onChanged: (l) => {
        changed.push(l);
      },
      WebSocketCtor: Ctor,
      pingIntervalMs: 1000,
      pongTimeoutMs: 1000,
    });
    mgr.start();
    const ws = FakeWS.instances[0]!;
    ws.open();
    expect(mgr.getStats().state).toBe("connecting");
    const ping = ws.lastPing();
    expect(ping.type).toBe("ping");
    ws.message({ type: "pong", nonce: ping.nonce, ts: ping.ts });
    expect(mgr.getStats().rttMs).not.toBeNull();
    await Promise.resolve();
    expect(mgr.getStats().state).toBe("alive");
    ws.message({ type: "changed", ledger: "tasks" });
    await Promise.resolve();
    ws.message({ type: "changed" });
    await Promise.resolve();
    expect(changed).toEqual([null, "tasks", null]);
    mgr.destroy();
  });

  it("goes stale on a missed pong then reconnects", async () => {
    FakeWS.reset();
    const mgr = new LiveManager({
      url: "ws://x/ws",
      onChanged: () => {},
      WebSocketCtor: Ctor,
      pingIntervalMs: 10_000,
      pongTimeoutMs: 20,
      staleGraceMs: 20,
      baseBackoffMs: 5,
      maxBackoffMs: 10,
    });
    mgr.start();
    FakeWS.instances[0]!.open();
    await sleep(25); // pong never arrives → stale
    expect(["stale", "dead", "connecting"]).toContain(mgr.getStats().state);
    await sleep(80); // grace expires → reconnect
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(2);
    mgr.destroy();
  });

  it("treats a non-retriable close as terminal (no reconnect)", () => {
    FakeWS.reset();
    const mgr = new LiveManager({ url: "ws://x/ws", onChanged: () => {}, WebSocketCtor: Ctor });
    mgr.start();
    const ws = FakeWS.instances[0]!;
    ws.open();
    ws.serverClose(1008, "policy violation");
    expect(mgr.getStats().state).toBe("terminal");
    expect(mgr.getStats().isTerminal).toBe(true);
    expect(FakeWS.instances).toHaveLength(1);
    mgr.destroy();
  });

  it("stops (terminal) after exhausting max attempts", async () => {
    FakeWS.reset();
    const mgr = new LiveManager({
      url: "ws://x/ws",
      onChanged: () => {},
      WebSocketCtor: Ctor,
      maxAttempts: 1,
      baseBackoffMs: 5,
      maxBackoffMs: 10,
      connectTimeoutMs: 10_000,
    });
    mgr.start();
    FakeWS.instances[0]!.serverClose(1006, "abnormal"); // attempt 0 → schedule (attempt→1)
    await sleep(40);
    expect(FakeWS.instances.length).toBe(2);
    FakeWS.instances[1]!.serverClose(1006, "abnormal"); // attempt 1 ≥ max → terminal
    expect(mgr.getStats().state).toBe("terminal");
    expect(mgr.getStats().isTerminal).toBe(true);
    mgr.destroy();
  });
});
