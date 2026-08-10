import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export {};

const capturePath = process.env["CQ_T2042_BROKER_CAPTURE"];
const expectedWorktree = process.env["CQ_T2042_WORKTREE"];
const expectedLedgerRoot = process.env["CQ_T2042_LEDGER_ROOT"];
if (capturePath === undefined || expectedWorktree === undefined || expectedLedgerRoot === undefined) {
  throw new Error("capture path and repository boundary are required");
}

const argv = process.argv.slice(2);
if (argv[0] !== "exec") throw new Error("recording executable expected codex exec");
const cwdIndex = argv.indexOf("-C");
const codexCwd = cwdIndex < 0 ? undefined : argv[cwdIndex + 1];
const mcpOverride = argv.find((argument) => argument.startsWith("mcp_servers.ledger="));
if (codexCwd !== expectedWorktree || mcpOverride === undefined) {
  throw new Error("Codex role boundary did not select the managed worktree and ledger MCP");
}
const commandMatch = /(?:^|[,{}])command=("(?:\\.|[^"\\])*")/.exec(mcpOverride);
const argsMatch = /(?:^|[,{}])args=(\[[^\]]*\])/.exec(mcpOverride);
if (commandMatch?.[1] === undefined || argsMatch?.[1] === undefined) {
  throw new Error("Codex role boundary emitted an unreadable ledger MCP configuration");
}
const ledgerCommand = JSON.parse(commandMatch[1]) as string;
const ledgerArgs = JSON.parse(argsMatch[1]) as string[];
const ledgerCwdIndex = ledgerArgs.indexOf("--cwd");
const ledgerCwd = ledgerCwdIndex < 0 ? undefined : ledgerArgs[ledgerCwdIndex + 1];
if (
  ledgerCwd !== expectedLedgerRoot ||
  ledgerCwd === codexCwd ||
  ledgerArgs.slice(-2).join("\0") !== "--tool-profile\0implement-worker"
) {
  throw new Error("Codex role boundary widened or misplaced the ledger repository boundary");
}

const launch = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
const handle = {
  attestationId: launch["attestationId"],
  generation: launch["generation"],
};
const inputCapability = launch["inputCapability"] as Record<string, unknown>;
const resultCapability = launch["resultCapability"] as Record<string, unknown>;
const gitChangeCapability = launch["gitChangeCapability"] as Record<string, unknown>;
if (
  inputCapability?.["scope"] !== "fetch-input" ||
  resultCapability?.["scope"] !== "store-result" ||
  gitChangeCapability?.["scope"] !== "git-change"
) {
  throw new Error("Codex worker launch lost a scoped capability");
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
  { name: "t2042-packaged-codex-worker", version: "0.0.1" },
  { capabilities: {} },
);
await client.connect(transport);
const listedTools = (await client.listTools()).tools.map(({ name }) => name).sort();
if (listedTools.join(",") !== "fetch_dispatch_input,git_commit,store_result") {
  throw new Error(`packaged worker saw unexpected tools: ${listedTools.join(",")}`);
}

function decode(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.[0];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error("ledger MCP returned no JSON text content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function call(
  name: string,
  body: unknown,
  expectedOk = true,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: body as Record<string, unknown> });
  const isError = (response as { isError?: boolean }).isError === true;
  if (isError === expectedOk) {
    throw new Error(`broker probe ${name} returned unexpected MCP result: ${JSON.stringify(response)}`);
  }
  if (!expectedOk) return {};
  return decode(response);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const materialized = await call("fetch_dispatch_input", { ...handle, inputCapability });
const input = materialized["input"] as Record<string, unknown>;
const worktreePath = String(input["worktreePath"]);
const baseCommit = String(input["baseCommit"]);
const taskId = String(input["taskId"]);
const branch = String(input["branch"]);
const operation = (operationId: string, expectedHead: string, from: string, to: string) => ({
  ...handle,
  gitChangeCapability,
  operationId,
  expectedHead,
  message: operationId,
  changes: [
    {
      kind: "modify",
      path: "file.txt",
      oldState: { mode: "100644", digest: sha256(from) },
      newState: { mode: "100644", digest: sha256(to) },
    },
  ],
});

await writeFile(`${worktreePath}/file.txt`, "first\n");
const first = await call(
  "git_commit",
  operation("T2042-packaged-1", baseCommit, "before\n", "first\n"),
);
await writeFile(`${worktreePath}/file.txt`, "second\n");
const second = await call(
  "git_commit",
  operation("T2042-packaged-2", String(first["newHead"]), "first\n", "second\n"),
);

const denied: string[] = [];
for (const [label, body] of [
  [
    "main",
    {
      ...operation("T2042-deny-main", String(second["newHead"]), "second\n", "second\n"),
      changes: [
        { kind: "add", path: "../main.txt", newState: { mode: "100644", digest: sha256("x") } },
      ],
    },
  ],
  [
    "sibling",
    {
      ...operation("T2042-deny-sibling", String(second["newHead"]), "second\n", "second\n"),
      changes: [
        {
          kind: "add",
          path: "/sibling/file.txt",
          newState: { mode: "100644", digest: sha256("x") },
        },
      ],
    },
  ],
  [
    "refs",
    {
      ...operation("T2042-deny-ref", String(second["newHead"]), "second\n", "second\n"),
      changes: [
        {
          kind: "add",
          path: ".git/refs/heads/main",
          newState: { mode: "100644", digest: sha256("x") },
        },
      ],
    },
  ],
  [
    "git-metadata",
    {
      ...operation("T2042-deny-metadata", String(second["newHead"]), "second\n", "second\n"),
      changes: [
        { kind: "add", path: ".git/config", newState: { mode: "100644", digest: sha256("x") } },
      ],
    },
  ],
  [
    "repository",
    {
      ...operation("T2042-deny-repository", String(second["newHead"]), "second\n", "second\n"),
      gitChangeCapability: { scope: "git-change", token: "cq_git_foreign_repository_capability" },
    },
  ],
  ["base", operation("T2042-deny-base", baseCommit, "second\n", "second\n")],
] as const) {
  await call("git_commit", body, false);
  denied.push(label);
}

await writeFile(`${worktreePath}/undeclared.txt`, "undeclared\n");
await call(
  "git_commit",
  operation("T2042-deny-undeclared", String(second["newHead"]), "second\n", "second\n"),
  false,
);
denied.push("undeclared-path");
await rm(`${worktreePath}/undeclared.txt`);

const output = {
  taskId,
  status: "pass",
  resultCommit: second["newHead"],
  branch,
  actualWorktreePath: worktreePath,
  filesTouched: ["file.txt"],
  gitReceipts: [first, second],
  checkSummary: "REAL_CHECK_EXIT=0",
  gateDurationMs: 1,
  baseVerification: {
    status: "verified",
    relation: "descendant",
    baseCommit,
    headCommit: second["newHead"],
  },
  summary: "packaged broker worker completed",
};
const storeResult = await client.callTool({
  name: "store_result",
  arguments: { resultCapability, output },
});
if ((storeResult as { isError?: boolean }).isError === true) {
  throw new Error(`store_result failed: ${JSON.stringify(storeResult)}`);
}
const acknowledgement = decode(storeResult);
await writeFile(
  capturePath,
  JSON.stringify({
    boundary: { codexCwd, ledgerCommand, ledgerArgs, ledgerCwd, listedTools },
    denied,
    output,
  }),
);
await client.close();
process.stdout.write(
  [
    JSON.stringify({ type: "thread.started", thread_id: "t2042-packaged-broker" }),
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
