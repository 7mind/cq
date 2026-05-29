/**
 * Unit tests for the server-side internal WS service. These exercise:
 *  - per-process token generation,
 *  - constant-time auth on `Sec-WebSocket-Protocol`,
 *  - subprotocol echo on accept,
 *  - inbound routing through the handler map,
 *  - loop-detection via `sourcePid`,
 *  - forward-compat dropping of unknown discriminants.
 *
 * The cross-process integration with a real spawned cq-mcp lives in
 * `internalWs-integration.test.ts` (PR coherence-5).
 */

import { describe, it, expect } from "bun:test";
import {
  InternalWsService,
  type InternalWsConnData,
  type InternalWsSocket,
} from "../src/agent/internalWs";
import type { InternalWsMessage } from "@cq/shared";
import type { Logger } from "../src/log/logger";

function nullLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function makeServerStub(): {
  upgrades: Array<{ headers?: HeadersInit; data: InternalWsConnData }>;
  upgrade(
    req: Request,
    opts: { data: InternalWsConnData; headers?: HeadersInit },
  ): boolean;
} {
  const upgrades: Array<{ headers?: HeadersInit; data: InternalWsConnData }> = [];
  return {
    upgrades,
    upgrade(_req, opts): boolean {
      upgrades.push(opts);
      return true;
    },
  };
}

function makeSocketStub(clientId = "test-client"): InternalWsSocket & {
  sent: string[];
  closes: Array<{ code: number | undefined; reason: string | undefined }>;
} {
  const sent: string[] = [];
  const closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  return {
    data: { kind: "internal", clientId },
    send(s: string): number {
      sent.push(s);
      return s.length;
    },
    close(code?: number, reason?: string): void {
      closes.push({ code, reason });
    },
    sent,
    closes,
  };
}

describe("InternalWsService — token generation", () => {
  it("generates a 32-char hex token by default (16 bytes)", () => {
    const svc = new InternalWsService({ logger: nullLogger() });
    expect(svc.tokenForChild()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("honours the test-injected token", () => {
    const svc = new InternalWsService({ logger: nullLogger(), token: "deadbeef".repeat(4) });
    expect(svc.tokenForChild()).toBe("deadbeef".repeat(4));
  });

  it("selfPid honours the test-injected pid", () => {
    const svc = new InternalWsService({ logger: nullLogger(), pid: 9999 });
    expect(svc.selfPid()).toBe(9999);
  });
});

describe("InternalWsService — handleUpgrade auth", () => {
  function svcAndReq(headerValue: string | null): {
    svc: InternalWsService;
    req: Request;
    server: ReturnType<typeof makeServerStub>;
  } {
    const svc = new InternalWsService({
      logger: nullLogger(),
      token: "0011223344556677aabbccddeeff0011",
    });
    const headers = new Headers();
    if (headerValue !== null) headers.set("Sec-WebSocket-Protocol", headerValue);
    const req = new Request("http://x/__internal/cq-mcp", { headers });
    return { svc, req, server: makeServerStub() };
  }

  it("rejects 401 when the subprotocol header is missing", () => {
    const { svc, req, server } = svcAndReq(null);
    const res = svc.handleUpgrade(req, server);
    expect(res?.status).toBe(401);
    expect(server.upgrades.length).toBe(0);
  });

  it("rejects 401 when no candidate has the cq-internal prefix", () => {
    const { svc, req, server } = svcAndReq("other.protocol");
    const res = svc.handleUpgrade(req, server);
    expect(res?.status).toBe(401);
  });

  it("rejects 401 when the token length is wrong", () => {
    const { svc, req, server } = svcAndReq("cq-internal.0011");
    const res = svc.handleUpgrade(req, server);
    expect(res?.status).toBe(401);
  });

  it("rejects 401 when the token value is wrong (same length, different bytes)", () => {
    const { svc, req, server } = svcAndReq("cq-internal.0011223344556677aabbccddeeff0000");
    const res = svc.handleUpgrade(req, server);
    expect(res?.status).toBe(401);
  });

  it("accepts a valid token and echoes the subprotocol on upgrade", () => {
    const { svc, req, server } = svcAndReq("cq-internal.0011223344556677aabbccddeeff0011");
    const res = svc.handleUpgrade(req, server);
    expect(res).toBeUndefined();
    expect(server.upgrades.length).toBe(1);
    const opts = server.upgrades[0]!;
    expect(opts.data.kind).toBe("internal");
    const headers = new Headers(opts.headers ?? {});
    expect(headers.get("Sec-WebSocket-Protocol")).toBe(
      "cq-internal.0011223344556677aabbccddeeff0011",
    );
  });

  it("accepts when multiple subprotocols are offered (RFC 6455 list)", () => {
    const { svc, req, server } = svcAndReq(
      "junk.first, cq-internal.0011223344556677aabbccddeeff0011, other",
    );
    const res = svc.handleUpgrade(req, server);
    expect(res).toBeUndefined();
    expect(server.upgrades.length).toBe(1);
  });
});

describe("InternalWsService — inbound message routing", () => {
  function setup() {
    const svc = new InternalWsService({
      logger: nullLogger(),
      token: "x".repeat(32),
      pid: 1234,
    });
    const ws = makeSocketStub();
    svc.open(ws);
    return { svc, ws };
  }

  it("routes a valid ledger.changed from a foreign pid to the registered handler", () => {
    const { svc, ws } = setup();
    const seen: InternalWsMessage[] = [];
    svc.registerHandler("ledger.changed", (msg) => {
      seen.push(msg);
    });
    svc.message(ws, JSON.stringify({
      type: "ledger.changed",
      ledgerId: "defects",
      op: "update",
      sourcePid: 7777,
    }));
    expect(seen.length).toBe(1);
    expect(seen[0]?.type).toBe("ledger.changed");
  });

  it("drops a message whose sourcePid matches the service pid (loop-detection)", () => {
    const { svc, ws } = setup();
    let fired = 0;
    svc.registerHandler("ledger.changed", () => {
      fired += 1;
    });
    svc.message(ws, JSON.stringify({
      type: "ledger.changed",
      ledgerId: "defects",
      op: "update",
      sourcePid: 1234, // matches svc pid
    }));
    expect(fired).toBe(0);
  });

  it("drops malformed JSON without crashing", () => {
    const { svc, ws } = setup();
    let fired = 0;
    svc.registerHandler("ledger.changed", () => {
      fired += 1;
    });
    svc.message(ws, "not json");
    expect(fired).toBe(0);
  });

  it("drops a malformed envelope (missing required fields)", () => {
    const { svc, ws } = setup();
    let fired = 0;
    svc.registerHandler("ledger.changed", () => {
      fired += 1;
    });
    svc.message(ws, JSON.stringify({ type: "ledger.changed", ledgerId: "x" }));
    expect(fired).toBe(0);
  });

  it("drops an unknown discriminant (forward-compat)", () => {
    const { svc, ws } = setup();
    let fired = 0;
    svc.registerHandler("ledger.changed", () => {
      fired += 1;
    });
    svc.message(ws, JSON.stringify({
      type: "ask.request",
      payload: { x: 1 },
    }));
    expect(fired).toBe(0);
  });

  it("logs but does not crash when no handler is registered for a known type", () => {
    const { svc, ws } = setup();
    // No handler registered.
    expect(() =>
      svc.message(ws, JSON.stringify({
        type: "ledger.changed",
        ledgerId: "x",
        op: "create",
        sourcePid: 99,
      })),
    ).not.toThrow();
  });

  it("a throwing handler does not crash the WS layer", () => {
    const { svc, ws } = setup();
    svc.registerHandler("ledger.changed", () => {
      throw new Error("simulated handler crash");
    });
    expect(() =>
      svc.message(ws, JSON.stringify({
        type: "ledger.changed",
        ledgerId: "x",
        op: "create",
        sourcePid: 99,
      })),
    ).not.toThrow();
  });
});

describe("InternalWsService — broadcast", () => {
  it("sends a Zod-valid message to every connected socket", () => {
    const svc = new InternalWsService({ logger: nullLogger(), pid: 1, token: "x".repeat(32) });
    const a = makeSocketStub("a");
    const b = makeSocketStub("b");
    svc.open(a);
    svc.open(b);
    svc.broadcast({
      type: "ledger.changed",
      ledgerId: "defects",
      op: "update",
      sourcePid: 1,
    });
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(1);
    const decoded = JSON.parse(a.sent[0]!) as InternalWsMessage;
    expect(decoded.type).toBe("ledger.changed");
  });

  it("skips a closed socket but still delivers to the others", () => {
    const svc = new InternalWsService({ logger: nullLogger(), pid: 1, token: "x".repeat(32) });
    const a = makeSocketStub("a");
    const b = makeSocketStub("b");
    svc.open(a);
    svc.open(b);
    svc.close(a);
    svc.broadcast({
      type: "ledger.changed",
      ledgerId: "x",
      op: "create",
      sourcePid: 1,
    });
    expect(a.sent.length).toBe(0);
    expect(b.sent.length).toBe(1);
  });

  it("drops a malformed broadcast payload at the Zod boundary", () => {
    const svc = new InternalWsService({ logger: nullLogger(), pid: 1, token: "x".repeat(32) });
    const a = makeSocketStub("a");
    svc.open(a);
    // ts-expect-error — intentionally invalid input
    svc.broadcast({ type: "ledger.changed", ledgerId: "" } as InternalWsMessage);
    expect(a.sent.length).toBe(0);
  });
});
