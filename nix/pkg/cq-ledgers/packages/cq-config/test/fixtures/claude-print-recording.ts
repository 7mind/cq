export {};

const args = process.argv.slice(2);

function value(flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || args[index + 1] === undefined) {
    throw new Error(`missing ${flag}`);
  }
  return args[index + 1]!;
}

const prompt = value("-p");
const handle = JSON.parse(prompt) as Record<string, unknown>;
if (Object.keys(handle).sort().join(",") !== "attestationId,generation") {
  throw new Error("launch prompt was not handle-only");
}
const sessionId = value("--session-id");
const model = value("--model");
const outputSchema = JSON.parse(value("--json-schema")) as { readonly title?: string };
if (outputSchema.title !== "dispatch handle") {
  throw new Error("wrong output schema");
}
if (!value("--append-system-prompt").includes("T688-ROLE-PROMPT")) {
  throw new Error("wrong generated role prompt");
}
if (value("--allowedTools") !== "mcp__t688store__store_result") {
  throw new Error("wrong scoped result tool");
}
if (value("--tools") !== "") {
  throw new Error("unexpected inherited tools");
}
if (!args.includes("--strict-mcp-config") || args.includes("--setting-sources")) {
  throw new Error("MCP endpoint was not strictly scoped");
}
const config = JSON.parse(value("--mcp-config")) as {
  readonly mcpServers: {
    readonly t688store: {
      readonly env: Readonly<Record<string, string>>;
    };
  };
};
if (!config.mcpServers.t688store.env["T688_CAPABILITY"]?.startsWith("cq_result_")) {
  throw new Error("result capability missing from scoped server environment");
}

if (args.includes("--emit-malformed")) {
  process.stdout.write("{}");
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    session_id: sessionId,
    uuid: "recorded-tool-use-t688",
    result: prompt,
    modelUsage: {
      [model]: { canonicalModel: `recorded-${model}` },
    },
  }),
);
