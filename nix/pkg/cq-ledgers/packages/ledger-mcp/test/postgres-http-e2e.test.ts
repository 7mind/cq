/**
 * T579 — end-to-end verification of `cq mcp --http` over a `backend =
 * 'postgres'` cq.toml, spanning TWO REAL OS subprocesses of the actual `cq`
 * entrypoint (`packages/cq-cli/src/main.ts`), proving the whole product wire
 * — not just the library — routes through `createLedgerStore` +
 * `startLedgerCoherenceWatcher` for this backend with zero product changes:
 *
 *  1. subprocess A serves `/mcp` on its own port; a real
 *     `@modelcontextprotocol/sdk` client creates a milestone + an item
 *     through it (a genuine MCP-over-HTTP session, session-id header and
 *     all);
 *  2. subprocess B — an INDEPENDENT `cq mcp --http` process, its own
 *     PostgresLedgerStore/pool/LISTEN connection, pointed at the SAME
 *     postgres tenant (same repo → same git-identity projectKey) — has a
 *     websocket client on ITS `/ws`; A's write fires a Postgres NOTIFY that
 *     B's `startPostgresCoherenceWatcher` LISTEN connection receives, and B
 *     pushes the resulting `{"type":"changed"}` frame to the socket.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, same gate as every other
 * postgres-*.test.ts): no live Postgres in this sandbox/CI by default, so
 * this file SKIPS cleanly offline and `bun run check` stays green.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const exec = promisify(execFile);
const PG_URL = process.env.CQ_TEST_PG_URL;
const dirs: string[] = [];

/** The real `cq` entrypoint (packages/cq-cli/src/main.ts), spawned as a subprocess. */
const CQ_MAIN = path.resolve(import.meta.dir, "../../cq-cli/src/main.ts");

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/** A throwaway initialised git repo (stable projectKey) with cq.toml selecting postgres. */
async function postgresRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-mcp-http-pg-"));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), `# repo ${randomUUID()}\n`, "utf8");
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  await writeFile(path.join(dir, "cq.toml"), '[ledger]\nbackend = "postgres"\nbackup = "none"\n', "utf8");
  return dir;
}

/** An ephemeral free TCP port (bind :0, read it back, close). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("expected an AddressInfo"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

interface McpHttpProc {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  stop(): void;
}

/** Spawn a real `cq mcp --cwd <dir> --http 127.0.0.1:<port>` subprocess and wait until ready. */
async function spawnMcpHttp(dir: string): Promise<McpHttpProc> {
  const port = await freePort();
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", CQ_MAIN, "mcp", "--cwd", dir, "--http", `127.0.0.1:${port}`],
    env: { ...process.env, CQ_LEDGER_PG_URL: PG_URL },
    stdout: "ignore",
    stderr: "pipe",
  });
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10_000;
  while (!buf.includes("serving Streamable HTTP")) {
    if (Date.now() > deadline) {
      reader.releaseLock();
      proc.kill();
      throw new Error(`subprocess did not report readiness within 10s; stderr so far: ${buf}`);
    }
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(`subprocess stderr closed before reporting readiness; stderr so far: ${buf}`);
    }
    buf += decoder.decode(value);
  }
  reader.releaseLock();
  return {
    proc,
    port,
    stop: () => proc.kill(),
  };
}

function decode<T>(result: unknown): T {
  const content = (result as { content: Array<{ type: string; text: string }>; isError?: boolean }).content;
  const first = content[0];
  if (first === undefined || first.type !== "text") throw new Error("expected single text content block");
  return JSON.parse(first.text) as T;
}

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("cq mcp --http over backend='postgres' (T579)", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  describe("cq mcp --http over backend='postgres' (T579)", () => {
    it(
      "a create_item over process A's --http session fires a changedFrame on process B's /ws",
      async () => {
        const dir = await postgresRepo();
        const a = await spawnMcpHttp(dir);
        const b = await spawnMcpHttp(dir);
        try {
          const changed: string[] = [];
          const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws`);
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve());
            ws.addEventListener("error", () => reject(new Error("process B ws failed to open")));
          });
          ws.addEventListener("message", (ev) => changed.push(String(ev.data)));

          const transport = new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${a.port}/mcp`),
          );
          const client = new Client({ name: "t579-e2e", version: "0.0.1" }, { capabilities: {} });
          await client.connect(transport as unknown as Transport);
          try {
            const msId = `M${Math.floor(Math.random() * 1_000_000) + 10_000}`;
            const ms = decode<{ milestone: { id: string } }>(
              await client.callTool({
                name: "create_milestone",
                arguments: { id: msId, title: "T579 postgres http e2e" },
              }),
            );
            expect(ms.milestone.id).toBe(msId);

            const created = decode<{ item: { id: string } }>(
              await client.callTool({
                name: "create_item",
                arguments: {
                  ledger_id: "tasks",
                  milestone_id: msId,
                  status: "planned",
                  fields: { headline: "e2e task" },
                },
              }),
            );
            expect(created.item.id).toMatch(/^T\d+$/);
          } finally {
            await client.close();
          }

          const start = Date.now();
          while (changed.length === 0 && Date.now() - start < 5_000) {
            await new Promise((r) => setTimeout(r, 20));
          }
          ws.close();

          expect(changed.length).toBeGreaterThan(0);
          expect(JSON.parse(changed[0] ?? "{}")).toEqual({ type: "changed" });
        } finally {
          a.stop();
          b.stop();
        }
      },
      15_000,
    );
  });
}
