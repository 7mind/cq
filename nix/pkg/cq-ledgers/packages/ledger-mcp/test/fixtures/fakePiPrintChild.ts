/**
 * G224: a stand-in for `pi -p --mode json`. It records its argv (including the
 * task) and emits the event stream a real Pi child prints.
 *
 * Server-settled (no `-e`): the final assistant message's fenced json block is
 * the role result.
 *
 * Child-stored (`-e <extension>`, D544): it loads the real CQ Pi extension
 * through a stand-in extension API, exactly as Pi would, then plays the model:
 * retrieves its input with the compact reference it was given, stores the
 * result through the registered `store_result`, and replies with the handle.
 * It also records whether the capability ever reached its own environment.
 */

import { writeFileSync } from "node:fs";

interface RegisteredTool {
  readonly name: string;
  execute(toolCallId: string, params: unknown): Promise<{ content: ReadonlyArray<{ text: string }> }>;
}

const argv = process.argv.slice(2);
const capture = process.env["CQ_FAKE_PI_ARGV_CAPTURE"];
if (capture !== undefined) writeFileSync(capture, JSON.stringify(argv));
const output = process.env["CQ_FAKE_PI_OUTPUT"] ?? "{}";
const task = argv.at(-1)!;
const extensionPath = argv.includes("-e") ? argv[argv.indexOf("-e") + 1] : undefined;

let finalText: string;
if (extensionPath === undefined) {
  finalText = `Result:\n\`\`\`json\n${output}\n\`\`\``;
} else {
  const tools = new Map<string, RegisteredTool>();
  const shutdown: Array<() => Promise<void>> = [];
  const extension = (await import(extensionPath)) as {
    default: (pi: unknown) => Promise<void>;
  };
  await extension.default({
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    on: (_event: string, handler: () => Promise<void>) => shutdown.push(handler),
  });
  const environmentCapture = process.env["CQ_FAKE_PI_ENV_CAPTURE"];
  if (environmentCapture !== undefined) {
    writeFileSync(
      environmentCapture,
      JSON.stringify({ environment: process.env, tools: [...tools.keys()] }),
    );
  }
  const reference = JSON.parse(task) as { attestationId: string; generation: number };
  await tools.get("fetch_dispatch_input")!.execute("call-1", reference);
  await tools.get("store_result")!.execute("call-2", { output: JSON.parse(output) as unknown });
  for (const handler of shutdown) await handler();
  finalText = JSON.stringify({ attestationId: reference.attestationId, generation: reference.generation });
}
const events = [
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: task }] } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Working." }] } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } },
];
process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
