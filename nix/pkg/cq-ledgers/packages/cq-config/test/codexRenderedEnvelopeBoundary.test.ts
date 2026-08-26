import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
    env: environment,
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
  "D362 rejects a missing target before launch and carries only parent authority to finalization [Behavioral-Active Blackbox-GoodCommunication]",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-t2844-boundary-"));
    const worktree = path.join(root, "worktree");
    const promptRoot = path.join(root, "prompts");
    const codex = path.join(root, "codex");
    const cq = path.join(root, "cq");
    const markers = path.join(root, "markers.jsonl");
    const codexCapture = path.join(root, "codex.json");
    const finalizerCapture = path.join(root, "finalizer.json");
    try {
      await mkdir(worktree);
      const git = spawnSync("git", ["init", "--quiet", worktree], { encoding: "utf8" });
      if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
      await writeFile(path.join(worktree, "cq.toml"), '[ledger]\nbackend = "fs"\n');
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
const stored = { state: "result-stored", result: { state: "result-stored", ...handle, storedAt: "2026-08-26T15:00:00.000Z", outputDigest: "${"a".repeat(64)}" } };
process.stdout.write([JSON.stringify({type:"thread.started",thread_id:"t2844"}),JSON.stringify({type:"item.started",item:{type:"mcp_tool_call",server:"ledger",tool:"store_result"}}),JSON.stringify({type:"item.completed",item:{type:"mcp_tool_call",server:"ledger",tool:"store_result",result:{content:[{type:"text",text:JSON.stringify(stored)}]}}}),JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(handle)}}),JSON.stringify({type:"turn.completed",usage:{}})].join("\\n"));
`,
      );
      await writeExecutable(
        cq,
        `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("__workset-effect-provider")) {
  const keepAlive = setInterval(() => {}, 1_000); let buffered = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffered += chunk; let boundary; while ((boundary = buffered.indexOf("\\n")) !== -1) { const request = JSON.parse(buffered.slice(0, boundary)); buffered = buffered.slice(boundary + 1); fs.appendFileSync(process.env.T2844_MARKERS, "provider:" + request.op + ":" + (request.targetRef ?? "") + "\\n"); process.stdout.write(JSON.stringify(request.op === "acquire" ? {ok:true,epoch:1} : {ok:true}) + "\\n"); } }); process.stdin.on("end", () => clearInterval(keepAlive));
} else if (process.argv.includes("--parent-gate-finalize")) { let body = ""; process.stdin.on("data", (chunk) => body += chunk); process.stdin.on("end", () => { const request = JSON.parse(body); fs.appendFileSync(process.env.T2844_MARKERS, "finalizer\\n"); fs.writeFileSync(process.env.T2844_FINALIZER_CAPTURE, JSON.stringify(request)); process.stdout.write(JSON.stringify({state:"result-stored",attestationId:request.attestationId,generation:request.generation,storedAt:"2026-08-26T15:00:01.000Z",outputDigest:"${"b".repeat(64)}"})); });
} else { process.exitCode = 1; }
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
        CQ_PROMPT_ROOT: promptRoot,
        CQ_CODEX_EXECUTABLE: codex,
        CQ_CODEX_LEDGER_COMMAND: cq,
        T2844_MARKERS: markers,
        T2844_CODEX_CAPTURE: codexCapture,
        T2844_FINALIZER_CAPTURE: finalizerCapture,
      };

      const missing = await invoke(request, environment);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain(
        "boundary invocation requires one canonical tasks/goals/defects/researches effect target",
      );
      await expect(Bun.file(markers).exists()).resolves.toBeFalse();

      const boundary = await readFile(DISPATCH_SCRIPT, "utf8");
      expect(boundary).toContain("targetRef: effectTargetRef");
      expect(boundary).toContain("parentGateCapability: invocation.parentGateCapability");
      expect(boundary).toContain("createProcessWorksetEffectAdmissionProvider");

      const admitted = await invoke(
        { ...request, effectTargetRef: "tasks:T2844" },
        environment,
      );
      expect(admitted).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(admitted.stdout)).toEqual(HANDLE);

      const markerLines = (await readFile(markers, "utf8")).trim().split("\n");
      expect(markerLines.filter((line) => line === "provider:acquire:tasks:T2844")).toHaveLength(1);
      expect(markerLines.filter((line) => line === "codex")).toHaveLength(1);
      expect(markerLines.filter((line) => line === "finalizer")).toHaveLength(1);
      expect(markerLines.indexOf("provider:acquire:tasks:T2844")).toBeLessThan(
        markerLines.indexOf("codex"),
      );
      expect(markerLines.indexOf("codex")).toBeLessThan(markerLines.indexOf("finalizer"));

      const codexTransport = await readFile(codexCapture, "utf8");
      for (const forbidden of [
        "effectTargetRef",
        "parentGateCapability",
        "CQ_SERVE_TOKEN",
        "CQ_SERVE_MANAGEMENT_TOKEN",
        "CQ_LEDGER_REMOTE_TOKEN",
      ]) {
        expect(codexTransport).not.toContain(forbidden);
      }
      expect(JSON.parse(await readFile(finalizerCapture, "utf8"))).toEqual({
        ...HANDLE,
        parentGateCapability: PARENT_GATE_CAPABILITY,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
