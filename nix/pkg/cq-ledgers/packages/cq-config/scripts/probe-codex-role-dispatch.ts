#!/usr/bin/env -S bun run

import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createProcessWorksetEffectAdmissionProvider } from "@cq/process-control";
import {
  createCodexRoleBoundaryPlan,
  executeCodexRoleBoundary,
  type CodexRoleBoundaryPlan,
} from "../src/index.js";

const ROLE_ID = "plan-advance";
const MODEL_ID = "t1493-local-control";
const MODEL_API_KEY_ENV = "T1493_LOCAL_MODEL_KEY";
const PROMPT_ROOT_ENV = "CQ_PROMPT_ROOT";
const REDACTED = "[REDACTED]";
const PROBE_TIMEOUT_MS = 60_000;
const EXPECTED_ROLE_TOOLS = [
  "fetch_item",
  "fts_search",
  "list_milestone_items",
  "fetch_dispatch_input",
  "store_result",
] as const;
const EXPECTED_RESULT = {
  mode: "default",
  action: "noop",
  grounding: "T1493 deterministic Codex role dispatch probe",
} as const;
const DIFFERENT_RESULT = {
  mode: "default",
  action: "awaiting",
  grounding: "T1493 conflicting result sentinel",
} as const;

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

interface McpTextContent {
  readonly type: string;
  readonly text?: string;
}

interface McpToolResult {
  readonly content: readonly McpTextContent[];
  readonly isError?: boolean;
}

interface DispatchPrepared {
  readonly attestationId: string;
  readonly generation: number;
  readonly inputCapability: { readonly scope: "fetch-input"; readonly token: string };
  readonly resultCapability: { readonly scope: "store-result"; readonly token: string };
  readonly promptProvenance: {
    readonly roleId: string;
    readonly version: number;
    readonly promptDigest: string;
    readonly inputDigest: string;
  };
}

interface PreparedOutcome {
  readonly accepted: boolean;
  readonly prepared?: DispatchPrepared;
}

interface RoleInvocation {
  readonly roleId: string;
  readonly handle: { readonly attestationId: string; readonly generation: number };
  readonly inputCapability: DispatchPrepared["inputCapability"];
  readonly resultCapability: DispatchPrepared["resultCapability"];
  readonly cwd: string;
  readonly ledgerCwd: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sandboxMode: "read-only";
  readonly timeoutMs: number;
}

interface ResponsesRequest {
  readonly instructions?: unknown;
  readonly input?: unknown;
  readonly tools?: unknown;
}

interface ModelInputItem {
  readonly type?: unknown;
  readonly role?: unknown;
  readonly call_id?: unknown;
  readonly output?: unknown;
  readonly content?: unknown;
}

interface ModelContentPart {
  readonly type?: unknown;
  readonly text?: unknown;
}

interface ModelTool {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly tools?: unknown;
}

interface ProxyCapture {
  readonly cwd: string;
  readonly argv: readonly string[];
}

interface ModelEvidence {
  requestCount: number;
  developerInstructionsExact: boolean;
  developerInstructionsBytes: number;
  developerInstructionsSha256: string;
  launchEnvelopeExact: boolean;
  modelVisibleLedgerTools: readonly string[];
  firstFetchMaterialized: boolean;
  secondFetchRejected: boolean;
  firstStoreAcknowledgement: string;
  retryStoreAcknowledgement: string;
  conflictingStoreRejected: boolean;
}

const liveTokens: string[] = [];

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`codex-role-dispatch probe: ${message}`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  requireCondition(typeof value === "string" && value.trim() !== "", `${name} is required`);
  return value;
}

function redact(text: string): string {
  let redacted = text;
  for (const token of liveTokens) redacted = redacted.split(token).join(REDACTED);
  return redacted;
}

function containsLiveToken(text: string): boolean {
  return liveTokens.some((token) => text.includes(token));
}

function serialized(value: unknown): string {
  const text = JSON.stringify(value);
  requireCondition(typeof text === "string", "expected a JSON-serializable value");
  return text;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

async function executable(name: string): Promise<string> {
  const located = Bun.which(name);
  requireCondition(located !== null, `required executable ${JSON.stringify(name)} was not found`);
  return realpath(located);
}

async function runChecked(argv: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn([...argv], {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  requireCondition(
    exitCode === 0,
    `${argv[0]} exited ${String(exitCode)}: ${redact(stderr).trim()}`,
  );
  return stdout.trim();
}

async function withEnvironment<T>(
  overrides: Readonly<Record<string, string>>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

class StdioJsonRpcClient {
  private readonly child: ReturnType<typeof Bun.spawn>;
  private readonly pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  private readonly stdoutPump: Promise<void>;
  private readonly stderrCapture: Promise<string>;
  private nextId = 1;
  private closed = false;

  constructor(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = Bun.spawn([command, ...args], {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.stdoutPump = this.pumpStdout();
    this.stderrCapture = new Response(this.child.stderr).text();
  }

  async initialize(): Promise<unknown> {
    const initialized = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t1493-codex-role-dispatch-probe", version: "1" },
    });
    this.notify("notifications/initialized", {});
    return initialized;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    requireCondition(!this.closed, "attempted an MCP request after closing the client");
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${serialized({ jsonrpc: "2.0", id, method, params })}\n`);
    this.child.stdin.flush();
    return response;
  }

  notify(method: string, params: unknown): void {
    requireCondition(!this.closed, "attempted an MCP notification after closing the client");
    this.child.stdin.write(`${serialized({ jsonrpc: "2.0", method, params })}\n`);
    this.child.stdin.flush();
  }

  callTool(name: string, args: unknown): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<string> {
    if (!this.closed) {
      this.closed = true;
      this.child.stdin.end();
      this.child.kill();
    }
    await Promise.all([this.child.exited, this.stdoutPump]);
    this.child.unref();
    return this.stderrCapture;
  }

  private async pumpStdout(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line !== "") this.acceptLine(line);
        }
      }
      buffered += decoder.decode();
      if (buffered.trim() !== "") this.acceptLine(buffered.trim());
      if (!this.closed && this.pending.size !== 0) {
        throw new Error("ledger MCP stdout closed with requests pending");
      }
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const pending of this.pending.values()) pending.reject(failure);
      this.pending.clear();
      if (!this.closed) throw failure;
    }
  }

  private acceptLine(line: string): void {
    const response = JSON.parse(line) as JsonRpcResponse;
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    requireCondition(
      pending !== undefined,
      `received an MCP response for unknown id ${response.id}`,
    );
    this.pending.delete(response.id);
    if (response.error !== undefined) {
      pending.reject(
        new Error(
          `ledger MCP JSON-RPC error ${String(response.error.code)}: ${String(response.error.message)}`,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }
}

function asToolResult(value: unknown): McpToolResult {
  requireCondition(typeof value === "object" && value !== null, "expected an MCP tool result");
  const result = value as Partial<McpToolResult>;
  requireCondition(Array.isArray(result.content), "expected MCP text content");
  return result as McpToolResult;
}

function toolText(value: unknown, expectError: boolean): string {
  const result = asToolResult(value);
  requireCondition(
    (result.isError === true) === expectError,
    expectError ? "expected the MCP tool call to fail" : "expected the MCP tool call to succeed",
  );
  const text = result.content
    .map((content) => {
      requireCondition(
        content.type === "text" && typeof content.text === "string",
        "expected text",
      );
      return content.text;
    })
    .join("\n");
  requireCondition(!containsLiveToken(text), "an MCP response exposed a live capability token");
  return text;
}

function decodeToolJson<T>(value: unknown): T {
  return JSON.parse(toolText(value, false)) as T;
}

function modelInput(request: ResponsesRequest): readonly ModelInputItem[] {
  requireCondition(Array.isArray(request.input), "model request input must be an array");
  return request.input as readonly ModelInputItem[];
}

function parseLaunchFromModel(request: ResponsesRequest): unknown {
  for (const item of modelInput(request)) {
    if (!Array.isArray(item.content)) continue;
    for (const partValue of item.content) {
      const part = partValue as ModelContentPart;
      if (part.type !== "input_text" || typeof part.text !== "string") continue;
      const text = part.text.trim();
      if (!text.startsWith("{") || !text.endsWith("}")) continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed === "object" && parsed !== null && "attestationId" in parsed) {
          return parsed;
        }
      } catch {
        continue;
      }
    }
  }
  throw new Error("codex-role-dispatch probe: launch envelope did not reach the model");
}

function developerInstructionParts(request: ResponsesRequest): readonly string[] {
  const parts: string[] = [];
  for (const item of modelInput(request)) {
    if (item.type !== "message" || item.role !== "developer" || !Array.isArray(item.content)) {
      continue;
    }
    for (const partValue of item.content) {
      const part = partValue as ModelContentPart;
      if (part.type === "input_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts;
}

function ledgerToolsFromModel(request: ResponsesRequest): readonly string[] {
  requireCondition(Array.isArray(request.tools), "model request tools must be an array");
  const namespace = (request.tools as readonly ModelTool[]).find(
    (tool) => tool.type === "namespace" && tool.name === "mcp__ledger",
  );
  requireCondition(
    namespace !== undefined && Array.isArray(namespace.tools),
    "ledger namespace missing",
  );
  return namespace.tools.map((value) => {
    const tool = value as ModelTool;
    requireCondition(typeof tool.name === "string", "ledger tool name must be a string");
    return tool.name;
  });
}

function functionOutput(request: ResponsesRequest, callId: string): string {
  const output = [...modelInput(request)]
    .reverse()
    .find((item) => item.type === "function_call_output" && item.call_id === callId);
  requireCondition(output !== undefined, `model request omitted output for ${callId}`);
  const text = typeof output.output === "string" ? output.output : serialized(output.output);
  requireCondition(
    !containsLiveToken(text),
    `tool output ${callId} exposed a live capability token`,
  );
  return text;
}

function modelMcpText(output: string): string {
  const marker = "\nOutput:\n";
  const markerIndex = output.indexOf(marker);
  requireCondition(markerIndex >= 0, "model tool output omitted its MCP payload");
  const content = JSON.parse(output.slice(markerIndex + marker.length)) as unknown;
  requireCondition(Array.isArray(content), "model MCP payload must be a content array");
  return content
    .map((value) => {
      const item = value as McpTextContent;
      requireCondition(item.type === "text" && typeof item.text === "string", "expected MCP text");
      return item.text;
    })
    .join("\n");
}

function completedResponse(id: string, output: readonly unknown[]): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: 1_785_504_000,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: MODEL_ID,
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: "high", summary: null },
    store: false,
    temperature: 0,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  };
}

function sseResponse(events: readonly Record<string, unknown>[]): Response {
  const body =
    events.map((event) => `event: ${String(event.type)}\ndata: ${serialized(event)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function functionCallResponse(requestIndex: number, toolName: string, args: unknown): Response {
  const responseId = `resp_t1493_${String(requestIndex)}`;
  const itemId = `fc_t1493_${String(requestIndex)}`;
  const callId = `call_t1493_${String(requestIndex)}`;
  const argumentsText = serialized(args);
  const item = {
    id: itemId,
    type: "function_call",
    status: "completed",
    call_id: callId,
    namespace: "mcp__ledger",
    name: toolName,
    arguments: argumentsText,
  };
  const response = completedResponse(responseId, [item]);
  return sseResponse([
    {
      type: "response.output_item.added",
      response_id: responseId,
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      response_id: responseId,
      output_index: 0,
      item_id: itemId,
      delta: argumentsText,
    },
    {
      type: "response.function_call_arguments.done",
      response_id: responseId,
      output_index: 0,
      item_id: itemId,
      name: toolName,
      arguments: argumentsText,
    },
    { type: "response.output_item.done", response_id: responseId, output_index: 0, item },
    { type: "response.completed", response },
  ]);
}

function finalMessageResponse(text: string): Response {
  const responseId = "resp_t1493_final";
  const itemId = "msg_t1493_final";
  const content = { type: "output_text", annotations: [], logprobs: [], text };
  const item = {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [content],
  };
  const response = completedResponse(responseId, [item]);
  return sseResponse([
    {
      type: "response.output_item.added",
      response_id: responseId,
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      response_id: responseId,
      output_index: 0,
      item_id: itemId,
      content_index: 0,
      part: { ...content, text: "" },
    },
    {
      type: "response.output_text.delta",
      response_id: responseId,
      output_index: 0,
      item_id: itemId,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      response_id: responseId,
      output_index: 0,
      item_id: itemId,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: "response.content_part.done",
      response_id: responseId,
      output_index: 0,
      item_id: itemId,
      content_index: 0,
      part: content,
    },
    { type: "response.output_item.done", response_id: responseId, output_index: 0, item },
    { type: "response.completed", response },
  ]);
}

function withLocalModelProvider(
  plan: CodexRoleBoundaryPlan,
  baseUrl: string,
): CodexRoleBoundaryPlan {
  const promptIndex = plan.argv.length - 1;
  requireCondition(plan.argv[promptIndex] === "-", "Codex boundary argv lost its stdin marker");
  return Object.freeze({
    ...plan,
    argv: Object.freeze([
      ...plan.argv.slice(0, promptIndex),
      "-c",
      'model_provider="t1493"',
      "-c",
      `model_providers.t1493={name="T1493 local control",base_url=${JSON.stringify(baseUrl)},env_key=${JSON.stringify(MODEL_API_KEY_ENV)},wire_api="responses"}`,
      "-",
    ]),
  });
}

function createModelController(
  roleInstructions: string,
  invocation: RoleInvocation,
): {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly evidence: ModelEvidence;
  readonly failure: () => Error | undefined;
} {
  const evidence: ModelEvidence = {
    requestCount: 0,
    developerInstructionsExact: false,
    developerInstructionsBytes: 0,
    developerInstructionsSha256: "",
    launchEnvelopeExact: false,
    modelVisibleLedgerTools: [],
    firstFetchMaterialized: false,
    secondFetchRejected: false,
    firstStoreAcknowledgement: "",
    retryStoreAcknowledgement: "",
    conflictingStoreRejected: false,
  };
  let endpointFailure: Error | undefined;

  return {
    evidence,
    failure: () => endpointFailure,
    async fetch(request: Request): Promise<Response> {
      try {
        const body = (await request.json()) as ResponsesRequest;
        const requestIndex = evidence.requestCount;
        evidence.requestCount += 1;
        if (requestIndex === 0) {
          const exactDeveloperInstructions = developerInstructionParts(body).filter(
            (part) => part === roleInstructions,
          );
          evidence.developerInstructionsExact = exactDeveloperInstructions.length === 1;
          const capturedDeveloperInstructions = exactDeveloperInstructions[0];
          if (capturedDeveloperInstructions !== undefined) {
            evidence.developerInstructionsBytes = Buffer.byteLength(
              capturedDeveloperInstructions,
              "utf8",
            );
            evidence.developerInstructionsSha256 = sha256(capturedDeveloperInstructions);
          }
          evidence.launchEnvelopeExact =
            serialized(parseLaunchFromModel(body)) ===
            serialized({
              attestationId: invocation.handle.attestationId,
              generation: invocation.handle.generation,
              inputCapability: invocation.inputCapability,
              resultCapability: invocation.resultCapability,
            });
          evidence.modelVisibleLedgerTools = sorted(ledgerToolsFromModel(body));
          return functionCallResponse(requestIndex, "fetch_dispatch_input", {
            ...invocation.handle,
            inputCapability: invocation.inputCapability,
          });
        }
        if (requestIndex === 1) {
          const output = functionOutput(body, "call_t1493_0");
          evidence.firstFetchMaterialized =
            output.includes("input-materialized") && output.includes("G1493");
          return functionCallResponse(requestIndex, "fetch_dispatch_input", {
            ...invocation.handle,
            inputCapability: invocation.inputCapability,
          });
        }
        if (requestIndex === 2) {
          const output = functionOutput(body, "call_t1493_1");
          evidence.secondFetchRejected = /already|one-shot|retriev|consum/i.test(output);
          return functionCallResponse(requestIndex, "store_result", {
            resultCapability: invocation.resultCapability,
            output: EXPECTED_RESULT,
          });
        }
        if (requestIndex === 3) {
          evidence.firstStoreAcknowledgement = modelMcpText(functionOutput(body, "call_t1493_2"));
          return functionCallResponse(requestIndex, "store_result", {
            resultCapability: invocation.resultCapability,
            output: EXPECTED_RESULT,
          });
        }
        if (requestIndex === 4) {
          evidence.retryStoreAcknowledgement = modelMcpText(functionOutput(body, "call_t1493_3"));
          return functionCallResponse(requestIndex, "store_result", {
            resultCapability: invocation.resultCapability,
            output: DIFFERENT_RESULT,
          });
        }
        if (requestIndex === 5) {
          const output = functionOutput(body, "call_t1493_4");
          evidence.conflictingStoreRejected = /different result|conflict|already stored/i.test(
            output,
          );
          return finalMessageResponse(invocation.handle.attestationId);
        }
        throw new Error(`unexpected model request ${String(requestIndex + 1)}`);
      } catch (error: unknown) {
        endpointFailure = error instanceof Error ? error : new Error(String(error));
        return new Response("T1493 local model control failure", { status: 500 });
      }
    },
  };
}

async function runLedgerProxy(): Promise<void> {
  const marker = process.argv.indexOf("--ledger-proxy");
  requireCondition(marker >= 0, "ledger proxy marker missing");
  const capturePath = process.argv[marker + 1];
  const realCq = process.argv[marker + 2];
  requireCondition(typeof capturePath === "string", "ledger proxy capture path missing");
  requireCondition(typeof realCq === "string", "ledger proxy CQ executable missing");
  const args = process.argv.slice(marker + 3);
  const capture: ProxyCapture = { cwd: process.cwd(), argv: args };
  await appendFile(capturePath, `${serialized(capture)}\n`, "utf8");
  const child = Bun.spawn([realCq, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  process.exit(exitCode);
}

function parseProxyCaptures(text: string): readonly ProxyCapture[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ProxyCapture);
}

function hasArgPair(args: readonly string[], flag: string, value: string): boolean {
  return args.some((arg, index) => arg === flag && args[index + 1] === value);
}

async function main(): Promise<void> {
  const packageRoot = path.resolve(import.meta.dir, "../../..");
  const promptRoot = await realpath(requiredEnvironment(PROMPT_ROOT_ENV));
  const roleArtifact = path.join(promptRoot, "roles", `${ROLE_ID}.md`);
  const roleInstructions = await readFile(roleArtifact, "utf8");
  const surface = JSON.parse(await readFile(path.join(promptRoot, "surface.json"), "utf8")) as {
    readonly surface?: unknown;
  };
  requireCondition(surface.surface === "codex", "CQ_PROMPT_ROOT must select a Codex prompt root");
  const codexExecutable = await executable("codex");
  const cqExecutable = await executable("cq");
  const codexVersion = await runChecked([codexExecutable, "--version"], packageRoot);
  const scratch = await mkdtemp(path.join(tmpdir(), "cq-t1493-codex-role-dispatch-"));
  const parentProject = path.join(scratch, "parent-project");
  const executionCwd = path.join(parentProject, ".claude", "worktrees", "plan-advance-probe");
  const codexHome = path.join(scratch, "codex-home");
  const xdgStateHome = path.join(scratch, "xdg-state");
  const ledgerCapturePath = path.join(scratch, "ledger-proxy.jsonl");
  const ledgerProxyPath = path.join(scratch, "cq-ledger-proxy");
  const probeScript = await realpath(import.meta.path);
  let parentClient: StdioJsonRpcClient | undefined;
  let modelServer: ReturnType<typeof Bun.serve> | undefined;
  let finalRecord: unknown;

  try {
    await Promise.all([
      mkdir(executionCwd, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
      mkdir(xdgStateHome, { recursive: true }),
    ]);
    await writeFile(
      path.join(parentProject, "cq.toml"),
      '[ledger]\n  backend = "xdg"\n  projectId = "t1493-codex-role-dispatch"\n',
      "utf8",
    );
    await runChecked(["git", "init", "--quiet"], parentProject);
    await writeFile(
      ledgerProxyPath,
      [
        "#!/bin/sh",
        `export XDG_STATE_HOME=${shellQuote(xdgStateHome)}`,
        `exec ${shellQuote(process.execPath)} ${shellQuote(probeScript)} --ledger-proxy ${shellQuote(ledgerCapturePath)} ${shellQuote(cqExecutable)} "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(ledgerProxyPath, 0o700);

    const sharedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_STATE_HOME: xdgStateHome,
      CODEX_HOME: codexHome,
      CQ_PROMPT_ROOT: promptRoot,
      CQ_PROMPT_SURFACE: "codex",
      CQ_HARNESS: "codex",
    };
    parentClient = new StdioJsonRpcClient(
      ledgerProxyPath,
      ["mcp", "--cwd", parentProject, "--prompt-surface", "codex", "--prompt-root", promptRoot],
      packageRoot,
      sharedEnv,
    );
    const initialization = (await parentClient.initialize()) as {
      readonly serverInfo?: { readonly name?: unknown };
    };
    requireCondition(
      initialization.serverInfo !== undefined && initialization.serverInfo.name === "ledger-mcp",
      "actual ledger MCP failed to initialize",
    );
    const toolList = (await parentClient.request("tools/list", {})) as {
      readonly tools?: readonly { readonly name?: unknown }[];
    };
    requireCondition(Array.isArray(toolList.tools), "parent ledger MCP omitted its tool list");
    const parentTools = toolList.tools.map((tool) => String(tool.name));
    for (const requiredTool of [
      "prepare_dispatch",
      "store_result",
      "confirm_dispatch_completion",
      "fetch_dispatch_result",
    ]) {
      requireCondition(
        parentTools.includes(requiredTool),
        `parent ledger MCP omitted ${requiredTool}`,
      );
    }

    const expectedChild = { childId: "child-t1493", runId: "run-t1493" } as const;
    const prepare = decodeToolJson<PreparedOutcome>(
      await parentClient.callTool("prepare_dispatch", {
        roleId: ROLE_ID,
        input: {
          goalId: "G1493",
          activeClaim: {
            goalId: "G1493",
            claimId: "claim_G1493_1",
            generation: 1,
            purpose: "initial",
          },
          currentDraftIdentity: null,
          latestReviewId: null,
        },
        idempotencyKey: "T1493-codex-role-dispatch-probe",
        timeoutMs: PROBE_TIMEOUT_MS,
        expectedChild,
      }),
    );
    requireCondition(
      prepare.accepted && prepare.prepared !== undefined,
      "dispatch preparation failed",
    );
    const prepared = prepare.prepared;
    liveTokens.push(prepared.inputCapability.token, prepared.resultCapability.token);
    const invocation: RoleInvocation = {
      roleId: ROLE_ID,
      handle: {
        attestationId: prepared.attestationId,
        generation: prepared.generation,
      },
      inputCapability: prepared.inputCapability,
      resultCapability: prepared.resultCapability,
      cwd: executionCwd,
      ledgerCwd: parentProject,
      model: MODEL_ID,
      reasoningEffort: "high",
      sandboxMode: "read-only",
      timeoutMs: PROBE_TIMEOUT_MS,
    };
    const controller = createModelController(roleInstructions, invocation);
    modelServer = Bun.serve({ port: 0, fetch: controller.fetch });
    const boundaryPlan = withLocalModelProvider(
      createCodexRoleBoundaryPlan({
        ...invocation,
        roleInstructions,
        promptRoot,
        ledgerCommand: ledgerProxyPath,
        codexExecutable,
      }),
      `http://127.0.0.1:${String(modelServer.port)}/v1`,
    );
    let verifiedHandle: RoleInvocation["handle"] | undefined;
    let boundaryFailure: Error | undefined;
    try {
      verifiedHandle = await withEnvironment(
        {
          XDG_STATE_HOME: xdgStateHome,
          CODEX_HOME: codexHome,
          CQ_PROMPT_ROOT: promptRoot,
          CQ_PROMPT_SURFACE: "codex",
          CQ_HARNESS: "codex",
          [MODEL_API_KEY_ENV]: "t1493-local-model-key",
        },
        () =>
          executeCodexRoleBoundary(boundaryPlan, {
            provider: createProcessWorksetEffectAdmissionProvider({
              command: cqExecutable,
              args: ["__workset-effect-provider", "--cwd", parentProject],
              cwd: parentProject,
              env: {
                ...process.env,
                XDG_STATE_HOME: xdgStateHome,
              },
            }),
            targetRef: "goals:G1493",
          }),
      );
    } catch (error: unknown) {
      boundaryFailure = error instanceof Error ? error : new Error(String(error));
    }
    const endpointFailure = controller.failure();
    requireCondition(
      endpointFailure === undefined,
      endpointFailure === undefined ? "model endpoint failed" : endpointFailure.message,
    );
    requireCondition(
      boundaryFailure === undefined,
      boundaryFailure === undefined
        ? "Codex boundary failed"
        : `${boundaryFailure.message} after ${String(controller.evidence.requestCount)} model requests`,
    );
    requireCondition(
      serialized(verifiedHandle) === serialized(invocation.handle),
      "dispatcher did not release only the verified handle",
    );

    const evidence = controller.evidence;
    requireCondition(
      evidence.requestCount === 6,
      "local model did not complete the six-response exchange",
    );
    requireCondition(
      evidence.developerInstructionsExact,
      `developer instructions differ from the role artifact: captured bytes=${String(evidence.developerInstructionsBytes)} sha256=${evidence.developerInstructionsSha256}; artifact bytes=${String(Buffer.byteLength(roleInstructions, "utf8"))} sha256=${sha256(roleInstructions)}`,
    );
    requireCondition(
      evidence.launchEnvelopeExact,
      "parent launch envelope did not reach Codex exactly",
    );
    requireCondition(
      serialized(evidence.modelVisibleLedgerTools) === serialized(sorted(EXPECTED_ROLE_TOOLS)),
      "Codex model received the wrong capability-filtered ledger tool profile",
    );
    requireCondition(
      evidence.firstFetchMaterialized,
      "first child input retrieval did not materialize input",
    );
    requireCondition(evidence.secondFetchRejected, "second child input retrieval did not fail");
    requireCondition(
      evidence.firstStoreAcknowledgement.includes("result-stored"),
      "first child result store did not succeed",
    );
    requireCondition(
      evidence.retryStoreAcknowledgement === evidence.firstStoreAcknowledgement,
      "identical child result retry did not return the same acknowledgement",
    );
    requireCondition(evidence.conflictingStoreRejected, "different child result did not conflict");

    const confirmed = decodeToolJson<{ readonly state?: unknown }>(
      await parentClient.callTool("confirm_dispatch_completion", {
        ...invocation.handle,
        nativeCompletion: {
          kind: "native-completion",
          actor: "trusted-parent",
          ...expectedChild,
          completedAt: new Date().toISOString(),
        },
        expectedProvenance: {
          roleId: prepared.promptProvenance.roleId,
          version: prepared.promptProvenance.version,
          promptDigest: prepared.promptProvenance.promptDigest,
          inputDigest: prepared.promptProvenance.inputDigest,
        },
      }),
    );
    requireCondition(
      confirmed.state === "consumed",
      "parent confirmation did not consume the result",
    );
    const terminalStoreError = toolText(
      await parentClient.callTool("store_result", {
        resultCapability: invocation.resultCapability,
        output: EXPECTED_RESULT,
      }),
      true,
    );
    requireCondition(
      /consumed|already|terminal|unknown result capability/i.test(terminalStoreError),
      "storage after terminalization did not fail for terminal state",
    );
    const firstFetch = decodeToolJson<{ readonly state?: unknown; readonly output?: unknown }>(
      await parentClient.callTool("fetch_dispatch_result", invocation.handle),
    );
    requireCondition(firstFetch.state === "consumed", "first parent result fetch was not consumed");
    requireCondition(
      serialized(firstFetch.output) === serialized(EXPECTED_RESULT),
      "first parent result fetch returned the wrong PlanStepResult",
    );
    const secondFetch = decodeToolJson<{ readonly state?: unknown; readonly output?: unknown }>(
      await parentClient.callTool("fetch_dispatch_result", invocation.handle),
    );
    requireCondition(
      secondFetch.state === "output-already-materialized" && secondFetch.output === undefined,
      "second parent result fetch did not report prior materialization",
    );

    const parentStderr = await parentClient.close();
    parentClient = undefined;
    requireCondition(
      !containsLiveToken(parentStderr),
      "parent ledger MCP stderr exposed a capability token",
    );
    const proxyArtifact = await readFile(ledgerCapturePath, "utf8");
    requireCondition(
      !containsLiveToken(proxyArtifact),
      "ledger proxy artifact exposed a capability token",
    );
    const captures = parseProxyCaptures(proxyArtifact);
    requireCondition(
      captures.length === 2,
      "expected exactly parent and child MCP initializations",
    );
    const parentCapture = captures.find((capture) => !capture.argv.includes("--tool-profile"));
    const childCapture = captures.find((capture) =>
      hasArgPair(capture.argv, "--tool-profile", ROLE_ID),
    );
    requireCondition(parentCapture !== undefined, "parent ledger MCP invocation was not captured");
    requireCondition(childCapture !== undefined, "child ledger MCP invocation was not captured");
    requireCondition(
      hasArgPair(parentCapture.argv, "--cwd", parentProject),
      "parent preparation did not resolve through ledgerCwd",
    );
    requireCondition(
      hasArgPair(childCapture.argv, "--cwd", parentProject),
      "child ledger MCP did not resolve through ledgerCwd",
    );
    requireCondition(
      hasArgPair(childCapture.argv, "--prompt-root", promptRoot),
      "child ledger MCP did not receive the selected prompt root",
    );
    requireCondition(
      childCapture.cwd === executionCwd,
      "child ledger MCP did not execute from cwd",
    );

    finalRecord = {
      probe: "codex-role-dispatch",
      status: "pass",
      roleId: ROLE_ID,
      codex: { executable: codexExecutable, version: codexVersion, remoteModelUsed: false },
      prompt: {
        selector: PROMPT_ROOT_ENV,
        mcpSelector: "--prompt-root",
        artifact: `roles/${ROLE_ID}.md`,
        sha256: sha256(roleInstructions),
        bytes: Buffer.byteLength(roleInstructions, "utf8"),
        developerInstructionsExact: true,
      },
      paths: {
        parentProject: "$TMP/parent-project",
        executionCwd: `$TMP/parent-project/.claude/worktrees/${path.basename(executionCwd)}`,
        distinct: parentProject !== executionCwd,
        childProcessCwdMatchesExecution: true,
      },
      parentRequest: {
        ledgerCwd: "$TMP/parent-project",
        resultCapability: {
          present: true,
          scope: invocation.resultCapability.scope,
          token: REDACTED,
        },
        inputCapability: {
          present: true,
          scope: invocation.inputCapability.scope,
          token: REDACTED,
        },
        exactLaunchFields: ["attestationId", "generation", "inputCapability", "resultCapability"],
      },
      ledgerMcp: {
        server: "ledger-mcp",
        actualProcessInitializations: captures.length,
        parentPreparedAgainstLedgerCwd: true,
        childInitializedAgainstLedgerCwd: true,
        childToolProfile: ROLE_ID,
        modelVisibleTools: evidence.modelVisibleLedgerTools,
      },
      lifecycle: {
        firstInputFetch: "input-materialized",
        secondInputFetch: "rejected",
        firstStore: "result-stored",
        identicalRetry: "same-acknowledgement-no-second-write",
        differentOutput: "conflict",
        finalMessage: "bare-attestation-id-normalized-to-handle",
        confirmation: "consumed",
        storeAfterTerminalization: "rejected",
        firstParentFetch: { state: "consumed", output: EXPECTED_RESULT },
        secondParentFetch: "output-already-materialized",
      },
      redaction: {
        marker: REDACTED,
        checked: [
          "codex-boundary-output",
          "parent-mcp-stderr",
          "ledger-proxy-artifact",
          "model-tool-outputs",
          "machine-record",
        ],
        capabilityTokensAbsent: true,
      },
    };
    const machineRecord = serialized(finalRecord);
    requireCondition(
      !containsLiveToken(machineRecord),
      "machine-readable record exposed a capability token",
    );
  } finally {
    if (modelServer !== undefined) modelServer.stop(true);
    if (parentClient !== undefined) await parentClient.close();
    await rm(scratch, { recursive: true, force: true });
  }

  requireCondition(finalRecord !== undefined, "probe produced no record");
  process.stdout.write(`${serialized(finalRecord)}\n`);
}

if (process.argv.includes("--ledger-proxy")) {
  await runLedgerProxy();
} else {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redact(message)}\n`);
    process.exit(1);
  });
}
