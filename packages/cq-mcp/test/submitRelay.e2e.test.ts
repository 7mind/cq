/**
 * cq-mcp submit-relay end-to-end (codexwf).
 *
 * Spawns the REAL cq-mcp stdio binary with the workflow env
 * (CQ_INTERNAL_WS_URL/TOKEN + CQ_WORKFLOW_SUBMIT_ID/PHASE) pointed at a FAKE
 * internal-WS server, then drives it through the MCP Client. Asserts:
 *   1. tools/list now includes `submit_workflow_phase` (15-tool surface).
 *   2. calling it relays `workflow.submit{submitId,phase,payload}` to the fake
 *      server, which acks {ok:true}; the tool returns success.
 *
 * This isolates the relay seam from codex entirely — proving the cq-mcp side of
 * the relay works regardless of real-Codex model behaviour.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FsLedgerStore } from "@cq/ledger";
import {
  INTERNAL_WS_PATH,
  INTERNAL_WS_SUBPROTOCOL_PREFIX,
  type InternalWsMessage,
} from "@cq/shared";

const TOKEN = "cafef00dcafef00dcafef00dcafef00d";
const SUBMIT_ID = "wfsubmit-test-1";

function resolveBinPath(): { command: string; args: string[] } {
  const here = new URL(".", import.meta.url).pathname;
  const main = path.resolve(here, "..", "src", "main.ts");
  return { command: process.execPath, args: ["run", main] };
}

/** A fake cq-server internal-WS endpoint that auto-acks any workflow.submit. */
function startFakeWsServer(): {
  url: string;
  inbound: InternalWsMessage[];
  stop: () => void;
} {
  const inbound: InternalWsMessage[] = [];
  const server = Bun.serve<{ kind: "internal" }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== INTERNAL_WS_PATH) return new Response("nope", { status: 404 });
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
      if (token !== TOKEN) return new Response("Unauthorized", { status: 401 });
      const ok = srv.upgrade(req, {
        data: { kind: "internal" },
        headers: { "Sec-WebSocket-Protocol": `${INTERNAL_WS_SUBPROTOCOL_PREFIX}.${token}` },
      });
      if (!ok) return new Response("upgrade failed", { status: 426 });
      return undefined;
    },
    websocket: {
      open() {},
      message(ws, raw) {
        let msg: InternalWsMessage;
        try {
          msg = JSON.parse(raw.toString()) as InternalWsMessage;
        } catch {
          return;
        }
        inbound.push(msg);
        if (msg.type === "workflow.submit") {
          // Auto-ack ok so the parked submit tool resolves.
          ws.send(
            JSON.stringify({
              type: "workflow.submit_ack",
              submitId: msg.submitId,
              ok: true,
              sourcePid: 999999,
            }),
          );
        }
      },
      close() {},
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}${INTERNAL_WS_PATH}`,
    inbound,
    stop: () => server.stop(),
  };
}

let tmpRoot: string;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cq-mcp-submit-"));
  const store = new FsLedgerStore({ root: tmpRoot });
  await store.init();
  await store.dispose();
});
afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("cq-mcp submit_workflow_phase relay (codexwf, real binary)", () => {
  it("registers the tool with workflow env and relays workflow.submit, returning ok on ack", async () => {
    const fake = startFakeWsServer();
    const { command, args } = resolveBinPath();
    const transport = new StdioClientTransport({
      command,
      args: [...args, "--cwd", tmpRoot],
      stderr: "inherit",
      env: {
        ...process.env,
        CQ_INTERNAL_WS_URL: fake.url,
        CQ_INTERNAL_WS_TOKEN: TOKEN,
        CQ_WORKFLOW_SUBMIT_ID: SUBMIT_ID,
        CQ_WORKFLOW_PHASE: "produce",
      } as Record<string, string>,
    });
    const client = new Client({ name: "cq-mcp-submit-test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
    try {
      // 1. tools/list includes submit_workflow_phase (15-tool surface).
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain("submit_workflow_phase");
      expect(names.length).toBe(15); // 14 ledger tools (incl. fts_search) + the relay tool

      // 2. Calling it relays workflow.submit and resolves on the auto-ack.
      const payload = { goal: { description: "x" }, questions: [{ question: "q?" }] };
      const result = await client.callTool({
        name: "submit_workflow_phase",
        arguments: { payload },
      });
      const block = (result.content as Array<{ type: string; text: string }>)[0]!;
      expect(JSON.parse(block.text)).toEqual({ ok: true });

      // The fake server saw the relayed submit with the primed id + phase.
      const submit = fake.inbound.find((m) => m.type === "workflow.submit");
      expect(submit).toBeDefined();
      if (submit?.type === "workflow.submit") {
        expect(submit.submitId).toBe(SUBMIT_ID);
        expect(submit.phase).toBe("produce");
        expect(submit.payload).toEqual(payload);
      }
    } finally {
      await client.close();
      fake.stop();
    }
  }, 30_000);
});
