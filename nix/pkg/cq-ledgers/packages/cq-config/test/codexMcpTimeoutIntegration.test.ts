import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createCodexRoleBoundaryPlan,
  executeCodexRoleBoundary,
  type CodexRoleBoundaryPlan,
} from "@cq/config";
import {
  createStrictInMemoryWorksetEffectAdmissionProvider,
  readProcessIdentity,
} from "@cq/process-control";
import { parse as parseToml } from "smol-toml";

const HANDLE = {
  attestationId: "att_0123456789abcdefghijklmnopqrstuvwxyz",
  generation: 3,
} as const;
const INPUT_CAPABILITY = {
  scope: "fetch-input",
  token: "cq_input_0123456789abcdefghijklmnopqrstuvwxyz",
} as const;
const RESULT_CAPABILITY = {
  scope: "store-result",
  token: "cq_result_0123456789abcdefghijklmnopqrstuvwxyz",
} as const;
const GIT_CHANGE_CAPABILITY = {
  scope: "git-change",
  token: "cq_git_0123456789abcdefghijklmnopqrstuvwxyz",
} as const;
const PARENT_GATE_CAPABILITY = {
  scope: "parent-gate",
  token: "cq_parent_gate_0123456789abcdefghijklmnopqrstuvwxyz",
} as const;

const deployedTest = process.env["CQ_TEST_DEPLOYED_CQ"] === "1" ? test : test.skip;

function installedExecutable(name: string): Promise<string> {
  const selected = Bun.which(name);
  if (selected === null) throw new Error(`${name} is not installed on PATH`);
  return realpath(selected);
}

async function writeExecutable(file: string, source: string): Promise<void> {
  await writeFile(file, source);
  await chmod(file, 0o700);
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

async function proveInstalledBootstrap(root: string): Promise<void> {
  const cq = await installedExecutable("cq");
  const role = await installedExecutable("cq-codex-role");
  expect(path.dirname(cq)).toBe(path.dirname(role));
  expect(path.basename(cq)).toBe("cq");
  expect(path.basename(role)).toBe("cq-codex-role");

  const fixtureRoot = path.join(root, "installed");
  const worktree = path.join(fixtureRoot, "worktree");
  const fakeCodex = path.join(fixtureRoot, "fake-codex");
  const fakeCq = path.join(fixtureRoot, "fake-cq");
  const codexCapture = path.join(fixtureRoot, "codex.json");
  const providerCapture = path.join(fixtureRoot, "provider.jsonl");
  const parentCapture = path.join(fixtureRoot, "parent.json");
  const observation = path.join(fixtureRoot, "preturn.jsonl");
  await mkdir(worktree, { recursive: true });
  git(worktree, ["init", "--quiet"]);

  await writeExecutable(
    fakeCodex,
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const launch = JSON.parse(await Bun.stdin.text());
writeFileSync(process.env.CQ_D344_CODEX_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), launch }));
const handle = { attestationId: launch.attestationId, generation: launch.generation };
const acknowledgement = { state: "result-stored", result: { state: "result-stored", ...handle, storedAt: "2026-08-17T21:30:00.000Z", outputDigest: "${"a".repeat(64)}" } };
process.stdout.write([
  JSON.stringify({ type: "thread.started", thread_id: "d344-installed-thread" }),
  JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", server: "ledger", tool: "store_result" } }),
  JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "ledger", tool: "store_result", result: { content: [{ type: "text", text: JSON.stringify(acknowledgement) }] } } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(handle) } }),
  JSON.stringify({ type: "turn.completed", usage: {} }),
].join("\\n"));
`,
  );
  await writeExecutable(
    fakeCq,
    `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv.includes("__workset-effect-provider")) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const request = JSON.parse(line);
    appendFileSync(process.env.CQ_D344_PROVIDER_CAPTURE, JSON.stringify(request) + "\\n");
    process.stdout.write(JSON.stringify(request.op === "acquire" ? { ok: true, epoch: 7 } : { ok: true }) + "\\n");
    if (request.op === "release" || request.op === "abandon") break;
  }
  process.exit(0);
}
if (process.argv.includes("--parent-gate-finalize")) {
  const request = JSON.parse(await Bun.stdin.text());
  writeFileSync(process.env.CQ_D344_PARENT_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), request }));
  process.stdout.write(JSON.stringify({ state: "result-stored", attestationId: request.attestationId, generation: request.generation, storedAt: "2026-08-17T21:30:01.000Z", outputDigest: "${"a".repeat(64)}" }));
  process.exit(0);
}
throw new Error("unexpected fake cq invocation: " + process.argv.slice(2).join(" "));
`,
  );

  const request = {
    roleId: "implement-worker",
    handle: HANDLE,
    inputCapability: INPUT_CAPABILITY,
    resultCapability: RESULT_CAPABILITY,
    gitChangeCapability: GIT_CHANGE_CAPABILITY,
    parentGateCapability: PARENT_GATE_CAPABILITY,
    effectTargetRef: "tasks:T2192",
    cwd: worktree,
    ledgerCwd: worktree,
    model: "test-model",
    reasoningEffort: "high",
    sandboxMode: "workspace-write",
    timeoutMs: 2_000,
  } as const;
  const child = Bun.spawn([role], {
    cwd: worktree,
    env: {
      ...process.env,
      CQ_CODEX_EXECUTABLE: fakeCodex,
      CQ_CODEX_LEDGER_COMMAND: fakeCq,
      CQ_CODEX_ROLE_CORRELATION_ID: "d344-installed-boundary",
      CQ_CODEX_PRETURN_OBSERVATION_PATH: observation,
      CQ_D344_CODEX_CAPTURE: codexCapture,
      CQ_D344_PROVIDER_CAPTURE: providerCapture,
      CQ_D344_PARENT_CAPTURE: parentCapture,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual(HANDLE);

  const [preturnLine, outcomeLine] = (await readFile(observation, "utf8"))
    .trim()
    .split("\n");
  if (preturnLine === undefined || outcomeLine === undefined) {
    throw new Error("installed boundary did not emit both observations");
  }
  const preturn = JSON.parse(preturnLine) as Record<string, unknown>;
  expect(preturn).toMatchObject({
    kind: "cq-codex-effective-preturn",
    version: 2,
    roleId: "implement-worker",
    childWorkTimeoutMs: 2_000,
    storeResultSubmissionBudgetMs: 600_000,
    ledgerToolTimeoutSec: 600,
    postStoreSubmissionFinalizationMs: 300_000,
    outerBoundaryTimeoutMs: 902_000,
    parentGateWindowMs: 5_620_000,
  });
  expect(JSON.parse(outcomeLine)).toMatchObject({
    kind: "cq-codex-effective-outcome",
    handle: HANDLE,
  });

  const capture = JSON.parse(await readFile(codexCapture, "utf8")) as {
    readonly argv: string[];
    readonly launch: Record<string, unknown>;
  };
  const mcpOverride = capture.argv.find((arg) => arg.startsWith("mcp_servers.ledger="));
  if (mcpOverride === undefined) throw new Error("installed boundary omitted the ledger MCP override");
  const parsed = parseToml(mcpOverride) as {
    readonly mcp_servers: { readonly ledger: { readonly tool_timeout_sec?: number } };
  };
  expect(parsed.mcp_servers.ledger.tool_timeout_sec).toBe(600);
  expect(capture.launch).toMatchObject({
    attestationId: HANDLE.attestationId,
    generation: HANDLE.generation,
  });
  expect(JSON.stringify(capture.launch)).not.toContain(PARENT_GATE_CAPABILITY.token);

  const providerOperations = (await readFile(providerCapture, "utf8"))
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { readonly op: string }).op);
  expect(providerOperations).toEqual(["acquire", "register", "share", "settle", "release"]);
  const parent = JSON.parse(await readFile(parentCapture, "utf8")) as {
    readonly argv: string[];
    readonly request: Record<string, unknown>;
  };
  expect(parent.argv).toContain("--parent-gate-finalize");
  expect(parent.request).toEqual({ ...HANDLE, parentGateCapability: PARENT_GATE_CAPABILITY });
}

async function proveScaledPhaseDrain(
  root: string,
  phase: "store-result" | "post-store",
): Promise<void> {
  const phaseRoot = path.join(root, phase);
  const pidFile = path.join(phaseRoot, "pid");
  const drainedFile = path.join(phaseRoot, "drained");
  await mkdir(phaseRoot, { recursive: true });
  const base = createCodexRoleBoundaryPlan({
    roleId: "implement-worker",
    roleInstructions: "implement the task",
    handle: HANDLE,
    inputCapability: INPUT_CAPABILITY,
    resultCapability: RESULT_CAPABILITY,
    gitChangeCapability: GIT_CHANGE_CAPABILITY,
    parentGateCapability: PARENT_GATE_CAPABILITY,
    cwd: process.cwd(),
    ledgerCwd: root,
    model: "test-model",
    reasoningEffort: "high",
    sandboxMode: "workspace-write",
    timeoutMs: 1_500,
    promptRoot: root,
    ledgerCommand: "cq-not-launched",
    codexExecutable: process.execPath,
  });
  const started = JSON.stringify({
    type: "item.started",
    item: { type: "mcp_tool_call", server: "ledger", tool: "store_result" },
  });
  const stored = JSON.stringify({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "ledger",
      tool: "store_result",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              state: "gate-pending",
              result: {
                state: "gate-pending",
                ...HANDLE,
                submittedAt: "2026-08-17T21:30:02.000Z",
                outputDigest: "a".repeat(64),
              },
            }),
          },
        ],
      },
    },
  });
  const events = phase === "store-result" ? `${started}\n` : `${started}\n${stored}\n`;
  const script = [
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid))`,
    `process.stdout.write(${JSON.stringify(events)})`,
    `process.on("SIGTERM",()=>{require("node:fs").writeFileSync(${JSON.stringify(drainedFile)},"drained");process.exit(0)})`,
    "setInterval(()=>{},1000)",
  ].join(";");
  const plan: CodexRoleBoundaryPlan = {
    ...base,
    argv: [process.execPath, "-e", script],
    stdin: "",
    timeoutMs: 2_000,
    childWorkTimeoutMs: 1_500,
    effectivePreturn: {
      ...base.effectivePreturn,
      storeResultSubmissionBudgetMs: phase === "store-result" ? 200 : 1_500,
      postStoreSubmissionFinalizationMs: phase === "post-store" ? 200 : 1_500,
    } as unknown as CodexRoleBoundaryPlan["effectivePreturn"],
  };
  const provider = createStrictInMemoryWorksetEffectAdmissionProvider();
  await expect(
    executeCodexRoleBoundary(plan, { provider, targetRef: "tasks:T2192" }),
  ).rejects.toThrow(
    phase === "store-result"
      ? "store_result exceeded its 200 ms window"
      : "post-store finalization exceeded its 200 ms window",
  );
  const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
  expect(await readProcessIdentity(pid)).toBeNull();
  expect(await readFile(drainedFile, "utf8")).toBe("drained");
  expect(await provider.activeAdmissionCount()).toBe(0);
}

deployedTest(
  "D340 D343 bootstrap deployed stages the parent gate and drains every bounded phase [Behavioral-Active Blackbox-GoodCommunication]",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-d340-d343-bootstrap-"));
    try {
      await proveInstalledBootstrap(root);
      await proveScaledPhaseDrain(root, "store-result");
      await proveScaledPhaseDrain(root, "post-store");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
