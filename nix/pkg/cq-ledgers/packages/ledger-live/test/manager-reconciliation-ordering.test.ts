import { expect, it } from "bun:test";
import { LiveManager } from "../src/index.js";

type Handler = ((event: unknown) => void) | null;

class FakeWS {
  static instances: FakeWS[] = [];

  static reset(): void {
    FakeWS.instances = [];
  }

  readonly sent: string[] = [];
  readyState = 0;
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;

  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverClose(code = 1006, reason = "abnormal"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  lastPing(): { readonly nonce: string; readonly ts: number; readonly type: string } {
    const frame = [...this.sent].reverse().find((candidate) => candidate.includes('"ping"'));
    if (frame === undefined) throw new Error("expected a ping frame");
    return JSON.parse(frame) as { readonly nonce: string; readonly ts: number; readonly type: string };
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason: Error) => void;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

const WebSocketCtor = FakeWS as unknown as { new (url: string): WebSocket };
const sleep = (milliseconds: number): Promise<void> => Bun.sleep(milliseconds);

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(2);
  }
  throw new Error(`timed out waiting for ${description}`);
}

it("live recovery waits for heartbeat health and serialized reconciliation", async () => {
  FakeWS.reset();
  const reconciliation = deferred<void>();
  const changes: Array<string | null> = [];
  const manager = new LiveManager({
    url: "ws://example.test/ws",
    WebSocketCtor,
    pingIntervalMs: 10_000,
    pongTimeoutMs: 10_000,
    onChanged: async (ledger) => {
      changes.push(ledger);
      if (ledger === null) await reconciliation.promise;
    },
  });

  manager.start();
  const socket = FakeWS.instances[0]!;
  socket.open();
  socket.message({ type: "changed", ledger: "tasks" });
  socket.message({ type: "changed", ledger: "tasks" });
  expect(manager.getStats().state).toBe("connecting");
  expect(changes).toEqual([]);

  const ping = socket.lastPing();
  socket.message({ type: "pong", nonce: "wrong-nonce", ts: ping.ts });
  expect(manager.getStats().state).toBe("connecting");
  socket.message({ type: "pong", nonce: ping.nonce, ts: ping.ts });
  expect(manager.getStats().state).toBe("recovering");
  expect(changes).toEqual([null]);

  socket.message({ type: "changed", ledger: "tasks" });
  socket.message({ type: "changed", ledger: "tasks" });
  socket.message({ type: "changed", ledger: "milestones" });
  expect(changes).toEqual([null]);

  reconciliation.resolve();
  await waitFor(() => changes.length === 3, "buffered ledger reconciliations");
  expect(changes).toEqual([null, "tasks", "milestones"]);
  expect(manager.getStats().state).toBe("alive");
  manager.destroy();
});

it("lets null dominate buffered ledger ids without losing changes during the full refresh", async () => {
  FakeWS.reset();
  const recovery = deferred<void>();
  const fullRefresh = deferred<void>();
  const changes: Array<string | null> = [];
  const manager = new LiveManager({
    url: "ws://example.test/ws",
    WebSocketCtor,
    pingIntervalMs: 10_000,
    pongTimeoutMs: 10_000,
    onChanged: async (ledger) => {
      changes.push(ledger);
      if (changes.length === 1) await recovery.promise;
      if (changes.length === 2) await fullRefresh.promise;
    },
  });

  manager.start();
  const socket = FakeWS.instances[0]!;
  socket.open();
  const ping = socket.lastPing();
  socket.message({ type: "pong", nonce: ping.nonce, ts: ping.ts });
  socket.message({ type: "changed", ledger: "tasks" });
  socket.message({ type: "changed" });
  socket.message({ type: "changed", ledger: "milestones" });

  recovery.resolve();
  await waitFor(() => changes.length === 2, "coalesced full refresh");
  expect(changes).toEqual([null, null]);

  socket.message({ type: "changed", ledger: "tasks" });
  socket.message({ type: "changed", ledger: "tasks" });
  fullRefresh.resolve();
  await waitFor(() => changes.length === 3, "change received during full refresh");
  expect(changes).toEqual([null, null, "tasks"]);
  manager.destroy();
});

it("keeps failed recovery visible and retries before releasing buffered work", async () => {
  FakeWS.reset();
  const retry = deferred<void>();
  const changes: Array<string | null> = [];
  let recoveryAttempts = 0;
  const manager = new LiveManager({
    url: "ws://example.test/ws",
    WebSocketCtor,
    pingIntervalMs: 10_000,
    pongTimeoutMs: 10_000,
    baseBackoffMs: 1,
    onChanged: async (ledger) => {
      changes.push(ledger);
      if (ledger !== null) return;
      recoveryAttempts += 1;
      if (recoveryAttempts === 1) throw new Error("reconciliation failed");
      await retry.promise;
    },
  });

  manager.start();
  const socket = FakeWS.instances[0]!;
  socket.open();
  socket.message({ type: "changed", ledger: "tasks" });
  const ping = socket.lastPing();
  socket.message({ type: "pong", nonce: ping.nonce, ts: ping.ts });

  await waitFor(() => recoveryAttempts === 2, "recovery retry");
  expect(manager.getStats().state).toBe("recovering");
  expect(changes).toEqual([null, null]);

  retry.resolve();
  await waitFor(() => changes.length === 3, "buffered work after recovery retry");
  expect(changes).toEqual([null, null, "tasks"]);
  expect(manager.getStats().state).toBe("alive");
  manager.destroy();
});

it("does not reset reconnect accounting until a matching pong arrives", async () => {
  FakeWS.reset();
  const recovery = deferred<void>();
  const manager = new LiveManager({
    url: "ws://example.test/ws",
    WebSocketCtor,
    pingIntervalMs: 10_000,
    pongTimeoutMs: 10_000,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
    onChanged: () => recovery.promise,
  });

  manager.start();
  FakeWS.instances[0]!.serverClose();
  await waitFor(() => FakeWS.instances.length === 2, "replacement socket");
  const replacement = FakeWS.instances[1]!;
  replacement.open();
  expect(manager.getStats().attempt).toBe(1);
  expect(manager.getStats().state).toBe("connecting");

  const ping = replacement.lastPing();
  replacement.message({ type: "pong", nonce: ping.nonce, ts: ping.ts });
  expect(manager.getStats().attempt).toBe(0);
  expect(manager.getStats().state).toBe("recovering");
  recovery.resolve();
  await waitFor(() => manager.getStats().state === "alive", "healthy recovery");
  manager.destroy();
});

it("reaches maxAttempts when sockets open without returning a matching pong", async () => {
  FakeWS.reset();
  const manager = new LiveManager({
    url: "ws://example.test/ws",
    WebSocketCtor,
    pingIntervalMs: 10_000,
    pongTimeoutMs: 4,
    staleGraceMs: 1,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
    maxAttempts: 2,
    connectTimeoutMs: 100,
    onChanged: () => {},
  });

  manager.start();
  for (let index = 0; index < 3; index += 1) {
    await waitFor(() => FakeWS.instances.length > index, `socket ${index + 1}`);
    FakeWS.instances[index]!.open();
  }
  await waitFor(() => manager.getStats().state === "terminal", "terminal retry state");
  expect(FakeWS.instances).toHaveLength(3);
  expect(manager.getStats().attempt).toBe(2);
  manager.destroy();
});

it("ignores detached socket callbacks and late reconciliation completion", async () => {
  FakeWS.reset();
  const firstRecovery = deferred<void>();
  const secondRecovery = deferred<void>();
  const changes: Array<string | null> = [];
  const manager = new LiveManager({
    url: "ws://example.test/ws",
    WebSocketCtor,
    pingIntervalMs: 10_000,
    pongTimeoutMs: 10_000,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
    onChanged: async (ledger) => {
      changes.push(ledger);
      if (changes.length === 1) await firstRecovery.promise;
      if (changes.length === 2) await secondRecovery.promise;
    },
  });

  manager.start();
  const first = FakeWS.instances[0]!;
  first.open();
  const firstMessage = first.onmessage!;
  const firstPing = first.lastPing();
  first.message({ type: "pong", nonce: firstPing.nonce, ts: firstPing.ts });
  first.message({ type: "changed", ledger: "tasks" });
  first.serverClose();

  await waitFor(() => FakeWS.instances.length === 2, "second generation");
  firstMessage({ data: JSON.stringify({ type: "changed", ledger: "detached" }) });
  const second = FakeWS.instances[1]!;
  second.open();
  const secondPing = second.lastPing();
  second.message({ type: "pong", nonce: secondPing.nonce, ts: secondPing.ts });
  second.message({ type: "changed", ledger: "milestones" });
  expect(changes).toEqual([null, null]);

  firstRecovery.resolve();
  await sleep(5);
  expect(changes).toEqual([null, null]);
  expect(manager.getStats().state).toBe("recovering");

  secondRecovery.resolve();
  await waitFor(() => changes.length === 3, "active generation buffered work");
  expect(changes).toEqual([null, null, "milestones"]);
  manager.destroy();
});

it("does not release buffered callbacks after destroy", async () => {
  FakeWS.reset();
  const recovery = deferred<void>();
  const changes: Array<string | null> = [];
  const manager = new LiveManager({
    url: "ws://example.test/ws",
    WebSocketCtor,
    pingIntervalMs: 10_000,
    pongTimeoutMs: 10_000,
    onChanged: async (ledger) => {
      changes.push(ledger);
      await recovery.promise;
    },
  });

  manager.start();
  const socket = FakeWS.instances[0]!;
  socket.open();
  const detachedMessage = socket.onmessage!;
  const ping = socket.lastPing();
  socket.message({ type: "pong", nonce: ping.nonce, ts: ping.ts });
  socket.message({ type: "changed", ledger: "tasks" });
  manager.destroy();

  detachedMessage({ data: JSON.stringify({ type: "changed", ledger: "detached" }) });
  recovery.resolve();
  await sleep(5);
  expect(changes).toEqual([null]);
});
