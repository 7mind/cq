import { writeFileSync } from "node:fs";

export {};

const mode = process.env["CQ_T1631_CODEX_MODE"];
const capturePath = process.env["CQ_T1631_CODEX_CAPTURE"];
const endpoint = process.env["CQ_T1631_CAPABILITY_ENDPOINT"];
if (
  ![
    "echo",
    "failed-outcome",
    "malformed",
    "success",
    "unused-capabilities",
    "wait",
  ].includes(mode ?? "") ||
  capturePath === undefined ||
  endpoint === undefined
) {
  throw new Error("recording mode, capture path, and capability endpoint are required");
}

const launch = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
if (
  Object.keys(launch).sort().join(",") !==
  "attestationId,generation,inputCapability,resultCapability"
) {
  throw new Error("Codex boundary stdin was not the compact launch reference");
}
const inputCapability = launch["inputCapability"] as Record<string, unknown>;
const resultCapability = launch["resultCapability"] as Record<string, unknown>;
if (
  inputCapability?.["scope"] !== "fetch-input" ||
  !String(inputCapability?.["token"]).startsWith("cq_input_") ||
  resultCapability?.["scope"] !== "store-result" ||
  !String(resultCapability?.["token"]).startsWith("cq_result_")
) {
  throw new Error("Codex boundary stdin lost a scoped capability");
}
writeFileSync(
  capturePath,
  JSON.stringify({
    argv: process.argv.slice(2),
    correlationId: process.env["CQ_CODEX_ROLE_CORRELATION_ID"],
    launch,
  }),
);

const handle = {
  attestationId: launch["attestationId"],
  generation: launch["generation"],
};
const output = {
  taskId: "T1631",
  status: "pass",
  resultCommit: "a".repeat(40),
  branch: "implement/T1631",
  actualWorktreePath: "/tmp/wt-actual",
  filesTouched: [],
  checkSummary: "focused router suite passed",
  summary: "shared transport router implemented",
  gateDurationMs: 1,
  baseVerification: {
    status: "verified",
    relation: "descendant",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
  },
};

async function callCapability(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`recorded capability ${path} failed: ${String(result["error"])}`);
  }
  return result;
}

let acknowledgement: Record<string, unknown> = {
  state: "result-stored",
  result: {
    state: "result-stored",
    ...handle,
    storedAt: "2026-08-02T18:45:00.000Z",
    outputDigest: "a".repeat(64),
  },
};
if (mode !== "unused-capabilities") {
  const materialized = await callCapability("/fetch", {
    ...handle,
    inputCapability,
  });
  if (
    materialized["state"] !== "input-materialized" ||
    (materialized["input"] as Record<string, unknown>)?.["taskId"] !== "T1631"
  ) {
    throw new Error("recorded child did not materialize the prepared input");
  }
  if (mode === "wait") {
    await Bun.sleep(60_000);
  }
  acknowledgement = await callCapability("/store", {
    resultCapability,
    output,
  });
  if (acknowledgement["state"] !== "result-stored") {
    throw new Error("recorded child store did not return result-stored");
  }
}
const finalMessage =
  mode === "malformed"
    ? "not-a-dispatch-handle"
    : mode === "echo"
      ? JSON.stringify({ ...handle, output: { leaked: true } })
      : JSON.stringify(acknowledgement);
const threadId = "fresh-codex-thread-from-exec";
const turnEvent =
  mode === "failed-outcome"
    ? { type: "turn.failed", error: { message: "recorded transport failure" } }
    : { type: "turn.completed", usage: {} };

process.stdout.write(
  [
    JSON.stringify({ type: "thread.started", thread_id: threadId }),
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
      item: { type: "agent_message", text: finalMessage },
    }),
    JSON.stringify(turnEvent),
  ].join("\n"),
);
