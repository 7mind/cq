#!/usr/bin/env -S bun run
/**
 * cq-config-mcp — standalone MCP server exposing cq's reviewer configuration.
 *
 * Thin stdio MCP server over `@cq/config`'s parser (T170). It exposes the
 * resolved reviewer set from a repo's `cq.toml` so the plan/implement
 * orchestrators can pick reviewers without reading the file directly.
 *
 * Mirrors packages/ledger-mcp's server bootstrap: same MCP SDK, same `--cwd`
 * convention (defaulting to the process CWD) so a single global install serves
 * the per-repo `cq.toml` — the MCP client spawns this server with the repo as
 * its working directory.
 *
 * Tools:
 *   - get_reviewers — the RESOLVED reviewer set as
 *       { configured: boolean, reviewers: [{ harness, model, alias }] }.
 *     `configured:false` (no cq.toml / empty reviewers) signals the
 *     orchestrators to fall back to today's single native Claude reviewer.
 *   - get_config — the full parsed config (aliases + raw reviewer alias names)
 *       as { configured: boolean, aliases, reviewers }, for diagnostics.
 *
 * CLI:
 *   cq-config-mcp                 # stdio; config root = $CQ_CONFIG_ROOT or CWD
 *   cq-config-mcp --cwd <path>    # stdio; explicit root (rel→resolved vs CWD)
 *
 * Config root precedence: --cwd > $CQ_CONFIG_ROOT > process CWD.
 *
 * Output discipline (stdio mode). Stdout is reserved for MCP protocol traffic
 * only; all logs go to stderr.
 */

import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadConfig,
  resolveReviewers,
  type CqConfig,
  type Harness,
} from "@cq/config";

const SERVER_INFO = { name: "cq-config-mcp", version: "0.0.1" } as const;

/** Env var that overrides the config root when `--cwd` is absent. */
export const CONFIG_ROOT_ENV = "CQ_CONFIG_ROOT";

/**
 * A single resolved reviewer, as returned by `get_reviewers`: the parsed
 * harness + model PLUS the `alias` name it was declared under in `cq.toml`
 * (so the orchestrators can echo a human-meaningful label).
 */
export interface ResolvedReviewer {
  readonly harness: Harness;
  readonly model: string;
  readonly alias: string;
}

/**
 * The `get_reviewers` payload. `configured` is true only when a `cq.toml`
 * exists AND declares a non-empty `reviewers` list; otherwise the caller falls
 * back to a single native Claude reviewer.
 */
export interface GetReviewersResult {
  readonly configured: boolean;
  readonly reviewers: readonly ResolvedReviewer[];
}

/** The `get_config` payload: the full parsed config (or `configured:false`). */
export interface GetConfigResult {
  readonly configured: boolean;
  readonly aliases: Record<string, { harness: Harness; model: string }>;
  readonly reviewers: readonly string[];
}

export interface ParsedArgs {
  cwd: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let cwd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") {
      i += 1;
      const v = argv[i];
      if (v === undefined) {
        throw new Error("cq-config-mcp: --cwd requires a value");
      }
      cwd = v;
    } else if (a !== undefined && a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
    }
  }
  // Config root, in priority order: --cwd, then $CQ_CONFIG_ROOT, else the
  // process working directory. A relative value resolves against the CWD.
  // Defaulting to the CWD lets one global install serve per-repo cq.toml —
  // the MCP client spawns this server with the repo as its CWD.
  const fromArg = cwd !== undefined && cwd !== "" ? cwd : undefined;
  const fromEnv = process.env[CONFIG_ROOT_ENV];
  const chosen =
    fromArg ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  const resolved = chosen !== undefined ? path.resolve(chosen) : process.cwd();
  return { cwd: resolved };
}

/**
 * Compute the `get_reviewers` payload for `repoRoot`.
 *
 * Loads `cq.toml` (null when absent → `configured:false`), then resolves each
 * `reviewers` alias through `[aliases]` into a `{ harness, model, alias }`.
 * An empty resolved set also yields `configured:false` — the orchestrators
 * then use the single native Claude reviewer.
 */
export function computeReviewers(repoRoot: string): GetReviewersResult {
  const config = loadConfig(repoRoot);
  if (config === null) {
    return { configured: false, reviewers: [] };
  }
  const tokens = resolveReviewers(config);
  const reviewers: ResolvedReviewer[] = tokens.map((token, i) => ({
    harness: token.harness,
    model: token.model,
    // resolveReviewers preserves order, so the alias is config.reviewers[i].
    alias: config.reviewers[i] as string,
  }));
  return { configured: reviewers.length > 0, reviewers };
}

/** Compute the `get_config` payload for `repoRoot`. */
export function computeConfig(repoRoot: string): GetConfigResult {
  const config = loadConfig(repoRoot);
  if (config === null) {
    return { configured: false, aliases: {}, reviewers: [] };
  }
  return projectConfig(config);
}

function projectConfig(config: CqConfig): GetConfigResult {
  const aliases: Record<string, { harness: Harness; model: string }> = {};
  for (const [name, token] of Object.entries(config.aliases)) {
    aliases[name] = { harness: token.harness, model: token.model };
  }
  return {
    configured: config.reviewers.length > 0,
    aliases,
    reviewers: config.reviewers,
  };
}

function jsonResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/**
 * Server-level usage guidance surfaced on `initialize` (the MCP `instructions`
 * field), telling a client when/how to use this server.
 */
const SERVER_INSTRUCTIONS = [
  "cq-config: exposes the resolved reviewer set from a repo's cq.toml.",
  "",
  "Call get_reviewers to learn which reviewers cq is configured to run. The",
  "result is { configured, reviewers: [{ harness, model, alias }] }.",
  "When configured=false (no cq.toml, or an empty reviewers list), fall back to",
  "the single native Claude reviewer. get_config returns the full parsed config",
  "(aliases + raw reviewer alias names) for diagnostics.",
].join("\n");

/**
 * Build a fresh McpServer bound to `repoRoot`. Each tool call re-reads
 * `cq.toml` from disk so the server reflects edits without a restart.
 */
export function buildServer(repoRoot: string): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  });

  server.registerTool(
    "get_reviewers",
    {
      description:
        "Resolve the reviewer set from the repo's cq.toml. Returns " +
        "{ configured, reviewers: [{ harness, model, alias }] }. " +
        "configured=false (no cq.toml or empty list) => use the single native " +
        "Claude reviewer.",
      inputSchema: {},
    },
    () => jsonResult(computeReviewers(repoRoot)),
  );

  server.registerTool(
    "get_config",
    {
      description:
        "Return the full parsed cq.toml: { configured, aliases, reviewers } " +
        "where reviewers is the raw list of alias names. configured=false " +
        "when no cq.toml is present.",
      inputSchema: {},
    },
    () => jsonResult(computeConfig(repoRoot)),
  );

  return server;
}

export async function main(argv: readonly string[]): Promise<void> {
  const { cwd } = parseArgs(argv);
  const server = buildServer(cwd);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`cq-config-mcp: serving stdio MCP on cwd=${cwd}\n`);
}

// Only run main() when executed directly (not when imported by tests).
const meta = import.meta as unknown as { main?: boolean };
if (meta.main === true) {
  void main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cq-config-mcp: fatal: ${msg}\n`);
    process.exit(1);
  });
}
