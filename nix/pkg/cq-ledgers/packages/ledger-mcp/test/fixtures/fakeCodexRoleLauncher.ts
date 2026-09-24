/**
 * G224: a stand-in for the packaged `cq-codex-role` launcher. It reads the
 * one private stdin request the Codex parent contract defines, starts the
 * child's ledger server exactly as the real boundary configures it, stores the
 * role's result with the request's capability, and prints the handle.
 */

import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const request = JSON.parse((await Bun.stdin.text()).trim()) as {
  readonly roleId: string;
  readonly handle: { readonly attestationId: string; readonly generation: number };
  readonly inputCapability: unknown;
  readonly resultCapability: unknown;
  readonly ledgerCwd: string;
  readonly [key: string]: unknown;
};
const capture = process.env["CQ_FAKE_CODEX_REQUEST_CAPTURE"];
if (capture !== undefined) {
  writeFileSync(
    capture,
    JSON.stringify({
      request: { ...request, inputCapability: "<redacted>", resultCapability: "<redacted>" },
      correlationId: process.env["CQ_CODEX_ROLE_CORRELATION_ID"],
      promptRoot: process.env["CQ_PROMPT_ROOT"],
    }),
  );
}
const promptRoot = process.env["CQ_PROMPT_ROOT"];
const ledgerCommand = process.env["CQ_CODEX_LEDGER_COMMAND"];
if (promptRoot === undefined || ledgerCommand === undefined) {
  throw new Error("fake cq-codex-role: CQ_PROMPT_ROOT and CQ_CODEX_LEDGER_COMMAND are required");
}
const inherited: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) inherited[key] = value;
}
const client = new Client({ name: "fake-codex-child", version: "0.0.1" }, { capabilities: {} });
await client.connect(
  new StdioClientTransport({
    command: ledgerCommand,
    args: [
      "mcp", "--cwd", request.ledgerCwd, "--prompt-surface", "codex", "--prompt-root", promptRoot,
      "--tool-profile", request.roleId,
    ],
    env: { ...inherited, CQ_HARNESS: "codex", CQ_PROMPT_SURFACE: "codex", CQ_PROMPT_ROOT: promptRoot },
    stderr: "inherit",
  }),
);

function check(result: unknown): void {
  const decoded = result as { content: Array<{ text: string }>; isError?: boolean };
  if (decoded.isError === true) throw new Error(`fake cq-codex-role: ${decoded.content[0]?.text}`);
}

check(
  await client.callTool({
    name: "fetch_dispatch_input",
    arguments: { ...request.handle, inputCapability: request.inputCapability },
  }),
);
check(
  await client.callTool({
    name: "store_result",
    arguments: {
      resultCapability: request.resultCapability,
      output: JSON.parse(process.env["CQ_FAKE_CODEX_OUTPUT"] ?? "{}") as unknown,
    },
  }),
);
await client.close();
process.stdout.write(`${JSON.stringify(request.handle)}\n`);
