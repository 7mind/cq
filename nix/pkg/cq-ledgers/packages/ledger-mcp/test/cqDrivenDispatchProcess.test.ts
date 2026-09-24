/**
 * G224 end-to-end: a production stdio `cq mcp` drives one dispatch itself.
 *
 * start_dispatch resolves plan-advance's model from cq.toml, prepares it,
 * and launches the Claude print bridge against a stand-in `claude` executable
 * (fixtures/fakeClaudePrintChild.ts). That child starts its OWN ledger server
 * from the bridge's --mcp-config - a second production `cq mcp`, profile-
 * narrowed and holding only the environment-bound result capability -
 * materializes its input and stores its result. The parent's bounded waiting
 * `fetch_dispatch_result` then returns the consumed output - once, as every
 * dispatch body is returned. No capability ever reaches the parent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { implementReviewerSidecar, planAdvanceSidecar, serializePromptSurfaceManifest } from "@cq/config";

const TIMEOUT_MS = 60_000;
const ROLE_ID = "plan-advance";
const OUTPUT = { mode: "default", action: "noop" } as const;
const ROLE_BYTES = [
  "---",
  `name: ${ROLE_ID}`,
  "description: fixture planner",
  `# Claude host capabilities for ${ROLE_ID}`,
  "disallowedTools: Write, Edit, MultiEdit, NotebookEdit, Bash",
  "",
  "---",
  "",
  "Plan the goal.",
  "",
].join("\n");
const PI_ROLE_BYTES = [
  "---",
  `name: ${ROLE_ID}`,
  "description: fixture planner",
  `# Pi host capabilities for ${ROLE_ID}`,
  "disallowedTools: write, edit, bash, dispatch_agent",
  "",
  "---",
  "",
  "Plan the goal. Return one fenced json block.",
  "",
].join("\n");

let scratch: string;
let projectRoot: string;
let surfacesRoot: string;
let serverEntry: string;
let fakeClaude: string;
let ledgerCommand: string;
let argvCapture: string;
let codexRoleCommand: string;
let codexRequestCapture: string;
let fakePi: string;
let piArgvCapture: string;
let piEnvCapture: string;

const REVIEWER_ROLE_ID = "implement-reviewer";
const PI_REVIEWER_BYTES = [
  "---",
  `name: ${REVIEWER_ROLE_ID}`,
  "description: fixture reviewer",
  `# Pi host capabilities for ${REVIEWER_ROLE_ID}`,
  "disallowedTools: write, edit, dispatch_agent",
  "",
  "---",
  "",
  "Review the task; store the verdict and reply with the handle.",
  "",
].join("\n");
const REVIEWER_INPUT = {
  taskId: "T1696",
  acceptance: "The Pi reviewer stores its own verdict.",
  branch: "implement/T1696",
  baseCommit: "e65ce042ab4093398372f886e471e57f8f3efdae",
  workerResult: {
    resultCommit: "e65ce042ab4093398372f886e471e57f8f3efdae",
    checkSummary: "REAL_CHECK_EXIT=0",
    filesTouched: [],
  },
  round: 1,
  priorCriticism: [],
} as const;
const REVIEWER_OUTPUT = {
  taskId: "T1696",
  verdict: "disapprove",
  criticism: ["Recorded fixture disapproval."],
  questions: [],
  defects: [],
  rationale: "The fixture intentionally stores a non-exhaustion disapproval.",
  gateReRan: false,
  resultCommitVerified: false,
  gateReRanReason: "transport-fixture-does-not-run-gate",
  resultCommitEvidence: { status: "unresolvable", reason: "worktree-unresolvable", resultCommit: null, branchTip: null },
  baseAncestry: {
    status: "unresolvable",
    reason: "result-commit-missing",
    baseCommit: null,
    resultCommit: null,
    mergeBase: null,
  },
} as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function writeExecutable(file: string, body: string): Promise<void> {
  await fs.writeFile(file, body, { mode: 0o755 });
}

beforeAll(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "cq-g224-e2e-"));
  projectRoot = path.join(scratch, "project");
  surfacesRoot = path.join(scratch, "prompt-surfaces");
  await fs.mkdir(projectRoot, { recursive: true });
  const roles = [
    { roleId: ROLE_ID, version: planAdvanceSidecar.version },
    { roleId: REVIEWER_ROLE_ID, version: implementReviewerSidecar.version },
  ] as const;
  const catalogJson = JSON.stringify(
    roles.map(({ roleId }) => ({ roleId, roleKind: "dispatched-subagent", sidecar: { schemaRoleId: roleId } })),
  );
  for (const surface of ["claude", "codex", "pi"] as const) {
    const root = path.join(surfacesRoot, surface);
    await fs.mkdir(path.join(root, "roles"), { recursive: true });
    await fs.mkdir(path.join(root, "schemas"), { recursive: true });
    await fs.writeFile(path.join(root, "catalog.json"), catalogJson);
    const entries = [];
    for (const { roleId, version } of roles) {
      const roleBytes =
        roleId === REVIEWER_ROLE_ID
          ? PI_REVIEWER_BYTES
          : surface === "pi"
            ? PI_ROLE_BYTES
            : ROLE_BYTES;
      const schemaJson = JSON.stringify({
        id: roleId,
        version,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      });
      await fs.writeFile(path.join(root, "schemas", `${roleId}.json`), schemaJson);
      await fs.writeFile(path.join(root, "roles", `${roleId}.md`), roleBytes);
      entries.push({ roleId, version, sha256: sha256(roleBytes), schemaSha256: sha256(schemaJson) });
    }
    await fs.writeFile(
      path.join(root, "surface.json"),
      serializePromptSurfaceManifest(surface, sha256(catalogJson), entries),
    );
  }
  await fs.writeFile(
    path.join(projectRoot, "cq.toml"),
    [
      "[ledger]",
      '  backend = "xdg"',
      `  projectId = "${path.basename(scratch)}"`,
      "",
      "[aliases]",
      '  sonnet = "claude:sonnet"',
      '  codexsol = "codex:gpt-5.6-sol:high"',
      '  grok = "pi:xai/grok-4.6:high"',
      '  luna = "pi:openai-codex/gpt-6-luna"',
      "",
      "[agent_tiers]",
      `  ${ROLE_ID} = "frontier"`,
      "",
      "[harness.claude]",
      '  planners = ["codexsol", "grok"]',
      '  reviewers = ["luna"]',
      "[harness.claude.tiers]",
      '  frontier = "sonnet"',
      "",
    ].join("\n"),
  );

  const main = path.resolve(import.meta.dir, "..", "src", "main.ts");
  const buildCommit = new TextDecoder()
    .decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir }).stdout)
    .trim();
  serverEntry = path.join(scratch, "serverEntry.ts");
  await fs.writeFile(
    serverEntry,
    [
      `import { main } from ${JSON.stringify(main)};`,
      `void main(process.argv.slice(2), { trustedSourceWorkspaceBuildCommit: ${JSON.stringify(buildCommit)} }).catch((err) => {`,
      '  process.stderr.write(`ledger-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\\n`);',
      "  process.exit(1);",
      "});",
    ].join("\n"),
  );
  ledgerCommand = path.join(scratch, "cq");
  await writeExecutable(
    ledgerCommand,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(serverEntry)} "$@"\n`,
  );
  fakeClaude = path.join(scratch, "claude");
  await writeExecutable(
    fakeClaude,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(
      path.join(import.meta.dir, "fixtures", "fakeClaudePrintChild.ts"),
    )} "$@"\n`,
  );
  argvCapture = path.join(scratch, "claude-argv.json");
  codexRoleCommand = path.join(scratch, "cq-codex-role");
  await writeExecutable(
    codexRoleCommand,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(
      path.join(import.meta.dir, "fixtures", "fakeCodexRoleLauncher.ts"),
    )} "$@"\n`,
  );
  codexRequestCapture = path.join(scratch, "codex-request.json");
  fakePi = path.join(scratch, "pi");
  await writeExecutable(
    fakePi,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(
      path.join(import.meta.dir, "fixtures", "fakePiPrintChild.ts"),
    )} "$@"\n`,
  );
  piArgvCapture = path.join(scratch, "pi-argv.json");
  piEnvCapture = path.join(scratch, "pi-env.json");
});

afterAll(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

function serverEnvironment(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("CQ_PROMPT") && key !== "CQ_HARNESS") env[key] = value;
  }
  return {
    ...env,
    CQ_PROMPT_SURFACES_ROOT: surfacesRoot,
    CQ_PROMPT_SURFACE: "claude",
    CQ_LEDGER_COMMAND: ledgerCommand,
    CQ_CLAUDE_EXECUTABLE: fakeClaude,
    CQ_FAKE_CLAUDE_ARGV_CAPTURE: argvCapture,
    CQ_FAKE_CLAUDE_OUTPUT: JSON.stringify(OUTPUT),
    CQ_CODEX_ROLE_COMMAND: codexRoleCommand,
    CQ_FAKE_CODEX_REQUEST_CAPTURE: codexRequestCapture,
    CQ_FAKE_CODEX_OUTPUT: JSON.stringify(OUTPUT),
    CQ_PI_EXECUTABLE: fakePi,
    CQ_FAKE_PI_ARGV_CAPTURE: piArgvCapture,
    CQ_FAKE_PI_OUTPUT: JSON.stringify(OUTPUT),
    CQ_FAKE_PI_ENV_CAPTURE: piEnvCapture,
    ...overrides,
  };
}

function decode<T>(result: unknown): T {
  const decoded = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const first = decoded.content[0];
  if (first === undefined || first.type !== "text") throw new Error("expected one text block");
  if (decoded.isError === true) throw new Error(first.text);
  return JSON.parse(first.text) as T;
}

const PLAN_INPUT = {
  goalId: "G224",
  activeClaim: { goalId: "G224", claimId: "claim_G224_1", generation: 1, purpose: "initial" },
  currentDraftIdentity: null,
  latestReviewId: null,
} as const;

async function withParent(
  fn: (parent: Client) => Promise<void>,
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", serverEntry, "--cwd", projectRoot],
    env: serverEnvironment(environment),
    stderr: "inherit",
  });
  const parent = new Client({ name: "g224-parent", version: "0.0.1" }, { capabilities: {} });
  await parent.connect(transport);
  try {
    await fn(parent);
  } finally {
    await parent.close();
  }
}

const NONTERMINAL_STATES = new Set(["prepared", "result-stored", "gate-pending"]);

/** The parent's loop: bounded waiting fetches until the dispatch is terminal. */
async function awaitTerminal(
  parent: Client,
  handle: { attestationId: string; generation: number },
): Promise<{ state: string; output?: unknown; reason?: string }> {
  let fetched: { state: string; output?: unknown; reason?: string } = { state: "prepared" };
  for (let attempt = 0; attempt < 10 && NONTERMINAL_STATES.has(fetched.state); attempt += 1) {
    fetched = decode(
      await parent.callTool({ name: "fetch_dispatch_result", arguments: { ...handle, waitMs: 5_000 } }),
    );
  }
  return fetched;
}

describe("G224 CQ-driven dispatch through production processes", () => {
  test("a Claude parent dispatches a Pi-configured role; the server settles for the Pi child", async () => {
    await withParent(async (parent) => {
      const started = decode<{
        accepted: boolean;
        handle: { attestationId: string; generation: number };
        route: { activeHarness: string; targetHarness: string; model: string };
      }>(
        await parent.callTool({
          name: "start_dispatch",
          arguments: {
            roleId: ROLE_ID,
            input: PLAN_INPUT,
            model: "pi:xai/grok-4.6:high",
            idempotencyKey: "G224-e2e-pi",
            timeoutMs: 120_000,
          },
        }),
      );
      expect(started.route).toEqual({
        activeHarness: "claude",
        targetHarness: "pi",
        model: "pi:xai/grok-4.6:high",
      });
      expect(await awaitTerminal(parent, started.handle)).toMatchObject({ state: "consumed", output: OUTPUT });
      const argv = JSON.parse(await fs.readFile(piArgvCapture, "utf8")) as string[];
      const flag = (name: string): string => argv[argv.indexOf(name) + 1]!;
      expect(argv.slice(0, 4)).toEqual(["-p", "--mode", "json", "--no-session"]);
      expect(flag("--provider")).toBe("xai");
      expect(flag("--model")).toBe("grok-4.6");
      expect(flag("--thinking")).toBe("high");
      expect(flag("--tools")).toBe("read,grep,find");
      expect(JSON.parse(argv.at(-1)!)).toEqual(PLAN_INPUT);
      expect(argv.join(" ")).not.toContain("cq_result_");
      expect(argv.join(" ")).not.toContain("cq_input_");
    });
  }, TIMEOUT_MS);

  test("a Pi-configured implementation reviewer stores its own result through the CQ Pi extension (D544)", async () => {
    await withParent(async (parent) => {
      const started = decode<{
        handle: { attestationId: string; generation: number };
        route: { targetHarness: string; model: string };
      }>(
        await parent.callTool({
          name: "start_dispatch",
          arguments: {
            roleId: REVIEWER_ROLE_ID,
            input: { ...REVIEWER_INPUT, worktreePath: projectRoot },
            model: "pi:openai-codex/gpt-6-luna",
            idempotencyKey: "G224-e2e-pi-reviewer",
            timeoutMs: 600_000,
          },
        }),
      );
      expect(started.route).toMatchObject({ targetHarness: "pi", model: "pi:openai-codex/gpt-6-luna" });
      expect(await awaitTerminal(parent, started.handle)).toMatchObject({
        state: "consumed",
        output: { verdict: "disapprove", taskId: "T1696" },
      });
      const argv = JSON.parse(await fs.readFile(piArgvCapture, "utf8")) as string[];
      const flag = (name: string): string => argv[argv.indexOf(name) + 1]!;
      expect(flag("--tools").split(",")).toEqual(["read", "grep", "find", "bash", "fetch_dispatch_input", "store_result"]);
      expect(flag("-e")).toBe(path.resolve(import.meta.dir, "..", "src", "piChildLedgerExtension.ts"));
      expect(Object.keys(JSON.parse(argv.at(-1)!) as object).sort()).toEqual([
        "attestationId",
        "generation",
        "inputCapability",
      ]);
      expect(argv.join(" ")).not.toContain("cq_result_");
      const child = JSON.parse(await fs.readFile(piEnvCapture, "utf8")) as {
        environment: Record<string, string>;
        tools: string[];
      };
      expect(child.tools).toEqual(["fetch_dispatch_input", "store_result"]);
      expect(child.environment).not.toHaveProperty("CQ_PI_CHILD_LEDGER_CONFIG");
      expect(JSON.stringify(child.environment)).not.toContain("cq_result_");
    }, { CQ_FAKE_PI_OUTPUT: JSON.stringify(REVIEWER_OUTPUT) });
  }, TIMEOUT_MS);

  test("a child-stored Pi reviewer whose store_result aborts keeps its authoritative abort reason (D546)", async () => {
    await withParent(async (parent) => {
      const started = decode<{ handle: { attestationId: string; generation: number } }>(
        await parent.callTool({
          name: "start_dispatch",
          arguments: {
            roleId: REVIEWER_ROLE_ID,
            input: { ...REVIEWER_INPUT, worktreePath: projectRoot },
            model: "pi:openai-codex/gpt-6-luna",
            idempotencyKey: "G224-e2e-pi-reviewer-invalid",
            timeoutMs: 600_000,
          },
        }),
      );
      expect(await awaitTerminal(parent, started.handle)).toMatchObject({
        state: "aborted",
        reason: "invalid-output",
      });
    }, { CQ_FAKE_PI_OUTPUT: JSON.stringify({ verdict: "not-a-verdict" }) });
  }, TIMEOUT_MS);

  test("a Claude parent dispatches a Codex-configured role through cq-codex-role", async () => {
    await withParent(async (parent) => {
      const started = decode<{
        accepted: boolean;
        handle: { attestationId: string; generation: number };
        route: { activeHarness: string; targetHarness: string; model: string };
      }>(
        await parent.callTool({
          name: "start_dispatch",
          arguments: {
            roleId: ROLE_ID,
            input: PLAN_INPUT,
            model: "codex:gpt-5.6-sol:high",
            idempotencyKey: "G224-e2e-codex",
            timeoutMs: 120_000,
          },
        }),
      );
      expect(started.route).toEqual({
        activeHarness: "claude",
        targetHarness: "codex",
        model: "codex:gpt-5.6-sol:high",
      });
      expect(await awaitTerminal(parent, started.handle)).toMatchObject({ state: "consumed", output: OUTPUT });
      const captured = JSON.parse(await fs.readFile(codexRequestCapture, "utf8")) as {
        request: Record<string, unknown>;
        correlationId: string;
        promptRoot: string;
      };
      expect(captured.request).toMatchObject({
        roleId: ROLE_ID,
        handle: started.handle,
        effectTargetRef: "goals:G224",
        ledgerCwd: projectRoot,
        cwd: projectRoot,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        sandboxMode: "read-only",
      });
      expect(captured.correlationId).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(captured.promptRoot).toBe(path.join(surfacesRoot, "codex"));
    });
  }, TIMEOUT_MS);

  test("a Codex child whose store_result aborts keeps its authoritative abort reason", async () => {
    await withParent(async (parent) => {
      const started = decode<{ handle: { attestationId: string; generation: number } }>(
        await parent.callTool({
          name: "start_dispatch",
          arguments: {
            roleId: ROLE_ID,
            input: PLAN_INPUT,
            model: "codex:gpt-5.6-sol:high",
            idempotencyKey: "G224-e2e-codex-invalid",
            timeoutMs: 120_000,
          },
        }),
      );
      expect(await awaitTerminal(parent, started.handle)).toMatchObject({
        state: "aborted",
        reason: "invalid-output",
      });
    }, { CQ_FAKE_CODEX_OUTPUT: JSON.stringify({ mode: "not-a-plan-mode" }) });
  }, TIMEOUT_MS);

  test("start_dispatch launches the print bridge and one waiting fetch returns the consumed output", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", serverEntry, "--cwd", projectRoot],
      env: serverEnvironment(),
      stderr: "inherit",
    });
    const parent = new Client({ name: "g224-parent", version: "0.0.1" }, { capabilities: {} });
    await parent.connect(transport);
    try {
      const started = decode<{
        accepted: boolean;
        handle: { attestationId: string; generation: number };
        route: { activeHarness: string; targetHarness: string; model: string };
      }>(
        await parent.callTool({
          name: "start_dispatch",
          arguments: {
            roleId: ROLE_ID,
            input: {
              goalId: "G224",
              activeClaim: { goalId: "G224", claimId: "claim_G224_1", generation: 1, purpose: "initial" },
              currentDraftIdentity: null,
              latestReviewId: null,
            },
            idempotencyKey: "G224-e2e",
            timeoutMs: 120_000,
          },
        }),
      );
      expect(started.accepted).toBe(true);
      expect(started.route).toEqual({ activeHarness: "claude", targetHarness: "claude", model: "claude:sonnet" });
      expect(JSON.stringify(started)).not.toContain("cq_result_");
      expect(JSON.stringify(started)).not.toContain("cq_input_");

      expect(await awaitTerminal(parent, started.handle)).toMatchObject({ state: "consumed", output: OUTPUT });
      expect(
        decode<{ state: string }>(
          await parent.callTool({ name: "fetch_dispatch_result", arguments: started.handle }),
        ).state,
      ).toBe("output-already-materialized");

      const argv = JSON.parse(await fs.readFile(argvCapture, "utf8")) as string[];
      const flag = (name: string): string => argv[argv.indexOf(name) + 1]!;
      expect(flag("--tools")).toBe("Read,Glob,Grep");
      expect(flag("--model")).toBe("sonnet");
      expect(Object.keys(JSON.parse(flag("-p")) as object).sort()).toEqual([
        "attestationId",
        "generation",
        "inputCapability",
      ]);
      const mcp = JSON.parse(flag("--mcp-config")) as {
        mcpServers: { ledger: { command: string; args: string[] } };
      };
      expect(mcp.mcpServers.ledger.command).toBe(ledgerCommand);
      expect(mcp.mcpServers.ledger.args.slice(-2)).toEqual(["--tool-profile", ROLE_ID]);
    } finally {
      await parent.close();
    }
  }, TIMEOUT_MS);
});
