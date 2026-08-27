/**
 * T865(b): the packaged Codex signal, CONSUMED — at the process boundary.
 *
 * T863 makes the packaged Codex wrapper EXPORT `CQ_HARNESS=codex`; T864 ships
 * the `[harness.codex]` + `[harness.codex.tiers]` block in the committed
 * `cq init` config. This file proves the other half of the chain: the REAL
 * ledger-MCP stdio server, LAUNCHED with that exact environment, resolves the
 * CODEX view over MCP.
 *
 * Scope discipline (T865): the wrapper does NOT launch ledger-MCP. The focused
 * Nix evaluation (`checks.<system>.codex-harness-env`) proves the wrapper
 * PRODUCES the signal; THIS test proves the server CONSUMES it. Nothing here
 * invokes a provider — every assertion is over resolved CONFIGURATION, so G94
 * native model dispatch stays out of scope.
 *
 * FIXTURE — `fixtures/t865/codex-selection.cq.toml`, a COMMITTED copy of the
 * dispatch surface of CQ_TOML_TEMPLATE (cq-cli). This repository's live cq.toml
 * is gitignored, so a test reading it would not reproduce for anyone else or in
 * CI; cq-cli's cqTomlTemplate.test.ts pins the copy to the shipped template
 * under every selector, so it cannot drift.
 *
 * Distinct from that in-process pin, which calls `parseConfig(…, "codex")`
 * directly: this test crosses the process boundary — env -> spawned server ->
 * MCP tool payloads — exactly as the T487 block does for pi/claude.
 */

import { describe, it, expect, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createLedgerStore } from "@cq/ledger";

const FIXTURE = path.join(import.meta.dir, "fixtures", "t865", "codex-selection.cq.toml");

/**
 * The packaged prompt-root pointers, stripped from the child env for the same
 * reason main.test.ts strips them: this test process may itself run under a
 * packaged harness wrapper, whose prompt root is irrelevant to the config
 * capability under test. Everything else — including the XDG_STATE_HOME
 * override — is inherited verbatim.
 */
const PROMPT_ENV_KEYS = ["CQ_PROMPT_ROOT", "CQ_PROMPT_SURFACE", "CQ_PROMPT_SURFACES_ROOT"];

const roots: string[] = [];
let xdgStateHome: string | undefined;
let prevXdgStateHome: string | undefined;

afterAll(async () => {
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
  for (const dir of [...roots, xdgStateHome]) {
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A throwaway ledger root whose cq.toml IS the committed T865 fixture. */
async function fixtureRoot(): Promise<string> {
  if (xdgStateHome === undefined) {
    prevXdgStateHome = process.env["XDG_STATE_HOME"];
    xdgStateHome = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-t865-xdg-"));
    process.env["XDG_STATE_HOME"] = xdgStateHome;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-t865-"));
  roots.push(root);
  const fixture = await fs.readFile(FIXTURE, "utf8");
  await fs.writeFile(
    path.join(root, "cq.toml"),
    `${fixture}\n[ledger]\n  backend = "xdg"\n  projectId = "${path.basename(root)}"\n`,
    "utf8",
  );
  const { store } = await createLedgerStore(root);
  await store.dispose();
  return root;
}

/**
 * `{ ...process.env, CQ_HARNESS: <harness> }` minus undefined values (the
 * transport's env type) and the prompt-root pointers. StdioClientTransport's
 * default env is a safe allowlist carrying NEITHER CQ_HARNESS nor the
 * XDG_STATE_HOME override, so passing this env is precisely what models a
 * packaged wrapper exporting the selector into the process it launches.
 */
function childEnv(harness: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, CQ_HARNESS: harness })) {
    if (value !== undefined && !PROMPT_ENV_KEYS.includes(key)) env[key] = value;
  }
  return env;
}

/**
 * Spawn the real stdio server (`src/main.ts`, the entrypoint `cq mcp` delegates
 * to and `.mcp.json` launches) under `CQ_HARNESS=<harness>`.
 */
async function withHarness(harness: string, fn: (client: Client) => Promise<void>): Promise<void> {
  const root = await fixtureRoot();
  const main = path.resolve(import.meta.dir, "..", "src", "main.ts");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", main, "--cwd", root],
    env: childEnv(harness),
    stderr: "inherit",
  });
  const client = new Client(
    { name: "ledger-mcp-t865-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

function decode<T>(result: unknown): T {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

interface PanelEntry {
  readonly harness: string;
  readonly model: string;
  readonly provider: string | null;
  readonly alias: string;
  readonly effort: string | null;
}
interface TokenView {
  readonly harness: string;
  readonly model: string;
  readonly provider: string | null;
  readonly effort: string | null;
}
interface AgentEntry {
  readonly id: string;
  readonly status: string;
  readonly modelClass: string | null;
  readonly modelMappings: { claude?: readonly string[]; pi?: readonly string[] };
}
interface ConfigPayload {
  readonly configured: boolean;
  readonly aliases: Record<string, TokenView>;
  readonly reviewers: readonly string[];
  readonly planners: readonly string[];
  readonly tiers: Record<string, TokenView> | null;
}

async function panels(
  client: Client,
): Promise<{ reviewers: PanelEntry[]; planners: PanelEntry[] }> {
  const reviewers = decode<{ configured: boolean; reviewers: PanelEntry[] }>(
    await client.callTool({ name: "get_config", arguments: { section: "reviewers" } }),
  );
  const planners = decode<{ configured: boolean; planners: PanelEntry[] }>(
    await client.callTool({ name: "get_config", arguments: { section: "planners" } }),
  );
  expect(reviewers.configured).toBe(true);
  expect(planners.configured).toBe(true);
  return { reviewers: reviewers.reviewers, planners: planners.planners };
}

async function agentModels(client: Client): Promise<AgentEntry[]> {
  const result = decode<{ configured: boolean; agents: AgentEntry[] }>(
    await client.callTool({ name: "get_config", arguments: { section: "agent_models" } }),
  );
  expect(result.configured).toBe(true);
  return result.agents;
}

function agent(agents: readonly AgentEntry[], id: string): AgentEntry {
  const found = agents.find((a) => a.id === id);
  if (found === undefined) throw new Error(`no agent entry ${id}`);
  return found;
}

// The [harness.codex] ladder the fixture ships: the pi-EXECUTABLE openai-codex
// GPT-5.6 family. `codex` selects the block; the tokens it names are pi tokens,
// because Codex-hosted dispatches must not select Claude tokens (T861).
const SOL: PanelEntry = {
  harness: "pi",
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  alias: "codex",
  effort: "xhigh",
};

describe("ledger-mcp stdio under a packaged CQ_HARNESS=codex environment (T865)", () => {
  it("resolves the codex reviewers/planners/tiers/per-role mappings, with no ACTIVE claude token", async () => {
    await withHarness("codex", async (client) => {
      const { reviewers, planners } = await panels(client);
      expect(reviewers).toEqual([SOL]);
      expect(planners).toEqual([SOL]);

      const config = decode<ConfigPayload>(
        await client.callTool({ name: "get_config", arguments: { section: "all" } }),
      );
      expect(config.configured).toBe(true);
      // The ACTIVE panels are [harness.codex]'s, not the claude/pi ones.
      expect(config.reviewers).toEqual(["codex"]);
      expect(config.planners).toEqual(["codex"]);
      // [harness.codex.tiers] wholly replaces [harness.claude.tiers].
      expect(config.tiers).toEqual({
        frontier: {
          harness: "pi",
          model: "gpt-5.6-sol",
          provider: "openai-codex",
          effort: "xhigh",
        },
        standard: {
          harness: "pi",
          model: "gpt-5.6-terra",
          provider: "openai-codex",
          effort: "high",
        },
        fast: { harness: "pi", model: "gpt-5.6-luna", provider: "openai-codex", effort: "low" },
      });
      // Acceptance: get_config.aliases MAY retain the shared Claude definitions
      // — under this selector they are INACTIVE, not a fallback.
      expect(config.aliases["opus"]).toEqual({
        harness: "claude",
        model: "opus",
        provider: null,
        effort: null,
      });

      // Per-role mappings: the same ladder, resolved through [agent_tiers].
      const agents = await agentModels(client);
      expect(agents).toHaveLength(26);
      expect(agent(agents, "plan-advance").modelClass).toBe("frontier");
      expect(agent(agents, "plan-advance").modelMappings).toEqual({
        pi: ["openai-codex/gpt-5.6-sol:xhigh"],
      });
      expect(agent(agents, "implement-worker").modelClass).toBe("standard");
      expect(agent(agents, "implement-worker").modelMappings).toEqual({
        pi: ["openai-codex/gpt-5.6-terra:high"],
      });

      // No active opus/Claude fallback ANYWHERE on the dispatch surface: not on
      // the panels, and not on any of the 24 per-role mappings.
      for (const entry of [...reviewers, ...planners]) {
        expect(entry.harness).not.toBe("claude");
      }
      for (const a of agents) {
        expect(a.modelMappings.claude).toBeUndefined();
      }
    });
  }, 60_000);

  it("control: CQ_HARNESS=claude on the SAME fixture selects the claude (opus) view", async () => {
    await withHarness("claude", async (client) => {
      const opus: PanelEntry = {
        harness: "claude",
        model: "opus",
        provider: null,
        alias: "opus",
        effort: null,
      };
      const { reviewers, planners } = await panels(client);
      expect(reviewers).toEqual([opus]);
      expect(planners).toEqual([opus]);

      const agents = await agentModels(client);
      expect(agent(agents, "plan-advance").modelMappings).toEqual({ claude: ["opus"] });
      expect(agent(agents, "implement-worker").modelMappings).toEqual({ claude: ["sonnet"] });
    });
  }, 60_000);

  it("control: CQ_HARNESS=pi on the SAME fixture selects the pi view", async () => {
    await withHarness("pi", async (client) => {
      const { reviewers, planners } = await panels(client);
      expect(reviewers).toEqual([
        {
          harness: "pi",
          model: "grok-build",
          provider: "grok-build",
          alias: "grok",
          effort: "high",
        },
        SOL,
      ]);
      expect(planners).toEqual([SOL]);

      const agents = await agentModels(client);
      expect(agent(agents, "plan-advance").modelMappings).toEqual({
        pi: ["openai-codex/gpt-5.6-sol:xhigh"],
      });
    });
  }, 60_000);
});
