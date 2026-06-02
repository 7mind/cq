/**
 * fs-watch coherence + WebSocket push.
 *
 * 1) A store with a watcher notices writes made by a SEPARATE store instance
 *    (the cross-process case) and serves fresh reads after the debounce.
 * 2) The HTTP server pushes a `changed` frame over /ws when files change, and
 *    answers app-level ping with a nonce-matched pong.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsLedgerStore, type LedgerSchema } from "@cq/ledger";
import { serveHttp, changedFrame, LEDGER_TOPIC, WS_PATH } from "../src/main.js";
import { startLedgerWatcher } from "../src/watcher.js";

const opsSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { headline: { type: "string", required: true } },
};

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe("fs-watch cross-process coherence", () => {
  it("re-reads a ledger after another process writes it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-watch-"));
    const a = new FsLedgerStore({ root });
    await a.init();
    await a.createLedger("ops", opsSchema);
    const ms = await a.createMilestone({ id: "M1", title: "m1" });
    const watcher = startLedgerWatcher(a, root); // invalidate-only

    // Sanity: A sees no items yet.
    expect(a.fetch("ops").milestones.flatMap((g) => g.items)).toHaveLength(0);

    // A DIFFERENT store writes an item to the same files.
    const b = new FsLedgerStore({ root });
    await b.init();
    await b.createItem("ops", ms.id, { status: "open", fields: { headline: "from B" } });
    await b.dispose();

    // After the watcher's debounce, A's cache reflects B's write.
    const seen = await waitUntil(
      () => a.fetch("ops").milestones.flatMap((g) => g.items).some((i) => i.fields["headline"] === "from B"),
    );
    expect(seen).toBe(true);

    watcher.close();
    await a.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("ledger-mcp WebSocket push", () => {
  let root: string;
  let store: FsLedgerStore;
  let server: ReturnType<typeof Bun.serve>;
  let watcher: ReturnType<typeof startLedgerWatcher>;
  let msId: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-ws-"));
    store = new FsLedgerStore({ root });
    await store.init();
    await store.createLedger("ops", opsSchema);
    msId = (await store.createMilestone({ id: "M1", title: "m1" })).id;
    server = serveHttp(store, { host: "127.0.0.1", port: 0 }, "test-project");
    watcher = startLedgerWatcher(store, root, (ledger) => {
      server.publish(LEDGER_TOPIC, changedFrame(ledger));
    });
  });

  afterAll(async () => {
    watcher.close();
    server.stop(true);
    await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("answers ping with a nonce-matched pong and pushes changed on a file write", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`);
    const msgs: Array<{ type?: string; nonce?: string; ledger?: string }> = [];
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws error"));
      setTimeout(() => rej(new Error("ws open timeout")), 3000);
    });
    ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));

    ws.send(JSON.stringify({ type: "ping", nonce: "n1", ts: Date.now() }));
    expect(await waitUntil(() => msgs.some((m) => m.type === "pong" && m.nonce === "n1"))).toBe(true);

    // A separate store writes → the watcher publishes a `changed` frame.
    const b = new FsLedgerStore({ root });
    await b.init();
    await b.createItem("ops", msId, { status: "open", fields: { headline: "live" } });
    await b.dispose();

    expect(await waitUntil(() => msgs.some((m) => m.type === "changed" && m.ledger === "ops"))).toBe(true);
    ws.close();
  });
});
