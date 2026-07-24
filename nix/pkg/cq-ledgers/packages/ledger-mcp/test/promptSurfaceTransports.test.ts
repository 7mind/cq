import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn as bunSpawn, type Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const here = new URL(".", import.meta.url).pathname;
const mainPath = path.resolve(here, "..", "src", "main.ts");
const ROLE_ID = "plan-advance";
const PROMPT_BYTES = "standalone codex {{cq:literal}} and $ARGUMENTS\n";

let tmpRoot: string;
let xdgHome: string;
let surfacesRoot: string;
let codexRoot: string;

function childEnv(
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      name !== "CQ_PROMPT_ROOT" &&
      name !== "CQ_PROMPT_SURFACE" &&
      name !== "CQ_PROMPT_SURFACES_ROOT"
    ) {
      environment[name] = value;
    }
  }
  return { ...environment, XDG_STATE_HOME: xdgHome, ...overrides };
}

function decodePrompt(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected prompt result text");
  }
  return (JSON.parse(first.text) as { promptTemplate: string }).promptTemplate;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected TCP address"));
        return;
      }
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`ledger-mcp did not bind port ${String(port)}`);
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-prompt-transport-"));
  xdgHome = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-prompt-xdg-"));
  await fs.writeFile(
    path.join(tmpRoot, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(tmpRoot)}"\n`,
  );
  surfacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-prompt-surfaces-"));
  codexRoot = path.join(surfacesRoot, "codex");
  await fs.mkdir(path.join(codexRoot, "roles"), { recursive: true });
  await fs.writeFile(
    path.join(codexRoot, "catalog.json"),
    JSON.stringify([
      {
        roleId: ROLE_ID,
        roleKind: "dispatched-subagent",
        sidecar: { schemaRoleId: ROLE_ID },
      },
    ]),
  );
  await fs.writeFile(path.join(codexRoot, "roles", `${ROLE_ID}.md`), PROMPT_BYTES);
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(xdgHome, { recursive: true, force: true });
  await fs.rm(surfacesRoot, { recursive: true, force: true });
});

describe("standalone prompt-surface transports", () => {
  test("stdio fetch_prompt returns exact bytes from explicit CLI selection", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "run",
        mainPath,
        "--cwd",
        tmpRoot,
        "--prompt-surface",
        "codex",
        "--prompt-root",
        codexRoot,
      ],
      env: childEnv({}),
      stderr: "pipe",
    });
    const client = new Client({ name: "prompt-stdio-test", version: "0.0.1" }, {
      capabilities: {},
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "fetch_prompt",
        arguments: { roleId: ROLE_ID },
      });
      expect(decodePrompt(result)).toBe(PROMPT_BYTES);
    } finally {
      await client.close();
    }
  });

  test("HTTP fetch_prompt returns exact bytes from environment selection", async () => {
    const port = await freePort();
    const processHandle: Subprocess = bunSpawn({
      cmd: [
        process.execPath,
        "run",
        mainPath,
        "--cwd",
        tmpRoot,
        "--http",
        `127.0.0.1:${String(port)}`,
      ],
      env: childEnv({
        CQ_PROMPT_SURFACE: "codex",
        CQ_PROMPT_SURFACES_ROOT: surfacesRoot,
      }),
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitForPort(port);
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${String(port)}/mcp`),
      );
      const client = new Client({ name: "prompt-http-test", version: "0.0.1" }, {
        capabilities: {},
      });
      await client.connect(transport as unknown as Transport);
      try {
        const result = await client.callTool({
          name: "fetch_prompt",
          arguments: { roleId: ROLE_ID },
        });
        expect(decodePrompt(result)).toBe(PROMPT_BYTES);
      } finally {
        await client.close();
      }
    } finally {
      processHandle.kill();
      await processHandle.exited;
    }
  });
});
