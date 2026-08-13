import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export {};

const capturePath = process.env["CQ_T2081_REVIEW_CAPTURE"];
const expectedMode = process.env["CQ_T2081_REVIEW_MODE"];
const expectedWorktree = process.env["CQ_T2081_REVIEW_WORKTREE"];
const expectedLedgerRoot = process.env["CQ_T2081_REVIEW_LEDGER_ROOT"];
if (
  capturePath === undefined ||
  (expectedMode !== "sandboxed" && expectedMode !== "non-sandboxed") ||
  expectedWorktree === undefined ||
  expectedLedgerRoot === undefined
) {
  throw new Error("review capture, mode, worktree, and repository boundary are required");
}

const argv = process.argv.slice(2);
if (argv[0] !== "exec") throw new Error("reviewer recording executable expected codex exec");
const cwdIndex = argv.indexOf("-C");
const sandboxIndex = argv.indexOf("-s");
const codexCwd = cwdIndex < 0 ? undefined : argv[cwdIndex + 1];
const sandboxMode = sandboxIndex < 0 ? undefined : argv[sandboxIndex + 1];
const expectedSandboxMode = expectedMode === "sandboxed" ? "read-only" : "workspace-write";
const mcpOverride = argv.find((argument) => argument.startsWith("mcp_servers.ledger="));
if (
  codexCwd !== expectedWorktree ||
  sandboxMode !== expectedSandboxMode ||
  mcpOverride === undefined
) {
  throw new Error("Codex reviewer boundary selected the wrong worktree or sandbox mode");
}
const commandMatch = /(?:^|[,{}])command=("(?:\\.|[^"\\])*")/.exec(mcpOverride);
const argsMatch = /(?:^|[,{}])args=(\[[^\]]*\])/.exec(mcpOverride);
if (commandMatch?.[1] === undefined || argsMatch?.[1] === undefined) {
  throw new Error("Codex reviewer boundary emitted an unreadable ledger MCP configuration");
}
const ledgerCommand = JSON.parse(commandMatch[1]) as string;
const ledgerArgs = JSON.parse(argsMatch[1]) as string[];
const ledgerCwdIndex = ledgerArgs.indexOf("--cwd");
const ledgerCwd = ledgerCwdIndex < 0 ? undefined : ledgerArgs[ledgerCwdIndex + 1];
if (
  ledgerCwd !== expectedLedgerRoot ||
  ledgerCwd === codexCwd ||
  ledgerArgs.slice(-2).join("\0") !== "--tool-profile\0implement-reviewer"
) {
  throw new Error("Codex reviewer boundary widened or misplaced the ledger repository boundary");
}

const launch = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
const handle = {
  attestationId: launch["attestationId"],
  generation: launch["generation"],
};
const inputCapability = launch["inputCapability"] as Record<string, unknown>;
const resultCapability = launch["resultCapability"] as Record<string, unknown>;
if (
  inputCapability?.["scope"] !== "fetch-input" ||
  resultCapability?.["scope"] !== "store-result" ||
  launch["gitChangeCapability"] !== undefined ||
  launch["gitConflictCapability"] !== undefined
) {
  throw new Error("Codex reviewer launch lost or widened its scoped capabilities");
}

const transport = new StdioClientTransport({
  command: ledgerCommand,
  args: ledgerArgs,
  cwd: codexCwd,
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  stderr: "pipe",
});
const client = new Client(
  { name: "t2081-packaged-codex-reviewer", version: "0.0.1" },
  { capabilities: {} },
);
await client.connect(transport);
const listedTools = (await client.listTools()).tools.map(({ name }) => name).sort();
if (listedTools.join(",") !== "fetch_dispatch_input,store_result") {
  throw new Error(`packaged reviewer saw unexpected tools: ${listedTools.join(",")}`);
}

function decode(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.[0];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error("ledger MCP returned no JSON text content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function call(name: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: body as Record<string, unknown> });
  if ((response as { isError?: boolean }).isError === true) {
    throw new Error(`reviewer probe ${name} failed: ${JSON.stringify(response)}`);
  }
  return decode(response);
}

async function command(command: string, args: readonly string[], cwd: string) {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function checkedGit(args: readonly string[]): Promise<string> {
  const result = await command(
    process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git",
    args,
    String(expectedWorktree),
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const materialized = await call("fetch_dispatch_input", { ...handle, inputCapability });
const input = materialized["input"] as Record<string, unknown>;
const taskId = String(input["taskId"]);
const branch = String(input["branch"]);
const baseCommit = String(input["baseCommit"]);
const workerResult = input["workerResult"] as Record<string, unknown>;
const resultCommit = String(workerResult["resultCommit"]);
const evidence = input["supervisedGateEvidence"] as Record<string, unknown> | undefined;
const parentGateAttestation = input["parentGateAttestation"];
const canonicalGate =
  'cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check';
if ((await checkedGit(["rev-parse", "--verify", branch])) !== resultCommit) {
  throw new Error("reviewer did not observe the exact worker branch tip");
}
if ((await checkedGit(["cat-file", "-t", resultCommit])) !== "commit") {
  throw new Error("reviewer resultCommit is not a commit object");
}
const mergeBase = await checkedGit(["merge-base", baseCommit, resultCommit]);
if (mergeBase !== baseCommit) throw new Error("reviewer resultCommit is outside base ancestry");

let gateReRan: boolean;
let gateDurationMs: number | undefined;
let gateExitCode = 0;
let passCount = 0;
let failCount = 0;
if (expectedMode === "sandboxed") {
  if (
    evidence === undefined ||
    parentGateAttestation !== undefined ||
    evidence["taskId"] !== taskId ||
    evidence["resultCommit"] !== resultCommit ||
    evidence["branch"] !== branch ||
    evidence["worktreePath"] !== expectedWorktree ||
    evidence["roleId"] !== "implement-worker" ||
    evidence["surface"] !== "codex" ||
    evidence["command"] !== canonicalGate ||
    evidence["clean"] !== true ||
    evidence["gateExitCode"] !== 0 ||
    evidence["failCount"] !== 0 ||
    !(Number(evidence["passCount"]) > 0)
  ) {
    throw new Error("sandboxed reviewer did not receive exact green supervised evidence");
  }
  gateReRan = false;
  passCount = Number(evidence["passCount"]);
} else {
  if (evidence !== undefined || parentGateAttestation !== undefined) {
    throw new Error("non-sandboxed reviewer received parent gate evidence");
  }
  const startedAt = Date.now();
  const gate = await command(
    ledgerCommand,
    [
      "gate",
      "run",
      "--worktree",
      expectedWorktree,
      "--command-cwd",
      `${expectedWorktree}/nix/pkg/cq-ledgers`,
      "--deadline",
      String(input["gateCompleteBy"]),
      "--",
      "bun",
      "run",
      "check",
    ],
    expectedWorktree,
  );
  gateDurationMs = Date.now() - startedAt;
  gateExitCode = gate.exitCode;
  const combined = `${gate.stdout}\n${gate.stderr}`;
  passCount = Number(/([0-9]+) pass(?:ed)?/u.exec(combined)?.[1] ?? 0);
  failCount = Number(/([0-9]+) fail/u.exec(combined)?.[1] ?? (gate.exitCode === 0 ? 0 : 1));
  if (gateExitCode !== 0 || passCount <= 0 || failCount !== 0) {
    throw new Error(`non-sandboxed reviewer gate failed: ${combined}`);
  }
  gateReRan = true;
}

const output = {
  taskId,
  verdict: "approve",
  criticism: [],
  questions: [],
  defects: [],
  rationale:
    expectedMode === "sandboxed"
      ? "validated exact runner-owned evidence"
      : "re-ran the canonical gate outside the read-only reviewer route",
  gateReRan,
  resultCommitVerified: true,
  resultCommitEvidence: {
    status: "verified",
    resultCommit,
    branchTip: resultCommit,
  },
  baseAncestry: {
    status: "verified",
    relation: baseCommit === resultCommit ? "equal" : "descendant",
    baseCommit,
    resultCommit,
    mergeBase,
  },
  ...(gateDurationMs === undefined ? {} : { gateDurationMs }),
  ...(expectedMode === "sandboxed" ? { gateReRanReason: "sandbox-denied-primitives" } : {}),
  actualWorktreePath: expectedWorktree,
};
const storeResult = await client.callTool({
  name: "store_result",
  arguments: { resultCapability, output },
});
if ((storeResult as { isError?: boolean }).isError === true) {
  throw new Error(`reviewer store_result failed: ${JSON.stringify(storeResult)}`);
}
const acknowledgement = decode(storeResult);
await writeFile(
  capturePath,
  JSON.stringify({
    boundary: { codexCwd, ledgerCwd, listedTools, sandboxMode },
    inputEvidence: {
      supervised: evidence !== undefined,
      parent: parentGateAttestation !== undefined,
    },
    gate: { gateExitCode, passCount, failCount, gateReRan },
    output,
  }),
);
await client.close();
process.stdout.write(
  [
    JSON.stringify({ type: "thread.started", thread_id: "t2081-packaged-reviewer" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "ledger",
        tool: "store_result",
        result: storeResult,
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(acknowledgement) },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n"),
);
