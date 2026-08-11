import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export {};

const capturePath = process.env["CQ_T2044_RESOLVER_CAPTURE"];
const expectedWorktree = process.env["CQ_T2044_WORKTREE"];
const expectedLedgerRoot = process.env["CQ_T2044_LEDGER_ROOT"];
if (capturePath === undefined || expectedWorktree === undefined || expectedLedgerRoot === undefined) {
  throw new Error("resolver capture path and repository boundary are required");
}

const argv = process.argv.slice(2);
if (argv[0] !== "exec") throw new Error("resolver recording executable expected codex exec");
const cwdIndex = argv.indexOf("-C");
const codexCwd = cwdIndex < 0 ? undefined : argv[cwdIndex + 1];
const mcpOverride = argv.find((argument) => argument.startsWith("mcp_servers.ledger="));
if (codexCwd !== expectedWorktree || mcpOverride === undefined) {
  throw new Error("Codex resolver boundary did not select the managed worktree and ledger MCP");
}
const commandMatch = /(?:^|[,{}])command=("(?:\\.|[^"\\])*")/.exec(mcpOverride);
const argsMatch = /(?:^|[,{}])args=(\[[^\]]*\])/.exec(mcpOverride);
if (commandMatch?.[1] === undefined || argsMatch?.[1] === undefined) {
  throw new Error("Codex resolver boundary emitted an unreadable ledger MCP configuration");
}
const ledgerCommand = JSON.parse(commandMatch[1]) as string;
const ledgerArgs = JSON.parse(argsMatch[1]) as string[];
const ledgerCwdIndex = ledgerArgs.indexOf("--cwd");
const ledgerCwd = ledgerCwdIndex < 0 ? undefined : ledgerArgs[ledgerCwdIndex + 1];
if (
  ledgerCwd !== expectedLedgerRoot ||
  ledgerCwd === codexCwd ||
  ledgerArgs.slice(-2).join("\0") !== "--tool-profile\0implement-conflict-resolver"
) {
  throw new Error("Codex resolver boundary widened or misplaced the ledger repository boundary");
}

const launch = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
const handle = {
  attestationId: launch["attestationId"],
  generation: launch["generation"],
};
const inputCapability = launch["inputCapability"] as Record<string, unknown>;
const resultCapability = launch["resultCapability"] as Record<string, unknown>;
const gitConflictCapability = launch["gitConflictCapability"] as Record<string, unknown>;
if (
  inputCapability?.["scope"] !== "fetch-input" ||
  resultCapability?.["scope"] !== "store-result" ||
  gitConflictCapability?.["scope"] !== "git-conflict" ||
  launch["gitChangeCapability"] !== undefined
) {
  throw new Error("Codex resolver launch lost or widened its scoped capability");
}

const transport = new StdioClientTransport({
  command: ledgerCommand,
  args: ledgerArgs,
  cwd: codexCwd,
  env: Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
  stderr: "pipe",
});
const client = new Client(
  { name: "t2044-packaged-codex-resolver", version: "0.0.1" },
  { capabilities: {} },
);
await client.connect(transport);
const listedTools = (await client.listTools()).tools.map(({ name }) => name).sort();
if (listedTools.join(",") !== "fetch_dispatch_input,git_resolve_continue,store_result") {
  throw new Error(`packaged resolver saw unexpected tools: ${listedTools.join(",")}`);
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
    throw new Error(`resolver probe ${name} failed: ${JSON.stringify(response)}`);
  }
  return decode(response);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const materialized = await call("fetch_dispatch_input", { ...handle, inputCapability });
const input = materialized["input"] as Record<string, unknown>;
const worktreePath = String(input["worktreePath"]);
const taskId = String(input["taskId"]);
const branch = String(input["branch"]);
const firstState = input["conflictState"] as Record<string, unknown>;
const firstResolution = "base changed a + task a\n";
await writeFile(`${worktreePath}/a.txt`, firstResolution);
const first = await call("git_resolve_continue", {
  ...handle,
  gitConflictCapability,
  operationId: "T2044-resolver-1",
  expectedState: firstState,
  resolutions: [
    {
      kind: "regular",
      path: "a.txt",
      newState: { mode: "100644", digest: digest(firstResolution) },
    },
  ],
});
const firstOutcome = first["outcome"] as Record<string, unknown>;
if (firstOutcome?.["kind"] !== "conflict") {
  throw new Error("first resolver continuation did not expose the second conflict");
}
const secondResolution = "base changed b + task b\n";
await writeFile(`${worktreePath}/b.txt`, secondResolution);
const second = await call("git_resolve_continue", {
  ...handle,
  gitConflictCapability,
  operationId: "T2044-resolver-2",
  expectedState: firstOutcome["state"],
  resolutions: [
    {
      kind: "regular",
      path: "b.txt",
      newState: { mode: "100644", digest: digest(secondResolution) },
    },
  ],
});
const secondOutcome = second["outcome"] as Record<string, unknown>;
if (secondOutcome?.["kind"] !== "terminal" || secondOutcome["tip"] !== second["newHead"]) {
  throw new Error("second resolver continuation did not terminate the rebase");
}
const directGit = Bun.spawnSync(
  [
    process.env["CQ_TEST_CODEX_SANDBOX_EXECUTABLE"] ?? "codex",
    "-c",
    'default_permissions="qualification"',
    "-c",
    `permissions.qualification.filesystem={":minimal"="read",` +
      `${JSON.stringify(worktreePath)}="write",` +
      `${JSON.stringify(`${expectedLedgerRoot}/.git`)}="read"}`,
    "sandbox",
    "-P",
    "qualification",
    "-C",
    worktreePath,
    "--",
    process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git",
    "update-ref",
    "refs/heads/cq-direct-git-resolver-probe",
    String(second["newHead"]),
  ],
  { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
);
if (directGit.exitCode === 0) {
  throw new Error("resolver direct Git ref mutation unexpectedly succeeded");
}
const deniedCapability = await client.callTool({
  name: "git_resolve_continue",
  arguments: {
    ...handle,
    gitConflictCapability: { scope: "git-conflict", token: "cq_conflict_foreign_capability" },
    operationId: "T2044-resolver-deny-capability",
    expectedState: firstOutcome["state"],
    resolutions: [],
  },
});
if ((deniedCapability as { isError?: boolean }).isError !== true) {
  throw new Error("resolver foreign Git capability unexpectedly succeeded");
}
const failureControls = ["capability"];

const output = {
  taskId,
  status: "pass",
  resultCommit: second["newHead"],
  filesResolved: ["a.txt", "b.txt"],
  checkSummary: "REAL_CHECK_EXIT=0",
  summary: "packaged resolver completed two conflict continuation steps",
  actualWorktreePath: worktreePath,
  branch,
  conflictReceipts: [first, second],
};
const storeResult = await client.callTool({
  name: "store_result",
  arguments: { resultCapability, output },
});
if ((storeResult as { isError?: boolean }).isError === true) {
  throw new Error(`resolver store_result failed: ${JSON.stringify(storeResult)}`);
}
const acknowledgement = decode(storeResult);
await writeFile(
  capturePath,
  JSON.stringify({
    boundary: { codexCwd, ledgerCommand, ledgerArgs, ledgerCwd, listedTools },
    directGit: {
      attempted: true,
      exitStatus: directGit.exitCode,
      stderrDigest: digest(directGit.stderr.toString()),
    },
    output,
  }),
);
await client.close();
process.stdout.write(
  [
    JSON.stringify({ type: "thread.started", thread_id: "t2044-packaged-resolver" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "cq_provider_gate_observation", failure_controls: failureControls },
    }),
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
