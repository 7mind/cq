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
const startingCommit = String(input["startingCommit"]);
const taskId = String(input["taskId"]);
const branch = String(input["branch"]);
const round = Number(input["round"]);
if (round !== 0 && round !== 1) throw new Error(`unexpected packaged worker round ${String(round)}`);
const roundContent =
  round === 0
    ? { before: "before\n", first: "first\n", second: "second\n" }
    : { before: "second\n", first: "third\n", second: "fourth\n" };
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

await writeFile(`${worktreePath}/file.txt`, roundContent.first);
const first = await call(
  "git_commit",
  operation(
    `${taskId}-packaged-r${String(round)}-1`,
    startingCommit,
    roundContent.before,
    roundContent.first,
  ),
);
await writeFile(`${worktreePath}/file.txt`, roundContent.second);
const second = await call(
  "git_commit",
  operation(
    `${taskId}-packaged-r${String(round)}-2`,
    String(first["newHead"]),
    roundContent.first,
    roundContent.second,
  ),
);

const directGit = Bun.spawnSync(
  [
    process.env["CQ_TEST_CODEX_SANDBOX_EXECUTABLE"] ?? "codex",
    "-c",
    'default_permissions="workspace"',
    "-c",
    'permissions.workspace.extends=":workspace"',
    "sandbox",
    "-P",
    "workspace",
    "-C",
    worktreePath,
    "--",
    process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git",
    "update-ref",
    "refs/heads/cq-direct-git-probe",
    startingCommit,
  ],
  { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
);
if (directGit.exitCode === 0) {
  throw new Error("direct Git ref mutation unexpectedly succeeded");
}

const failureControls: string[] = [];
await call(
  "git_commit",
  {
    ...operation(
      `${taskId}-deny-identity-r${String(round)}`,
      String(second["newHead"]),
      roundContent.second,
      roundContent.second,
    ),
    attestationId: `${String(handle.attestationId)}-foreign`,
  },
  false,
);
failureControls.push("identity");
await call(
  "git_commit",
  {
    ...operation("", String(second["newHead"]), roundContent.second, roundContent.second),
    operationId: "",
  },
  false,
);
failureControls.push("operation");
await call(
  "git_commit",
  {
    ...operation(
      `${taskId}-deny-digest-r${String(round)}`,
      String(second["newHead"]),
      roundContent.second,
      roundContent.second,
    ),
    changes: [
      {
        kind: "modify",
        path: "file.txt",
        oldState: { mode: "100644", digest: "0".repeat(64) },
        newState: { mode: "100644", digest: sha256(roundContent.second) },
      },
    ],
  },
  false,
);
failureControls.push("digest");
await call(
  "git_commit",
  {
    ...operation(
      `${taskId}-deny-generation-r${String(round)}`,
      String(second["newHead"]),
      roundContent.second,
      roundContent.second,
    ),
    generation: Number(handle.generation) + 1,
  },
  false,
);
failureControls.push("generation");
await call(
  "git_commit",
  operation(
    `${taskId}-packaged-r${String(round)}-1`,
    String(second["newHead"]),
    roundContent.second,
    roundContent.second,
  ),
  false,
);
failureControls.push("replay");

const denied: string[] = [];
for (const [label, body] of [
  [
    "main",
    {
      ...operation(
        `${taskId}-deny-main-r${String(round)}`,
        String(second["newHead"]),
        roundContent.second,
        roundContent.second,
      ),
      changes: [
        { kind: "add", path: "../main.txt", newState: { mode: "100644", digest: sha256("x") } },
      ],
    },
  ],
  [
    "sibling",
    {
      ...operation(
        `${taskId}-deny-sibling-r${String(round)}`,
        String(second["newHead"]),
        roundContent.second,
        roundContent.second,
      ),
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
      ...operation(
        `${taskId}-deny-ref-r${String(round)}`,
        String(second["newHead"]),
        roundContent.second,
        roundContent.second,
      ),
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
      ...operation(
        `${taskId}-deny-metadata-r${String(round)}`,
        String(second["newHead"]),
        roundContent.second,
        roundContent.second,
      ),
      changes: [
        { kind: "add", path: ".git/config", newState: { mode: "100644", digest: sha256("x") } },
      ],
    },
  ],
  [
    "repository",
    {
      ...operation(
        `${taskId}-deny-repository-r${String(round)}`,
        String(second["newHead"]),
        roundContent.second,
        roundContent.second,
      ),
      gitChangeCapability: { scope: "git-change", token: "cq_git_foreign_repository_capability" },
    },
  ],
  [
    "base",
    operation(
      `${taskId}-deny-base-r${String(round)}`,
      baseCommit,
      roundContent.second,
      roundContent.second,
    ),
  ],
] as const) {
  await call("git_commit", body, false);
  denied.push(label);
}
failureControls.push("capability");

await writeFile(`${worktreePath}/undeclared.txt`, "undeclared\n");
await call(
  "git_commit",
  operation(
    `${taskId}-deny-undeclared-r${String(round)}`,
    String(second["newHead"]),
    roundContent.second,
    roundContent.second,
  ),
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
await call(
  "git_commit",
  operation(
    `${taskId}-deny-post-store-r${String(round)}`,
    String(second["newHead"]),
    roundContent.second,
    roundContent.second,
  ),
  false,
);
failureControls.push("post-store");
await writeFile(
  capturePath,
  JSON.stringify({
    boundary: { codexCwd, ledgerCommand, ledgerArgs, ledgerCwd, listedTools },
    denied,
    directGit: {
      attempted: true,
      exitStatus: directGit.exitCode,
      stderrDigest: sha256(directGit.stderr.toString()),
    },
    failureControls,
    output,
  }),
);
await client.close();
process.stdout.write(
  [
    JSON.stringify({ type: "thread.started", thread_id: "t2042-packaged-broker" }),
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
