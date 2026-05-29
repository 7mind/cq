/**
 * Unit tests for the cq-mcp internal WS client. Each test spins up a
 * minimal Bun.serve fake that speaks the same handshake/protocol the
 * cq server's InternalWsService does, so the client's behaviour is
 * exercised end-to-end without depending on the real server.
 */

import { describe, it, expect, afterAll } from "bun:test";
import {
  INTERNAL_WS_PATH,
  INTERNAL_WS_SUBPROTOCOL_PREFIX,
  type InternalWsMessage,
} from "@cq/shared";
import { InternalWsChannel } from "../src/internalWs";

interface FakeServer {
  url: string;
  inbound: InternalWsMessage[];
  sendToClient: (msg: unknown) => void;
  stop: () => void;
  acceptedSubprotocol: string | null;
}

function startFakeServer(opts: {
  expectedToken?: string;
  refuseAuth?: boolean;
  closeImmediately?: boolean;
}): FakeServer {
  const inbound: InternalWsMessage[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sendBound: ((msg: any) => void) | null = null;
  let acceptedSubprotocol: string | null = null;
  const server = Bun.serve<{ kind: "internal" }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== INTERNAL_WS_PATH) {
        return new Response("nope", { status: 404 });
      }
      if (opts.refuseAuth === true) {
        return new Response("Unauthorized", { status: 401 });
      }
      const proto = req.headers.get("Sec-WebSocket-Protocol") ?? "";
      let token: string | null = null;
      for (const raw of proto.split(",")) {
        const p = raw.trim();
        const dot = p.indexOf(".");
        if (dot <= 0) continue;
        if (p.slice(0, dot) !== INTERNAL_WS_SUBPROTOCOL_PREFIX) continue;
        token = p.slice(dot + 1);
        break;
      }
      if (opts.expectedToken !== undefined && token !== opts.expectedToken) {
        return new Response("Unauthorized", { status: 401 });
      }
      const accepted = `${INTERNAL_WS_SUBPROTOCOL_PREFIX}.${token}`;
      acceptedSubprotocol = accepted;
      const ok = srv.upgrade(req, {
        data: { kind: "internal" },
        headers: { "Sec-WebSocket-Protocol": accepted },
      });
      if (!ok) return new Response("upgrade failed", { status: 426 });
      return undefined;
    },
    websocket: {
      open(ws) {
        sendBound = (msg: unknown): void => {
          ws.send(JSON.stringify(msg));
        };
        if (opts.closeImmediately === true) ws.close(1000, "test");
      },
      message(_ws, raw) {
        try {
          inbound.push(JSON.parse(raw.toString()) as InternalWsMessage);
        } catch {
          /* ignore */
        }
      },
      close() {
        sendBound = null;
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}${INTERNAL_WS_PATH}`,
    inbound,
    sendToClient: (msg): void => sendBound?.(msg),
    stop: (): void => {
      server.stop();
    },
    get acceptedSubprotocol(): string | null {
      return acceptedSubprotocol;
    },
  };
}

const stopList: Array<() => void> = [];
afterAll(() => {
  for (const s of stopList) s();
});

function track(s: FakeServer): FakeServer {
  stopList.push(s.stop);
  return s;
}

describe("InternalWsChannel — happy path", () => {
  it("connects against a fake server, sends + receives messages, then closes", async () => {
    const token = "deadbeefdeadbeefdeadbeefdeadbeef";
    const fake = track(startFakeServer({ expectedToken: token }));
    const channel = await InternalWsChannel.connect({
      url: fake.url,
      token,
      timeoutMs: 2000,
    });
    expect(channel.isClosed()).toBe(false);

    // Outbound.
    channel.send({
      type: "ledger.changed",
      ledgerId: "x",
      op: "create",
      sourcePid: process.pid,
    });
    // Allow the message to reach the server.
    await waitFor(() => fake.inbound.length === 1, 1000);
    expect(fake.inbound[0]?.type).toBe("ledger.changed");
    expect(fake.inbound[0]?.ledgerId).toBe("x");

    // Inbound — register a handler and have the fake server send.
    const received: InternalWsMessage[] = [];
    channel.registerHandler("ledger.changed", async (msg) => {
      received.push(msg);
    });
    fake.sendToClient({
      type: "ledger.changed",
      ledgerId: "from-server",
      op: "update",
      sourcePid: 99999, // not our pid → not loop-detected
    });
    await waitFor(() => received.length === 1, 1000);
    expect(received[0]?.ledgerId).toBe("from-server");

    channel.close();
    expect(channel.isClosed()).toBe(true);
  });
});

describe("InternalWsChannel — connect failures", () => {
  it("rejects on 401", async () => {
    const fake = track(startFakeServer({ refuseAuth: true }));
    await expect(
      InternalWsChannel.connect({
        url: fake.url,
        token: "x".repeat(32),
        timeoutMs: 2000,
      }),
    ).rejects.toBeDefined();
  });

  it("rejects on timeout when the URL is unreachable", async () => {
    // Reserve an ephemeral port + immediately stop a server to free it,
    // then try to dial the freed port. May still connect on some
    // platforms (rare); accept either rejection mode.
    const tmp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const url = `ws://127.0.0.1:${tmp.port}${INTERNAL_WS_PATH}`;
    tmp.stop();
    await expect(
      InternalWsChannel.connect({ url, token: "x".repeat(32), timeoutMs: 250 }),
    ).rejects.toBeDefined();
  });
});

describe("InternalWsChannel — loop detection", () => {
  it("drops inbound messages whose sourcePid matches our pid", async () => {
    const token = "feedfacefeedfacefeedfacefeedface";
    const fake = track(startFakeServer({ expectedToken: token }));
    const channel = await InternalWsChannel.connect({
      url: fake.url,
      token,
      timeoutMs: 2000,
    });
    let fired = 0;
    channel.registerHandler("ledger.changed", async () => {
      fired += 1;
    });
    fake.sendToClient({
      type: "ledger.changed",
      ledgerId: "x",
      op: "create",
      sourcePid: process.pid,
    });
    // Give the handler a tick to NOT fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(fired).toBe(0);
    channel.close();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
