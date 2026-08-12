import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_READ_ONLY_SANDBOX_TMPDIR,
  CodexOperationalAbstentionError,
  SandboxPipeProbeError,
  argvWithSandboxTmpdir,
  createCodexRoleBoundaryPlan,
  executeCodexRoleBoundary,
  renderSandboxTmpdirOverride,
  requiresCodexSandboxPreflight,
  runCodexSandboxPipeProbe,
  type CodexRoleSandboxMode,
} from "@cq/config";

const HANDLE = {
  attestationId: "att_0123456789abcdefghijklmnopqrstuvwxyz",
  generation: 3,
} as const;
const CAPABILITY = {
  inputCapability: {
    scope: "fetch-input",
    token: "cq_input_0123456789abcdefghijklmnopqrstuvwxyz",
  },
  resultCapability: {
    scope: "store-result",
    token: "cq_result_0123456789abcdefghijklmnopqrstuvwxyz",
  },
} as const;
const FIXTURE = fileURLToPath(
  new URL("./fixtures/codex-sandbox-preflight.ts", import.meta.url),
);
const PROBE_TIMEOUT_MS = 30_000;
const BOUNDARY_TEST_TIMEOUT_MS = 60_000;
// The healthy fixture runs the real node probe against the host /dev/shm;
// only Linux provides it.
const DEV_SHM_AVAILABLE = existsSync("/dev/shm");

interface SandboxFixture {
  readonly root: string;
  readonly worktree: string;
  readonly fakeCodex: string;
  readonly argvLog: string;
  readonly env: NodeJS.ProcessEnv;
}

async function createSandboxFixture(mode: "healthy" | "broken" | "broken-tmpdir"): Promise<SandboxFixture> {
  const root = await mkdtemp(join(tmpdir(), "cq-codex-sandbox-preflight-"));
  const worktree = join(root, "worktree");
  const fakeCodex = join(root, "fake-codex");
  await mkdir(worktree);
  const git = spawnSync("git", ["init", "--quiet", worktree], { encoding: "utf8" });
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
  await writeFile(
    fakeCodex,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(FIXTURE)} "$@"\n`,
  );
  await chmod(fakeCodex, 0o700);
  const argvLog = join(root, "codex-argv.jsonl");
  return {
    root,
    worktree,
    fakeCodex,
    argvLog,
    env: {
      ...process.env,
      CQ_TEST_CODEX_SANDBOX_MODE: mode,
      CQ_TEST_CODEX_ARGV_LOG: argvLog,
    },
  };
}

async function withFixtureEnvironment<T>(
  fixture: SandboxFixture,
  operation: () => Promise<T>,
): Promise<T> {
  const names = ["CQ_TEST_CODEX_SANDBOX_MODE", "CQ_TEST_CODEX_ARGV_LOG"] as const;
  const previous = new Map<string, string | undefined>();
  for (const name of names) {
    previous.set(name, process.env[name]);
    const value = fixture.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function loggedArgvs(fixture: SandboxFixture): Promise<readonly string[][]> {
  const text = await readFile(fixture.argvLog, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as string[]);
}

function reviewerPlan(
  fixture: SandboxFixture,
  roleId: string,
  sandboxMode: CodexRoleSandboxMode,
) {
  return createCodexRoleBoundaryPlan({
    roleId,
    roleInstructions: `instructions:${roleId}`,
    handle: HANDLE,
    ...CAPABILITY,
    cwd: fixture.worktree,
    ledgerCwd: fixture.worktree,
    model: "fake-model",
    reasoningEffort: "high",
    sandboxMode,
    timeoutMs: 30_000,
    promptRoot: "/nix/store/codex-prompt-root",
    ledgerCommand: "cq-not-invoked-by-fake",
    codexExecutable: fixture.fakeCodex,
  });
}

async function expectProbeFailure(
  promise: Promise<unknown>,
  verdict: SandboxPipeProbeError["verdict"],
): Promise<SandboxPipeProbeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxPipeProbeError);
    const probeError = error as SandboxPipeProbeError;
    expect(probeError.verdict).toBe(verdict);
    return probeError;
  }
  throw new Error(`expected a SandboxPipeProbeError (${verdict})`);
}

describe("T1999 Codex sandbox pipe pre-flight (D266)", () => {
  test("scopes the pre-flight to read-only reviewer dispatches only", () => {
    expect(requiresCodexSandboxPreflight("implement-reviewer", "read-only")).toBe(true);
    expect(requiresCodexSandboxPreflight("plan-reviewer", "read-only")).toBe(true);
    expect(requiresCodexSandboxPreflight("implement-reviewer", "workspace-write")).toBe(false);
    expect(requiresCodexSandboxPreflight("implement-reviewer", "danger-full-access")).toBe(false);
    expect(requiresCodexSandboxPreflight("plan-advance", "read-only")).toBe(false);
    expect(requiresCodexSandboxPreflight("investigate-prober", "read-only")).toBe(false);
    expect(requiresCodexSandboxPreflight("implement-worker", "danger-full-access")).toBe(false);
  });

  test("splices the TMPDIR override ahead of the trailing stdin marker", () => {
    expect(renderSandboxTmpdirOverride("/dev/shm")).toBe(
      'shell_environment_policy.set.TMPDIR="/dev/shm"',
    );
    const spliced = argvWithSandboxTmpdir(["codex", "exec", "-c", 'model="m"', "-"], "/dev/shm");
    expect(spliced).toEqual([
      "codex",
      "exec",
      "-c",
      'model="m"',
      "-c",
      'shell_environment_policy.set.TMPDIR="/dev/shm"',
      "-",
    ]);
    expect(() => argvWithSandboxTmpdir(["codex", "exec"], "/dev/shm")).toThrow(
      SandboxPipeProbeError,
    );
  });

  test("fails with an explicit node-unavailable verdict when node is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-codex-sandbox-no-node-"));
    try {
      const error = await expectProbeFailure(
        runCodexSandboxPipeProbe({
          codexExecutable: "codex-not-invoked",
          cwd: root,
          env: { ...process.env, PATH: root },
          timeoutMs: PROBE_TIMEOUT_MS,
        }),
        "node-unavailable",
      );
      expect(error.message).toContain("must not pass vacuously");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!DEV_SHM_AVAILABLE)(
    "passes against a healthy boundary and reports the writable sandbox tmpfs",
    async () => {
      const fixture = await createSandboxFixture("healthy");
      try {
        const report = await runCodexSandboxPipeProbe({
          codexExecutable: fixture.fakeCodex,
          cwd: fixture.worktree,
          env: fixture.env,
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        expect(report.sandboxTmpdir).toBe(CODEX_READ_ONLY_SANDBOX_TMPDIR);
        expect(report.mkdtemp.startsWith(`${CODEX_READ_ONLY_SANDBOX_TMPDIR}/`)).toBe(true);
        const argvs = await loggedArgvs(fixture);
        expect(argvs).toHaveLength(1);
        expect(argvs[0]).toEqual([
          "sandbox",
          "-c",
          'sandbox_mode="read-only"',
          "-c",
          'shell_environment_policy.set.TMPDIR="/dev/shm"',
          "--",
          report.nodeExecutable,
          "-e",
          expect.any(String),
        ]);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  test("fails fast with the pipe-capture-lost verdict against the broken sandbox", async () => {
    const fixture = await createSandboxFixture("broken");
    try {
      const error = await expectProbeFailure(
        runCodexSandboxPipeProbe({
          codexExecutable: fixture.fakeCodex,
          cwd: fixture.worktree,
          env: fixture.env,
          timeoutMs: PROBE_TIMEOUT_MS,
        }),
        "pipe-capture-lost",
      );
      expect(error.message).toContain("uv_guess_handle");
      expect(error.message).toContain("UV_UNKNOWN_HANDLE");
      expect(error.message).toContain("openai/codex#18473");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails with the tmpdir-unwritable verdict when the override does not land", async () => {
    const fixture = await createSandboxFixture("broken-tmpdir");
    try {
      await expectProbeFailure(
        runCodexSandboxPipeProbe({
          codexExecutable: fixture.fakeCodex,
          cwd: fixture.worktree,
          env: fixture.env,
          timeoutMs: PROBE_TIMEOUT_MS,
        }),
        "tmpdir-unwritable",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test.skipIf(!DEV_SHM_AVAILABLE)(
    "a read-only reviewer dispatch probes first, then launches with the TMPDIR override",
    async () => {
      const fixture = await createSandboxFixture("healthy");
      try {
        const handle = await withFixtureEnvironment(fixture, () =>
          executeCodexRoleBoundary(reviewerPlan(fixture, "implement-reviewer", "read-only")),
        );
        expect(handle).toEqual(HANDLE);
        const argvs = await loggedArgvs(fixture);
        expect(argvs).toHaveLength(2);
        expect(argvs[0]?.[0]).toBe("sandbox");
        const execArgv = argvs[1];
        expect(execArgv?.[0]).toBe("exec");
        expect(execArgv?.[execArgv.length - 1]).toBe("-");
        const overrideIndex = execArgv?.indexOf(
          'shell_environment_policy.set.TMPDIR="/dev/shm"',
        );
        expect(overrideIndex).toBeGreaterThan(0);
        expect(execArgv?.[(overrideIndex ?? 0) - 1]).toBe("-c");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    BOUNDARY_TEST_TIMEOUT_MS,
  );

  test(
    "a read-only reviewer dispatch preserves pipe preflight refusal as an operational abstention",
    async () => {
      const fixture = await createSandboxFixture("broken");
      try {
        let thrown: unknown;
        try {
          await withFixtureEnvironment(fixture, () =>
            executeCodexRoleBoundary(reviewerPlan(fixture, "implement-reviewer", "read-only")),
          );
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(CodexOperationalAbstentionError);
        const error = thrown as CodexOperationalAbstentionError;
        expect(error.message).toContain("openai/codex#18473");
        expect(error.operationalAbstention).toEqual({
          source: "sandbox-preflight",
          verdict: "pipe-capture-lost",
        });
        const argvs = await loggedArgvs(fixture);
        expect(argvs).toHaveLength(1);
        expect(argvs[0]?.[0]).toBe("sandbox");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    BOUNDARY_TEST_TIMEOUT_MS,
  );

  test(
    "a non-reviewer read-only dispatch skips the probe and the TMPDIR override",
    async () => {
      const fixture = await createSandboxFixture("broken");
      try {
        const handle = await withFixtureEnvironment(fixture, () =>
          executeCodexRoleBoundary(reviewerPlan(fixture, "plan-advance", "read-only")),
        );
        expect(handle).toEqual(HANDLE);
        const argvs = await loggedArgvs(fixture);
        expect(argvs).toHaveLength(1);
        expect(argvs[0]?.[0]).toBe("exec");
        expect(argvs[0]?.join("\n")).not.toContain("shell_environment_policy");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    BOUNDARY_TEST_TIMEOUT_MS,
  );

  test(
    "a danger-full-access reviewer dispatch skips the probe",
    async () => {
      const fixture = await createSandboxFixture("broken");
      try {
        const handle = await withFixtureEnvironment(fixture, () =>
          executeCodexRoleBoundary(reviewerPlan(fixture, "implement-reviewer", "danger-full-access")),
        );
        expect(handle).toEqual(HANDLE);
        const argvs = await loggedArgvs(fixture);
        expect(argvs).toHaveLength(1);
        expect(argvs[0]?.[0]).toBe("exec");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    BOUNDARY_TEST_TIMEOUT_MS,
  );
});
