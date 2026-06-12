/**
 * Backend capability gating over buildServer (T357 / G43).
 *
 * buildServer historically gated read_log + config + promptCatalog on
 * `store instanceof FsLedgerStore`. T357 GENERALISED config/promptCatalog;
 * T408 GENERALISES read_log too:
 *
 *  - read_log is now BACKEND-AWARE — the git-object backend serves the SAME
 *    `logs/<rel>` confinement + 4 MiB cap from the orphan ref tip, so against a
 *    GitObjectLedgerBackend it IS wired (NOT the not-implemented error);
 *  - config (get_config) and promptCatalog (fetch_prompt) are ROOT-BOUND and
 *    BACKEND-INDEPENDENT — both stores expose `rootDir` — so they ARE available
 *    for the git-object backend (NOT the not-implemented error).
 *
 * Drives buildServer over an in-memory transport against a GitObjectLedgerBackend
 * rooted at a throwaway git repo. The companion FS-backend assertions live in
 * the existing main.test.ts suite (regression guard for the fs path).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GitObjectLedgerBackend, GitPlumbing } from "@cq/ledger";
import { buildServer } from "../src/main.js";

const exec = promisify(execFile);
const REF = "refs/heads/cq-ledger";
const dirs: string[] = [];

/**
 * Seed a `logs/<rel>` blob onto the orphan ref tip (mirrors how the FS read-log
 * test writes a file under <root>/docs/logs). Advances the ref by one commit
 * carrying the single log blob, so read_log finds it via lsTree + catFile.
 */
async function seedLog(dir: string, rel: string, content: string): Promise<void> {
  const plumbing = GitPlumbing.withCwd(dir, path.join(dir, ".git"));
  const blob = await plumbing.hashObject(content);
  const tree = await plumbing.writeTree([
    { mode: "100644", sha: blob, path: `logs/${rel}` },
  ]);
  const parent = await plumbing.readRef(REF);
  const commit = await plumbing.commitTree(tree, parent, "ledger: seed log");
  await plumbing.updateRef(REF, commit, parent);
}

async function gitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "capgate-"));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await fs.writeFile(path.join(dir, "src.txt"), "x\n");
  await exec("git", ["add", "src.txt"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  // A cq.toml so get_config has a config root to read (configured:true).
  await fs.writeFile(path.join(dir, "cq.toml"), 'reviewers = []\nplanners = []\n', "utf8");
  return dir;
}

/** Connect an in-memory MCP client to buildServer over the given git-object store. */
async function withGitBackendClient(
  fn: (client: Client, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await gitRepo();
  const store = new GitObjectLedgerBackend({ repoRoot: dir });
  await store.init();
  const server = buildServer(store, path.basename(dir));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "capgate-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    await fn(client, dir);
  } finally {
    await client.close();
    await store.dispose();
  }
}

/** Extract concatenated text content from a callTool result. */
function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("buildServer capability gating — git-object backend", () => {
  it("read_log IS wired and returns seeded content byte-identical (T408)", async () => {
    await withGitBackendClient(async (client, dir) => {
      await seedLog(dir, "raw/x.jsonl", '{"a":1}\n{"b":2}\n');
      const result = (await client.callTool({
        name: "read_log",
        arguments: { path: "raw/x.jsonl" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(result.isError ?? false).toBe(false);
      const parsed = JSON.parse(textOf(result)) as {
        path: string;
        content: string;
        truncated?: boolean;
      };
      expect(parsed.content).toBe('{"a":1}\n{"b":2}\n');
      expect(parsed.truncated).toBeUndefined();
    });
  });

  it("read_log rejects a path escaping logs/ (../tasks.md)", async () => {
    await withGitBackendClient(async (client) => {
      const result = (await client.callTool({
        name: "read_log",
        arguments: { path: "../tasks.md" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("escapes .cq/logs");
    });
  });

  it("read_log returns a clean not-found for a missing path", async () => {
    await withGitBackendClient(async (client) => {
      const result = (await client.callTool({
        name: "read_log",
        arguments: { path: "nonexistent.jsonl" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).not.toContain("escapes .cq/logs");
      expect(text).toContain("no such file");
    });
  });

  it("get_config IS available (config capability is backend-independent)", async () => {
    await withGitBackendClient(async (client) => {
      const result = (await client.callTool({
        name: "get_config",
        arguments: {},
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      // The capability is WIRED for the git backend: get_config runs loadConfig
      // and returns a structured payload (with a `configured` boolean) — NOT the
      // ConfigNotImplementedError an unwired capability throws.
      expect(result.isError ?? false).toBe(false);
      const text = textOf(result);
      expect(text).not.toContain("not implemented");
      const parsed = JSON.parse(text) as { configured: boolean; reviewers: unknown[] };
      expect(typeof parsed.configured).toBe("boolean");
      expect(Array.isArray(parsed.reviewers)).toBe(true);
    });
  });

  it("fetch_prompt IS available (prompt-catalog capability is backend-independent)", async () => {
    await withGitBackendClient(async (client) => {
      // An unknown role reaches the WIRED capability and yields UnknownRoleError,
      // proving the capability is present — NOT the not-implemented error.
      const result = (await client.callTool({
        name: "fetch_prompt",
        arguments: { roleId: "definitely-not-a-real-role" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).not.toContain("not implemented for this store");
      expect(text).toContain("unknown role");
    });
  });
});
