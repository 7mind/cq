import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutWorksetCredentials } from "../src/worksetManagementCommand.js";

const DISPATCH_SCRIPT = fileURLToPath(
  new URL("../scripts/codex-role-dispatch.ts", import.meta.url),
);
const HANDLE = { attestationId: "att_t2844_boundary", generation: 1 } as const;
const PARENT_GATE_CAPABILITY = {
  scope: "parent-gate",
  token: "cq_parent_gate_t2844_boundary",
} as const;

async function writeExecutable(file: string, source: string): Promise<void> {
  await writeFile(file, source);
  await chmod(file, 0o700);
}

async function invoke(
  request: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", DISPATCH_SCRIPT], {
    cwd: request["cwd"] as string,
    env: withoutWorksetCredentials(environment),
    stdin: new Blob([`${JSON.stringify(request)}\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** D362 regression: a public boundary must fence the target before any child side effect. */
test(
  "D362 rejects a missing target before launch and queues exact native completion without child authority leakage [Behavioral-Active Blackbox-GoodCommunication]",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-t2844-boundary-"));
    const worktree = path.join(root, "worktree");
    const promptRoot = path.join(root, "prompts");
    const codex = path.join(root, "codex");
    const cq = path.join(root, "cq");
    const markers = path.join(root, "markers.jsonl");
    const codexCapture = path.join(root, "codex.json");
    const qualifierCapture = path.join(root, "qualifier.json");
    const coordinatorCapture = path.join(root, "coordinator.json");
    try {
      await mkdir(worktree);
      const git = spawnSync("git", ["init", "--quiet", worktree], { encoding: "utf8" });
      if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
      await writeFile(path.join(worktree, "cq.toml"), '[ledger]\nbackend = "xdg"\nprojectId = "t6419-rendered"\n');
      await mkdir(path.join(promptRoot, "roles"), { recursive: true });
      await writeFile(path.join(promptRoot, "roles", "implement-worker.md"), "Store one result.\n");
      await writeExecutable(
        codex,
        `#!/usr/bin/env node
const fs = require("node:fs");
const launch = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(process.env.T2844_MARKERS, "codex\\n");
fs.writeFileSync(process.env.T2844_CODEX_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), environment: process.env, launch }));
const handle = { attestationId: launch.attestationId, generation: launch.generation };
const staged = { state: "gate-pending", result: { state: "gate-pending", ...handle, submittedAt: "2026-08-26T15:00:00.000Z", outputDigest: "${"a".repeat(64)}" } };
process.stdout.write([JSON.stringify({type:"thread.started",thread_id:"t2844"}),JSON.stringify({type:"item.started",item:{type:"mcp_tool_call",server:"ledger",tool:"store_result"}}),JSON.stringify({type:"item.completed",item:{type:"mcp_tool_call",server:"ledger",tool:"store_result",result:{content:[{type:"text",text:JSON.stringify(staged)}]}}}),JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(handle)}}),JSON.stringify({type:"turn.completed",usage:{}})].join("\\n"));
`,
      );
      await writeExecutable(
        cq,
        `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const markers = process.env.T2844_MARKERS;
if (process.argv.includes("__workset-effect-provider")) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const request = JSON.parse(line);
    appendFileSync(markers, "provider:" + request.op + ":" + (request.targetRef ?? "") + "\\n");
    process.stdout.write(JSON.stringify(request.op === "acquire" ? {ok:true,epoch:1} : {ok:true}) + "\\n");
    if (request.op === "release" || request.op === "abandon") break;
  }
  process.exit(0);
}
const request = JSON.parse(await Bun.stdin.text());
const argv = process.argv.slice(2);
if (argv.includes("--implementation-candidate-qualify")) {
  appendFileSync(markers, "qualifier\\n");
  writeFileSync(process.env.T2844_QUALIFIER_CAPTURE, JSON.stringify({ argv, environment: process.env, request }));
  process.stdout.write(JSON.stringify(process.env.T2844_QUALIFICATION_STATE === "consumed"
    ? {state:"consumed",result:{state:"consumed",attestationId:request.attestationId,generation:request.generation,consumedAt:"2026-09-20T01:00:01.000Z",outputDigest:"${"a".repeat(64)}"}}
    : {state:"queued",attestationId:request.attestationId,generation:request.generation,partitionKey:"cq-implementation-queue:v1:t2844",outputDigest:"${"a".repeat(64)}",qualificationDigest:"${"b".repeat(64)}"}));
  process.exit(0);
}
if (argv.includes("--implementation-candidate-coordinate")) {
  appendFileSync(markers, "coordinator\\n");
  writeFileSync(process.env.T2844_COORDINATOR_CAPTURE, JSON.stringify({ argv, environment: process.env, request }));
  process.stdout.write(JSON.stringify({state:"empty",partitionKey:"cq-implementation-queue:v1:t2844",partitionRevision:1}));
  process.exit(0);
}
appendFileSync(markers, "unexpected:" + argv.join(" ") + "\\n");
process.exit(1);
`,
      );
      const request = {
        roleId: "implement-worker",
        handle: HANDLE,
        inputCapability: { scope: "fetch-input", token: "cq_input_t2844_boundary" },
        resultCapability: { scope: "store-result", token: "cq_result_t2844_boundary" },
        gitChangeCapability: { scope: "git-change", token: "cq_git_t2844_boundary" },
        parentGateCapability: PARENT_GATE_CAPABILITY,
        cwd: worktree,
        ledgerCwd: worktree,
        model: "boundary-control",
        reasoningEffort: "low",
        sandboxMode: "danger-full-access",
        timeoutMs: 10_000,
      } as const;
      const environment = {
        ...process.env,
        XDG_STATE_HOME: path.join(root, "xdg-state"),
        CQ_PROMPT_ROOT: promptRoot,
        CQ_CODEX_EXECUTABLE: codex,
        CQ_CODEX_LEDGER_COMMAND: cq,
        T2844_MARKERS: markers,
        T2844_CODEX_CAPTURE: codexCapture,
        T2844_QUALIFIER_CAPTURE: qualifierCapture,
        T2844_COORDINATOR_CAPTURE: coordinatorCapture,
        CQ_CODEX_ROLE_CORRELATION_ID: "t2844-correlation",
        CQ_CODEX_ROLE_EXPECTED_RUN_ID: "t2844-parent-run",
      };

      const missing = await invoke(request, environment);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain(
        "boundary invocation requires one canonical tasks/goals/defects/researches effect target",
      );
      await expect(Bun.file(markers).exists()).resolves.toBeFalse();

      const admitted = await invoke(
        { ...request, effectTargetRef: "tasks:T2844" },
        environment,
      );
      expect(admitted).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(admitted.stdout)).toEqual(HANDLE);

      const markerLines = (await readFile(markers, "utf8")).trim().split("\n");
      expect(markerLines.filter((line) => line === "provider:acquire:tasks:T2844")).toHaveLength(1);
      expect(markerLines.filter((line) => line === "codex")).toHaveLength(1);
      expect(markerLines.filter((line) => line === "qualifier")).toHaveLength(1);
      expect(markerLines.filter((line) => line === "coordinator")).toHaveLength(1);
      expect(markerLines.filter((line) => line.startsWith("unexpected:"))).toHaveLength(0);
      expect(markerLines.indexOf("provider:acquire:tasks:T2844")).toBeLessThan(
        markerLines.indexOf("codex"),
      );
      expect(markerLines.indexOf("codex")).toBeLessThan(markerLines.indexOf("qualifier"));
      expect(markerLines.indexOf("qualifier")).toBeLessThan(
        markerLines.indexOf("coordinator"),
      );

      const codexTransport = await readFile(codexCapture, "utf8");
      for (const forbidden of [
        "effectTargetRef",
        "tasks:T2844",
        "parentGateCapability",
        PARENT_GATE_CAPABILITY.token,
        "CQ_SERVE_TOKEN",
        "CQ_SERVE_MANAGEMENT_TOKEN",
        "CQ_LEDGER_REMOTE_TOKEN",
      ]) {
        expect(codexTransport).not.toContain(forbidden);
      }
      const qualifier = JSON.parse(await readFile(qualifierCapture, "utf8")) as {
        readonly argv: readonly string[];
        readonly environment: Readonly<Record<string, string>>;
        readonly request: Readonly<Record<string, unknown>>;
      };
      expect(qualifier.argv).toContain("--implementation-candidate-qualify");
      expect(qualifier.request).toMatchObject({
        ...HANDLE,
        roleId: "implement-worker",
        correlationId: "t2844-correlation",
        childThreadId: "t2844",
        expectedRunId: "t2844-parent-run",
        outcome: "completed",
        exitStatus: 0,
      });
      expect(Object.keys(qualifier.request).sort()).toEqual([
        "attestationId",
        "childThreadId",
        "correlationId",
        "exitStatus",
        "expectedRunId",
        "generation",
        "observedAt",
        "outcome",
        "promptDigest",
        "roleId",
      ]);
      expect(qualifier.request["observedAt"]).toEqual(expect.any(String));
      expect(qualifier.request["promptDigest"]).toMatch(/^[0-9a-f]{64}$/u);
      expect(qualifier.environment).not.toHaveProperty("CQ_CODEX_ROLE_EXPECTED_RUN_ID");
      const qualifierTransport = JSON.stringify(qualifier);
      for (const forbidden of [
        "effectTargetRef",
        "tasks:T2844",
        "parentGateCapability",
        PARENT_GATE_CAPABILITY.token,
        "CQ_SERVE_TOKEN",
        "CQ_SERVE_MANAGEMENT_TOKEN",
        "CQ_LEDGER_REMOTE_TOKEN",
      ]) {
        expect(qualifierTransport).not.toContain(forbidden);
      }
      const coordinator = JSON.parse(await readFile(coordinatorCapture, "utf8")) as {
        readonly argv: readonly string[];
        readonly environment: Readonly<Record<string, string>>;
        readonly request: Readonly<Record<string, unknown>>;
      };
      expect(coordinator.argv).toContain("--implementation-candidate-coordinate");
      expect(coordinator.request).toEqual({
        ...HANDLE,
        holderId: "att_t2844_boundary:1:installed-parent",
        parentGateCapability: PARENT_GATE_CAPABILITY,
        successorLaunch: {
          roleCommand: process.execPath,
          roleScript: DISPATCH_SCRIPT,
          ledgerCommand: cq,
          codexExecutable: codex,
          model: "boundary-control",
          reasoningEffort: "low",
          sandboxMode: "danger-full-access",
        },
      });
      for (const forbidden of [
        "effectTargetRef",
        "tasks:T2844",
        "CQ_SERVE_TOKEN",
        "CQ_SERVE_MANAGEMENT_TOKEN",
        "CQ_LEDGER_REMOTE_TOKEN",
      ]) {
        expect(JSON.stringify(coordinator.environment)).not.toContain(forbidden);
      }

      const consumedStart = markerLines.length;
      const consumed = await invoke(
        { ...request, effectTargetRef: "tasks:T2844" },
        { ...environment, T2844_QUALIFICATION_STATE: "consumed" },
      );
      expect(consumed).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(consumed.stdout)).toEqual(HANDLE);
      const consumedMarkers = (await readFile(markers, "utf8"))
        .trim()
        .split("\n")
        .slice(consumedStart);
      expect(consumedMarkers.filter((line) => line === "qualifier")).toHaveLength(1);
      expect(consumedMarkers.filter((line) => line === "coordinator")).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);
