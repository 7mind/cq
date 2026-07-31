import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const ALLOW_TOOL = "fetch_item";
const DENY_TOOL = "create_item";
const SERVER_NAME = "cq_profile";
const PROBE_TIMEOUT_MS = 30_000;
const ROLE_INSTRUCTION_SENTINEL = "T1330 native role-instruction sentinel";

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

function writeRpc(id: string | number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function runProbeMcpServer(): void {
  process.stdin.setEncoding("utf8");
  let buffered = "";
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line === "") continue;
      const request = JSON.parse(line) as JsonRpcRequest;
      if (request.id === undefined) continue;
      if (request.method === "initialize") {
        writeRpc(request.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "t1325-role-tool-probe", version: "1" },
        });
      } else if (request.method === "tools/list") {
        writeRpc(request.id, {
          tools: [
            {
              name: ALLOW_TOOL,
              description: "T1325 allowed sentinel",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
            {
              name: DENY_TOOL,
              description: "T1325 denied sentinel",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        });
      } else {
        writeRpc(request.id, {});
      }
    }
  });
}

interface ResponsesRequest {
  readonly instructions?: string;
  readonly input?: unknown;
  readonly tools?: readonly {
    readonly name?: string;
    readonly type?: string;
    readonly tools?: readonly { readonly name?: string }[];
  }[];
}

async function runCodexBoundaryProbe(): Promise<void> {
  const codexExecutable = process.env["CQ_T1325_CODEX"] ?? "codex";
  const scratch = mkdtempSync(path.join(tmpdir(), "cq-t1325-codex-profile-"));
  let resolveCapture: (value: ResponsesRequest) => void;
  let rejectCapture: (error: Error) => void;
  const captured = new Promise<ResponsesRequest>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  const captureServer = Bun.serve({
    port: 0,
    async fetch(request) {
      try {
        resolveCapture((await request.json()) as ResponsesRequest);
      } catch (error: unknown) {
        rejectCapture(error instanceof Error ? error : new Error(String(error)));
      }
      return new Response("T1325 probe captured the model request", { status: 503 });
    },
  });
  const baseUrl = `http://127.0.0.1:${captureServer.port}/v1`;
  const mcpScript = path.resolve(import.meta.path);
  const child = Bun.spawn(
    [
      codexExecutable,
      "exec",
      "--ignore-user-config",
      "--strict-config",
      "--ephemeral",
      "--skip-git-repo-check",
      "--json",
      "-C",
      scratch,
      "-m",
      "t1325-probe",
      "-c",
      'model_provider="t1325"',
      "-c",
      `model_providers.t1325={name="T1325 local capture",base_url=${JSON.stringify(baseUrl)},env_key="T1325_PROBE_KEY",wire_api="responses"}`,
      "-c",
      `mcp_servers.${SERVER_NAME}={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(mcpScript)},"--mcp-server"],enabled_tools=["${ALLOW_TOOL}"],required=true}`,
      "-c",
      `developer_instructions=${JSON.stringify(ROLE_INSTRUCTION_SENTINEL)}`,
      "-c",
      `model_reasoning_effort=${JSON.stringify("high")}`,
      "-c",
      'approval_policy="never"',
      "-c",
      "features.multi_agent=false",
      "Return the word probe without calling tools.",
    ],
    {
      cwd: scratch,
      env: {
        PATH: process.env.PATH ?? "",
        CODEX_HOME: scratch,
        T1325_PROBE_KEY: "local-probe-key",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const request = await Promise.race([
      captured,
      child.exited.then(async (exitCode) => {
        const stderr = await new Response(child.stderr).text();
        throw new Error(`Codex exited ${exitCode} before a model request: ${stderr}`);
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("timed out waiting for Codex model request")),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    const capturedModelTools = (request.tools ?? []).flatMap((tool) => {
      if (tool.type === "namespace" && typeof tool.name === "string") {
        return (tool.tools ?? [])
          .map((nested) =>
            typeof nested.name === "string" ? `${tool.name}__${nested.name}` : undefined,
          )
          .filter((name): name is string => name !== undefined);
      }
      return typeof tool.name === "string" ? [tool.name] : [];
    });
    const allowedName = `mcp__${SERVER_NAME}__${ALLOW_TOOL}`;
    const deniedName = `mcp__${SERVER_NAME}__${DENY_TOOL}`;
    if (!capturedModelTools.includes(allowedName)) {
      throw new Error(
        `allowed tool "${allowedName}" did not reach the model request: ` +
          JSON.stringify(capturedModelTools),
      );
    }
    if (capturedModelTools.includes(deniedName)) {
      throw new Error(`denied tool "${deniedName}" reached the model request`);
    }
    if (!JSON.stringify(request).includes(ROLE_INSTRUCTION_SENTINEL)) {
      throw new Error("native developer instructions did not reach the model request");
    }
    const childDispatchTools = capturedModelTools.filter((name) =>
      /(?:^|__)spawn_agent$|(?:^|__)followup_task$/.test(name),
    );
    if (childDispatchTools.length !== 0) {
      throw new Error(
        `child dispatch tools reached the model request: ${JSON.stringify(childDispatchTools)}`,
      );
    }
    const version = Bun.spawnSync([codexExecutable, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (version.exitCode !== 0) throw new Error("codex --version failed");
    process.stdout.write(
      `${JSON.stringify({
        boundary: "codex-exec-process",
        codexVersion: version.stdout.toString().trim(),
        enabled_tools: [ALLOW_TOOL],
        capturedModelTools,
        allowedName,
        deniedName,
        deniedDefinitionReachedModelContext: false,
        nativeRoleInstructionsReachedModelContext: true,
        childDispatchTools,
      })}\n`,
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    child.kill("SIGKILL");
    child.unref();
    captureServer.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv.includes("--mcp-server")) {
  runProbeMcpServer();
} else {
  await runCodexBoundaryProbe();
}
