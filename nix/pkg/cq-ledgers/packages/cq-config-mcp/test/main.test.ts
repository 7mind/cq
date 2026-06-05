/**
 * cq-config-mcp test (T171).
 *
 * Two layers, both reproduce-first:
 *   1. Direct: computeReviewers/computeConfig + buildServer over an in-memory
 *      transport — get_reviewers returns the resolved set for a fixture repo
 *      WITH cq.toml and { configured:false } for one WITHOUT.
 *   2. End-to-end: spawn the standalone stdio binary as a subprocess and drive
 *      it through the MCP SDK Client + StdioClientTransport (mirrors
 *      packages/ledger-mcp's main.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildServer,
  computeReviewers,
  computeConfig,
  type GetReviewersResult,
  type GetConfigResult,
  type ResolvedReviewer,
} from "../src/main.js";

const VALID_TOML = `
reviewers = ["codex", "grok", "opus"]

[aliases]
codex = "pi:gpt-5-codex"
grok = "pi:grok-4"
opus = "claude:opus-4.8"
`;

let withRoot: string;
let withoutRoot: string;

beforeAll(async () => {
  withRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cq-config-mcp-with-"));
  withoutRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cq-config-mcp-no-"));
  await fs.writeFile(path.join(withRoot, "cq.toml"), VALID_TOML, "utf8");
});

afterAll(async () => {
  await fs.rm(withRoot, { recursive: true, force: true });
  await fs.rm(withoutRoot, { recursive: true, force: true });
});

const EXPECTED_RESOLVED: ResolvedReviewer[] = [
  { harness: "pi", model: "gpt-5-codex", alias: "codex" },
  { harness: "pi", model: "grok-4", alias: "grok" },
  { harness: "claude", model: "opus-4.8", alias: "opus" },
];

describe("computeReviewers", () => {
  it("returns the resolved set for a repo WITH cq.toml", () => {
    const result = computeReviewers(withRoot);
    expect(result.configured).toBe(true);
    expect(result.reviewers).toEqual(EXPECTED_RESOLVED);
  });

  it("returns { configured:false } for a repo WITHOUT cq.toml", () => {
    expect(computeReviewers(withoutRoot)).toEqual({
      configured: false,
      reviewers: [],
    });
  });
});

describe("computeConfig", () => {
  it("returns the full parsed config for a repo WITH cq.toml", () => {
    const result = computeConfig(withRoot);
    expect(result.configured).toBe(true);
    expect(result.reviewers).toEqual(["codex", "grok", "opus"]);
    expect(result.aliases).toEqual({
      codex: { harness: "pi", model: "gpt-5-codex" },
      grok: { harness: "pi", model: "grok-4" },
      opus: { harness: "claude", model: "opus-4.8" },
    });
  });

  it("returns { configured:false } for a repo WITHOUT cq.toml", () => {
    expect(computeConfig(withoutRoot)).toEqual({
      configured: false,
      aliases: {},
      reviewers: [],
    });
  });
});

function decode<T>(result: unknown): T {
  const content = (result as { content: Array<{ type: string; text: string }> })
    .content;
  const first = content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

async function withInMemoryClient(
  repoRoot: string,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = buildServer(repoRoot);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "cq-config-mcp-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

describe("buildServer over in-memory transport", () => {
  it("lists exactly get_reviewers + get_config", async () => {
    await withInMemoryClient(withRoot, async (client) => {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual(["get_config", "get_reviewers"]);
    });
  });

  it("get_reviewers returns configured:true + the resolved set (WITH cq.toml)", async () => {
    await withInMemoryClient(withRoot, async (client) => {
      const result = decode<GetReviewersResult>(
        await client.callTool({ name: "get_reviewers", arguments: {} }),
      );
      expect(result.configured).toBe(true);
      expect(result.reviewers).toEqual(EXPECTED_RESOLVED);
    });
  });

  it("get_reviewers returns configured:false (WITHOUT cq.toml)", async () => {
    await withInMemoryClient(withoutRoot, async (client) => {
      const result = decode<GetReviewersResult>(
        await client.callTool({ name: "get_reviewers", arguments: {} }),
      );
      expect(result).toEqual({ configured: false, reviewers: [] });
    });
  });
});

/** Resolve the binary path against this package's src/main.ts. */
function resolveBinPath(): { command: string; args: string[] } {
  const here = new URL(".", import.meta.url).pathname;
  const main = path.resolve(here, "..", "src", "main.ts");
  return { command: process.execPath, args: ["run", main] };
}

async function withStdioClient(
  repoRoot: string,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const { command, args } = resolveBinPath();
  const transport = new StdioClientTransport({
    command,
    args: [...args, "--cwd", repoRoot],
    stderr: "inherit",
  });
  const client = new Client(
    { name: "cq-config-mcp-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

describe("cq-config-mcp stdio binary", () => {
  it("get_reviewers over stdio returns the resolved set (WITH cq.toml)", async () => {
    await withStdioClient(withRoot, async (client) => {
      const result = decode<GetReviewersResult>(
        await client.callTool({ name: "get_reviewers", arguments: {} }),
      );
      expect(result.configured).toBe(true);
      expect(result.reviewers).toEqual(EXPECTED_RESOLVED);
    });
  });

  it("get_reviewers over stdio returns configured:false (WITHOUT cq.toml)", async () => {
    await withStdioClient(withoutRoot, async (client) => {
      const result = decode<GetReviewersResult>(
        await client.callTool({ name: "get_reviewers", arguments: {} }),
      );
      expect(result).toEqual({ configured: false, reviewers: [] });
    });
  });

  it("get_config over stdio returns the full parsed config (WITH cq.toml)", async () => {
    await withStdioClient(withRoot, async (client) => {
      const result = decode<GetConfigResult>(
        await client.callTool({ name: "get_config", arguments: {} }),
      );
      expect(result.configured).toBe(true);
      expect(result.reviewers).toEqual(["codex", "grok", "opus"]);
    });
  });
});
