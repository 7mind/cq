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
const reference = JSON.parse(prompt) as Record<string, unknown>;
if (Object.keys(reference).sort().join(",") !== "attestationId,generation,inputCapability") {
  throw new Error("launch prompt was not an input reference");
}
const handle = JSON.stringify({
  attestationId: reference["attestationId"],
  generation: reference["generation"],
});
const sessionId = value("--session-id");
const model = value("--model");
const outputSchema = JSON.parse(value("--json-schema")) as {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
};
if ("$schema" in outputSchema) {
  throw new Error("Claude CLI output schema retained the unsupported $schema annotation");
}
if (outputSchema.$id !== "cq:compact-dispatch/handle") {
  throw new Error("Claude CLI output schema lost its authoritative $id");
}
if (outputSchema.title !== "dispatch handle") {
  throw new Error("wrong output schema");
}
if (!value("--append-system-prompt").includes("T688-ROLE-PROMPT")) {
  throw new Error("wrong generated role prompt");
}
if (
  value("--allowedTools") !==
    "mcp__t688store__fetch_dispatch_input,mcp__t688store__store_result,mcp__t688store__git_commit"
) {
  throw new Error("wrong scoped dispatch tools");
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
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    };
  };
};
const resultCapabilityToken = config.mcpServers.t688store.env["T688_CAPABILITY"];
const capabilityEndpoint = config.mcpServers.t688store.env["CQ_T1631_CAPABILITY_ENDPOINT"];
if (!resultCapabilityToken?.startsWith("cq_result_")) {
  throw new Error("result capability missing from scoped server environment");
}
// Regression origin: tasks:T1329 acceptance (2026-07-31).
if (config.mcpServers.t688store.args.slice(-2).join(",") !== "--tool-profile,implement-worker") {
  throw new Error("scoped server did not receive the assigned role tool profile");
}

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
  const response = await fetch(`${capabilityEndpoint}${path}`, {
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
if (capabilityEndpoint !== undefined && !args.includes("--skip-capabilities")) {
  const materialized = await callCapability("/fetch", reference);
  if (
    materialized["state"] !== "input-materialized" ||
    (materialized["input"] as Record<string, unknown>)?.["taskId"] !== "T1631"
  ) {
    throw new Error("recorded child did not materialize the prepared input");
  }
  const stored = await callCapability("/store", {
    resultCapability: { scope: "store-result", token: resultCapabilityToken },
    output,
  });
  if (stored["state"] !== "result-stored") {
    throw new Error("recorded child store did not return result-stored");
  }
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
    result: handle,
    modelUsage: {
      [model]: { canonicalModel: `recorded-${model}` },
    },
  }),
);
