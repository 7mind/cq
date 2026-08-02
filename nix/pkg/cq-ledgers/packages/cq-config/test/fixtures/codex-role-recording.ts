import { writeFileSync } from "node:fs";

export {};

const mode = process.env["CQ_T1631_CODEX_MODE"];
const capturePath = process.env["CQ_T1631_CODEX_CAPTURE"];
if (!["echo", "malformed", "success", "wait"].includes(mode ?? "") || capturePath === undefined) {
  throw new Error("recording mode and capture path are required");
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
writeFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2), launch }));

if (mode === "wait") {
  await Bun.sleep(60_000);
}

const handle = {
  attestationId: launch["attestationId"],
  generation: launch["generation"],
};
const acknowledgement = {
  state: "result-stored",
  result: {
    state: "result-stored",
    ...handle,
    storedAt: "2026-08-02T18:45:00.000Z",
    outputDigest: "a".repeat(64),
  },
};
const finalMessage =
  mode === "malformed"
    ? "not-a-dispatch-handle"
    : mode === "echo"
      ? JSON.stringify({ ...handle, output: { leaked: true } })
      : JSON.stringify(acknowledgement);

process.stdout.write(
  [
    JSON.stringify({ type: "thread.started", thread_id: "recorded-codex-thread" }),
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
  ].join("\n"),
);
