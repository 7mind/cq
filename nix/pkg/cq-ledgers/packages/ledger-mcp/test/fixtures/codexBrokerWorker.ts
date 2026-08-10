import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";

export {};

const endpoint = process.env["CQ_T2042_BROKER_ENDPOINT"];
const capturePath = process.env["CQ_T2042_BROKER_CAPTURE"];
if (endpoint === undefined || capturePath === undefined) {
  throw new Error("broker endpoint and capture path are required");
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

async function call(
  path: string,
  body: unknown,
  expectedOk = true,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (response.ok !== expectedOk) {
    throw new Error(`broker probe ${path} returned ${response.status}: ${JSON.stringify(result)}`);
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const materialized = await call("/fetch", { ...handle, inputCapability });
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
  "/git-commit",
  operation("T2042-packaged-1", baseCommit, "before\n", "first\n"),
);
await writeFile(`${worktreePath}/file.txt`, "second\n");
const second = await call(
  "/git-commit",
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
  await call("/git-commit", body, false);
  denied.push(label);
}

await writeFile(`${worktreePath}/undeclared.txt`, "undeclared\n");
await call(
  "/git-commit",
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
const acknowledgement = await call("/store", { resultCapability, output });
await writeFile(capturePath, JSON.stringify({ denied, output }));
process.stdout.write(
  [
    JSON.stringify({ type: "thread.started", thread_id: "t2042-packaged-broker" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "ledger",
        tool: "store_result",
        result: { content: [{ type: "text", text: JSON.stringify(acknowledgement) }] },
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(acknowledgement) },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n"),
);
