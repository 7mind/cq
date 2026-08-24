/** T2042 — packaged cq-codex-role broker/confinement acceptance probe. */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FsAttestationBackend,
  CODEX_PROVIDER_FAILURE_CONTROLS,
  authenticateCodexProviderGateObservation,
  buildPositiveOnlyDispatchRegistry,
  createCodexRoleBoundaryPlan,
  createNativeDispatchAdapter,
  executeCodexProviderSandboxControl,
  executeCodexRoleBoundary,
  executeInstalledCodexRoleBoundary,
  implementConflictResolverSidecar,
  implementReviewerSidecar,
  qualifyCodexNativeAdapter,
  sequentialDispatchRandomBytes,
  type CodexInstalledIdentity,
  type CodexInstalledRoleBoundaryExecution,
  type CodexRoleBoundaryExecutionResult,
  type ConsumedDispatchResult,
  type DispatchPrepared,
} from "@cq/config";
import {
  createLedgerStore,
  createInMemoryWorksetStore,
  fsAttestationProductionRoot,
  ImplementationEvidenceService,
  observeManagedRebaseConflict,
  prepareManagedWorktree,
  releaseManagedWorktree,
  resolveManagedWorktreeDispatchBinding,
  resolveSingleProjectAttestationNamespace,
  worksetEffectAdmissionProviderFromStore,
  nodeSupervisedWorkerGateRunner,
  TASKS_LEDGER,
  type DispatchBoundGitAuthorization,
  type ImplementationReviewerIdentity,
  type ManagedWorktreeHandle,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const roots: string[] = [];
const INSTALLED_ROLE = process.env["CQ_TEST_CODEX_ROLE_EXECUTABLE"];
const SUBSTITUTED_ROLE = process.env["CQ_TEST_SUBSTITUTED_CODEX_ROLE_EXECUTABLE"];
const INSTALLED_CODEX = process.env["CQ_TEST_CODEX_SANDBOX_EXECUTABLE"];
const installedGateTest =
  INSTALLED_ROLE === undefined || SUBSTITUTED_ROLE === undefined || INSTALLED_CODEX === undefined
    ? test.skip
    : test;

function codexWorksetEffect(targetRef: string) {
  return {
    provider: worksetEffectAdmissionProviderFromStore(createInMemoryWorksetStore()),
    targetRef,
  } as const;
}
const WORKER_FIXTURE = fileURLToPath(new URL("./fixtures/codexBrokerWorker.ts", import.meta.url));
const RESOLVER_FIXTURE = fileURLToPath(
  new URL("./fixtures/codexBrokerResolver.ts", import.meta.url),
);
const REVIEWER_FIXTURE = fileURLToPath(
  new URL("./fixtures/codexBrokerReviewer.ts", import.meta.url),
);

function rejected(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn([process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git", ...args], {
    cwd,
    env: {
      ...globalThis.process.env,
      GIT_AUTHOR_NAME: "T2042",
      GIT_AUTHOR_EMAIL: "t2042@example.invalid",
      GIT_COMMITTER_NAME: "T2042",
      GIT_COMMITTER_EMAIL: "t2042@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

function artifactStore(
  roleId: "implement-worker" | "implement-conflict-resolver" | "implement-reviewer",
): PromptArtifactStore {
  const bytes =
    INSTALLED_ROLE === undefined
      ? new Uint8Array([1])
      : readFileSync(
          path.join(
            path.dirname(path.dirname(INSTALLED_ROLE)),
            "share/cq/prompt-surfaces/codex/roles",
            `${roleId}.md`,
          ),
        );
  const metadata = {
    roleId,
    roleKind: "dispatched-subagent" as const,
    artifactPath: `roles/${roleId}.md`,
    sidecarSchemaRoleId: roleId,
    promptSurface: "codex" as const,
    promptDigest: createHash("sha256").update(bytes).digest("hex"),
    schemaVersion:
      roleId === "implement-worker"
        ? 8
        : roleId === "implement-reviewer"
          ? implementReviewerSidecar.version
          : implementConflictResolverSidecar.version,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: "codex",
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes }),
  };
}

async function selectedExecutableSelfIdentity(executable: string): Promise<CodexInstalledIdentity> {
  return {
    storePath: path.dirname(path.dirname(executable)),
    executablePath: executable,
    executableDigest: createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
  };
}

type PackagedWorkerRoute = "native" | "process";
type PackagedReviewerMode = "sandboxed" | "non-sandboxed";

interface PackagedReviewerMatrixRow {
  readonly workerRoute: PackagedWorkerRoute;
  readonly reviewerMode: PackagedReviewerMode;
  readonly verdict: "approve";
  readonly gateReRan: boolean;
  readonly evidenceForwarded: boolean;
  readonly fastForwardEligible: true;
}

interface PackagedReviewerGateRun extends PackagedReviewerMatrixRow {
  readonly dispatch: DispatchPrepared;
  readonly consumed: ConsumedDispatchResult;
}

async function runPackagedReviewer(input: {
  readonly repositoryRoot: string;
  readonly managedHandle: ManagedWorktreeHandle;
  readonly baseCommit: string;
  readonly backend: FsAttestationBackend;
  readonly randomBytes: (count: number) => Uint8Array;
  readonly workerRoute: PackagedWorkerRoute;
  readonly reviewerMode: PackagedReviewerMode;
  readonly workerResult: ConsumedDispatchResult;
}): Promise<PackagedReviewerGateRun> {
  if (INSTALLED_ROLE === undefined || INSTALLED_CODEX === undefined) {
    throw new Error("installed reviewer gate was not selected");
  }
  const {
    repositoryRoot,
    managedHandle,
    baseCommit,
    backend,
    randomBytes,
    workerRoute,
    reviewerMode,
    workerResult,
  } = input;
  if (
    workerResult.output === null ||
    typeof workerResult.output !== "object" ||
    Array.isArray(workerResult.output)
  ) {
    throw new Error("consumed worker result is not an object");
  }
  const workerOutput = workerResult.output as Record<string, unknown>;
  const resultCommit = String(workerOutput["resultCommit"]);
  const supervisedGateEvidence = workerOutput["supervisedGateEvidence"];
  if (supervisedGateEvidence === undefined) {
    throw new Error("consumed worker result lacks runner-owned evidence");
  }
  const dispatchNow = new Date().toISOString();
  const capability = createDispatchCapability({
    backend,
    promptArtifactStore: artifactStore("implement-reviewer"),
    now: () => dispatchNow,
    randomBytes,
  });
  const expectedChild = {
    childId: `t2081-review-${workerRoute}-${reviewerMode}-child`,
    runId: `t2081-review-${workerRoute}-${reviewerMode}-run`,
  };
  const prepared = await capability.prepare({
    roleId: "implement-reviewer",
    input: JSON.parse(
      JSON.stringify({
        taskId: managedHandle.taskId,
        headline: "installed worker and reviewer matrix",
        description: "review one consumed exact-tip worker result",
        acceptance: "only a green exact-tip worker result receives approval",
        worktreePath: managedHandle.absolutePath,
        branch: managedHandle.branch,
        baseCommit,
        workerResult: workerOutput,
        round: 1,
        ...(reviewerMode === "sandboxed" ? { supervisedGateEvidence } : {}),
      }),
    ),
    idempotencyKey: `T2081-review-${workerRoute}-${reviewerMode}`,
    timeoutMs: 600_000,
    expectedChild,
  });
  if (!prepared.accepted) throw new Error("packaged reviewer dispatch was rejected");

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "t2081-packaged-reviewer-fake-"));
  roots.push(fixtureRoot);
  const fakeCodex = path.join(fixtureRoot, "fake-codex");
  const capturePath = path.join(fixtureRoot, `review-${workerRoute}-${reviewerMode}-capture.json`);
  const reviewerStderrPath = path.join(fixtureRoot, "reviewer.stderr");
  const sandboxStdoutPath = path.join(fixtureRoot, "sandbox.stdout");
  const sandboxStderrPath = path.join(fixtureRoot, "sandbox.stderr");
  const sandboxCapture = path.join(fixtureRoot, "sandbox-capture");
  await writeFile(
    sandboxCapture,
    '#!/bin/sh\n"$@" >"$CQ_T2081_SANDBOX_STDOUT" 2>"$CQ_T2081_SANDBOX_STDERR"\n',
  );
  await chmod(sandboxCapture, 0o700);
  const sandboxProfile =
    `permissions.t2081={description="T2081 installed reviewer fixture",filesystem={` +
    `":minimal"="read","/tmp"="write",${JSON.stringify(repositoryRoot)}="read",` +
    `${JSON.stringify(path.join(repositoryRoot, ".cq", "attestations"))}="write",` +
    `${JSON.stringify(fixtureRoot)}="write"}}`;
  await writeFile(
    fakeCodex,
    [
      "#!/bin/sh",
      "set -u",
      `export CQ_T2081_INSTALLED_CODEX=${JSON.stringify(INSTALLED_CODEX)}`,
      `export CQ_T2081_REVIEW_MODE=${JSON.stringify(reviewerMode)}`,
      `export CQ_T2081_REVIEW_WORKTREE=${JSON.stringify(managedHandle.absolutePath)}`,
      `export CQ_T2081_SANDBOX_PROFILE=${JSON.stringify(sandboxProfile)}`,
      `export CQ_T2081_SANDBOX_CAPTURE=${JSON.stringify(sandboxCapture)}`,
      `export CQ_T2081_SANDBOX_STDOUT=${JSON.stringify(sandboxStdoutPath)}`,
      `export CQ_T2081_SANDBOX_STDERR=${JSON.stringify(sandboxStderrPath)}`,
      "run_sandbox() {",
      '  rm -f "$CQ_T2081_SANDBOX_STDOUT" "$CQ_T2081_SANDBOX_STDERR"',
      '  "$CQ_T2081_INSTALLED_CODEX" -c \'default_permissions="t2081"\' -c "$CQ_T2081_SANDBOX_PROFILE" sandbox -P t2081 -C "$CQ_T2081_REVIEW_WORKTREE" -- "$CQ_T2081_SANDBOX_CAPTURE" "$@"',
      "  status=$?",
      '  test ! -e "$CQ_T2081_SANDBOX_STDOUT" || cat "$CQ_T2081_SANDBOX_STDOUT"',
      '  test ! -e "$CQ_T2081_SANDBOX_STDERR" || cat "$CQ_T2081_SANDBOX_STDERR" >&2',
      "  return $status",
      "}",
      'if test "$1" = sandbox; then',
      '  while test "$1" != --; do shift; done',
      "  shift",
      '  exec "$@"',
      "fi",
      'if test "$CQ_T2081_REVIEW_MODE" = sandboxed; then',
      `  run_sandbox ${JSON.stringify(process.execPath)} run ${JSON.stringify(REVIEWER_FIXTURE)} "$@"`,
      "  exit $?",
      "fi",
      `exec ${JSON.stringify(process.execPath)} run ${JSON.stringify(REVIEWER_FIXTURE)} "$@" 2>"$CQ_T2081_REVIEW_STDERR"`,
      "",
    ].join("\n"),
  );
  await chmod(fakeCodex, 0o700);
  const ledgerCommand = path.join(path.dirname(INSTALLED_ROLE), "cq");
  const handle = {
    attestationId: prepared.prepared.attestationId,
    generation: prepared.prepared.generation,
  };
  const invocation = {
    roleId: "implement-reviewer",
    handle,
    inputCapability: prepared.prepared.inputCapability,
    resultCapability: prepared.prepared.resultCapability,
    cwd: managedHandle.absolutePath,
    ledgerCwd: repositoryRoot,
    model: "test-model",
    reasoningEffort: "high",
    sandboxMode:
      reviewerMode === "sandboxed" ? ("read-only" as const) : ("workspace-write" as const),
    timeoutMs: 30_000,
  };
  const environment = {
    ...process.env,
    CQ_CODEX_EXECUTABLE: fakeCodex,
    CQ_CODEX_LEDGER_COMMAND: ledgerCommand,
    CQ_T2081_REVIEW_CAPTURE: capturePath,
    CQ_T2081_REVIEW_MODE: reviewerMode,
    CQ_T2081_REVIEW_WORKTREE: managedHandle.absolutePath,
    CQ_T2081_REVIEW_LEDGER_ROOT: repositoryRoot,
    CQ_T2081_REVIEW_STDERR: reviewerStderrPath,
    CQ_T2081_INSTALLED_CODEX: INSTALLED_CODEX,
    CQ_T2081_SANDBOX_PROFILE: sandboxProfile,
    CQ_T2081_SANDBOX_CAPTURE: sandboxCapture,
    CQ_T2081_SANDBOX_STDOUT: sandboxStdoutPath,
    CQ_T2081_SANDBOX_STDERR: sandboxStderrPath,
  };
  try {
    await executeCodexRoleBoundary(
      createCodexRoleBoundaryPlan({
        ...invocation,
        roleInstructions: await readFile(
          path.join(
            path.dirname(path.dirname(INSTALLED_ROLE)),
            "share/cq/prompt-surfaces/codex/roles/implement-reviewer.md",
          ),
          "utf8",
        ),
        promptRoot: path.join(
          path.dirname(path.dirname(INSTALLED_ROLE)),
          "share/cq/prompt-surfaces/codex",
        ),
        ledgerCommand,
        codexExecutable: fakeCodex,
      }),
      `t2081-review-${workerRoute}-${reviewerMode}`,
      environment,
      codexWorksetEffect("tasks:T2081"),
    );
  } catch (error) {
    const fixtureStderr = await readFile(reviewerStderrPath, "utf8").catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${fixtureStderr}`);
  }
  const confirmed = await capability.confirmCompletion({
    ...handle,
    nativeCompletion: {
      kind: "native-completion",
      actor: "trusted-parent",
      ...expectedChild,
      completedAt: dispatchNow,
    },
    expectedProvenance: prepared.prepared.promptProvenance,
  });
  expect(confirmed.state).toBe("consumed");
  const fetched = await capability.fetch(handle);
  if (fetched.state !== "consumed") throw new Error(`unexpected reviewer state ${fetched.state}`);
  const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
    boundary: { listedTools: string[]; sandboxMode: string; directGitDenied: boolean };
    inputEvidence: { supervised: boolean; parent: boolean };
    gate: { gateExitCode: number; passCount: number; failCount: number; gateReRan: boolean };
    output: Record<string, unknown>;
  };
  expect(capture.boundary).toMatchObject({
    listedTools: ["fetch_dispatch_input", "store_result"],
    sandboxMode: reviewerMode === "sandboxed" ? "read-only" : "workspace-write",
    directGitDenied: reviewerMode === "sandboxed",
  });
  expect(capture.inputEvidence).toEqual({
    supervised: reviewerMode === "sandboxed",
    parent: false,
  });
  expect(capture.gate).toMatchObject({
    gateExitCode: 0,
    passCount: 1,
    failCount: 0,
    gateReRan: reviewerMode === "non-sandboxed",
  });
  expect(capture.output).toMatchObject({
    taskId: managedHandle.taskId,
    verdict: "approve",
    criticism: [],
    questions: [],
    gateReRan: reviewerMode === "non-sandboxed",
    resultCommitVerified: true,
    resultCommitEvidence: {
      status: "verified",
      resultCommit,
      branchTip: resultCommit,
    },
    baseAncestry: {
      status: "verified",
      baseCommit,
      resultCommit,
      mergeBase: baseCommit,
    },
  });
  expect(JSON.stringify(fetched.output)).toBe(JSON.stringify(capture.output));
  expect(
    await git(managedHandle.absolutePath, ["rev-parse", "--verify", managedHandle.branch]),
  ).toBe(resultCommit);
  await git(managedHandle.absolutePath, ["merge-base", "--is-ancestor", baseCommit, resultCommit]);
  return {
    workerRoute,
    reviewerMode,
    verdict: "approve",
    gateReRan: reviewerMode === "non-sandboxed",
    evidenceForwarded: reviewerMode === "sandboxed",
    fastForwardEligible: true,
    dispatch: prepared.prepared,
    consumed: fetched,
  };
}

interface PackagedResolverGateRun<R extends "native" | "process"> {
  readonly route: R;
  readonly execution: R extends "native"
    ? CodexRoleBoundaryExecutionResult
    : CodexInstalledRoleBoundaryExecution;
  readonly consumed: ConsumedDispatchResult;
  readonly resultCommit: string;
}

async function runPackagedResolverGate<R extends "native" | "process">(input: {
  readonly repositoryRoot: string;
  readonly managedHandle: ManagedWorktreeHandle;
  readonly baseCommit: string;
  readonly backend: FsAttestationBackend;
  readonly randomBytes: (count: number) => Uint8Array;
  readonly route: R;
}): Promise<PackagedResolverGateRun<R>> {
  if (INSTALLED_ROLE === undefined) throw new Error("installed resolver gate was not selected");
  const { repositoryRoot, managedHandle, baseCommit, backend, randomBytes, route } = input;
  const binding = await resolveManagedWorktreeDispatchBinding({
    repositoryRoot,
    taskId: managedHandle.taskId,
    worktreePath: managedHandle.absolutePath,
    branch: managedHandle.branch,
  });
  if (binding === null) throw new Error("resolver managed binding did not resolve");

  await writeFile(path.join(managedHandle.absolutePath, "a.txt"), `task a ${route}\n`);
  await git(managedHandle.absolutePath, ["add", "a.txt"]);
  await git(managedHandle.absolutePath, ["commit", "-q", "-m", "task a"]);
  await writeFile(path.join(managedHandle.absolutePath, "b.txt"), `task b ${route}\n`);
  await git(managedHandle.absolutePath, ["add", "b.txt"]);
  await git(managedHandle.absolutePath, ["commit", "-q", "-m", "task b"]);
  await writeFile(path.join(repositoryRoot, "a.txt"), `base changed a ${route}\n`);
  await writeFile(path.join(repositoryRoot, "b.txt"), `base changed b ${route}\n`);
  await git(repositoryRoot, ["add", "a.txt", "b.txt"]);
  await git(repositoryRoot, ["commit", "-q", "-m", "base changes"]);
  const onto = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const rebase = Bun.spawnSync(["git", "rebase", onto], {
    cwd: managedHandle.absolutePath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (rebase.exitCode === 0) throw new Error("seeded packaged resolver rebase did not conflict");
  const observerAuthorization: DispatchBoundGitAuthorization = {
    ...binding,
    attestationId: "cq_attest_RRRRRRRRRRRRRRRRRRRRRR",
    generation: 1,
    roleId: "implement-conflict-resolver",
    surface: "codex",
    childCancelAt: "2099-01-01T00:00:00.000Z",
  };
  const conflictState = await observeManagedRebaseConflict(observerAuthorization, {});

  const dispatchNow = new Date().toISOString();
  const capability = createDispatchCapability({
    backend,
    promptArtifactStore: artifactStore("implement-conflict-resolver"),
    repositoryRoot,
    now: () => dispatchNow,
    randomBytes,
  });
  const expectedChild = {
    childId: `t2044-packaged-resolver-${route}-child`,
    runId: `t2044-packaged-resolver-${route}-run`,
  };
  const prepared = await capability.prepare({
    roleId: "implement-conflict-resolver",
    input: JSON.parse(
      JSON.stringify({
        taskId: managedHandle.taskId,
        worktreePath: managedHandle.absolutePath,
        branch: managedHandle.branch,
        baseCommit,
        conflictingFiles: ["a.txt"],
        conflictState,
      }),
    ),
    idempotencyKey: `${managedHandle.taskId}-packaged-resolver-${route}`,
    timeoutMs: 600_000,
    expectedChild,
  });
  if (!prepared.accepted || prepared.prepared.gitConflictCapability === undefined) {
    throw new Error("packaged resolver dispatch did not receive Git conflict capability");
  }

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "t2044-packaged-resolver-fake-"));
  roots.push(fixtureRoot);
  const fakeCodex = path.join(fixtureRoot, "fake-codex");
  const capturePath = path.join(fixtureRoot, `resolver-${route}-capture.json`);
  const resolverStderrPath = path.join(fixtureRoot, `resolver-${route}.stderr`);
  await writeFile(
    fakeCodex,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(RESOLVER_FIXTURE)} "$@" 2>"$CQ_T2044_RESOLVER_STDERR"\n`,
  );
  await chmod(fakeCodex, 0o700);
  const ledgerCommand = path.join(path.dirname(INSTALLED_ROLE), "cq");
  const handle = {
    attestationId: prepared.prepared.attestationId,
    generation: prepared.prepared.generation,
  };
  const invocation = {
    roleId: "implement-conflict-resolver",
    handle,
    inputCapability: prepared.prepared.inputCapability,
    resultCapability: prepared.prepared.resultCapability,
    gitConflictCapability: prepared.prepared.gitConflictCapability,
    cwd: managedHandle.absolutePath,
    ledgerCwd: repositoryRoot,
    model: "test-model",
    reasoningEffort: "high",
    sandboxMode: "workspace-write" as const,
    timeoutMs: 30_000,
  };
  let execution: CodexInstalledRoleBoundaryExecution | CodexRoleBoundaryExecutionResult;
  try {
    const environment = {
      ...process.env,
      CQ_CODEX_EXECUTABLE: fakeCodex,
      CQ_CODEX_LEDGER_COMMAND: ledgerCommand,
      CQ_T2044_RESOLVER_CAPTURE: capturePath,
      CQ_T2044_RESOLVER_STDERR: resolverStderrPath,
      CQ_T2044_WORKTREE: managedHandle.absolutePath,
      CQ_T2044_LEDGER_ROOT: repositoryRoot,
    };
    execution =
      route === "native"
        ? await executeCodexRoleBoundary(
            createCodexRoleBoundaryPlan({
              ...invocation,
              roleInstructions: await readFile(
                path.join(
                  path.dirname(path.dirname(INSTALLED_ROLE)),
                  "share/cq/prompt-surfaces/codex/roles/implement-conflict-resolver.md",
                ),
                "utf8",
              ),
              promptRoot: path.join(
                path.dirname(path.dirname(INSTALLED_ROLE)),
                "share/cq/prompt-surfaces/codex",
              ),
              ledgerCommand,
              codexExecutable: fakeCodex,
            }),
            "t2044-native-resolver",
            environment,
            codexWorksetEffect("tasks:T2044"),
          )
        : await executeInstalledCodexRoleBoundary({
            executable: INSTALLED_ROLE,
            invocation,
            managedHandle,
            expectedChild,
            expectedPromptProvenance: prepared.prepared.promptProvenance,
            correlationId: "t2044-installed-resolver",
            environment,
          });
  } catch (error) {
    const fixtureStderr = await readFile(resolverStderrPath, "utf8").catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${fixtureStderr}`);
  }
  expect(execution.handle).toEqual(handle);

  const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
    boundary: { listedTools: string[]; codexCwd: string; ledgerCwd: string };
    directGit: { attempted: boolean; exitStatus: number; stderrDigest: string };
    output: Record<string, unknown>;
  };
  expect(capture.boundary).toEqual(
    expect.objectContaining({
      codexCwd: managedHandle.absolutePath,
      ledgerCwd: repositoryRoot,
      listedTools: ["fetch_dispatch_input", "git_resolve_continue", "store_result"],
    }),
  );
  expect(capture.directGit).toMatchObject({ attempted: true });
  expect(capture.directGit.exitStatus).not.toBe(0);
  expect(capture.directGit.stderrDigest).toMatch(/^[0-9a-f]{64}$/);
  const receipts = capture.output["conflictReceipts"] as Record<string, unknown>[];
  expect(receipts).toHaveLength(2);
  expect((receipts[0]?.["outcome"] as Record<string, unknown>)["kind"]).toBe("conflict");
  expect((receipts[1]?.["outcome"] as Record<string, unknown>)["kind"]).toBe("terminal");
  expect(receipts[1]?.["oldHead"]).toBe(receipts[0]?.["newHead"]);
  expect(receipts[1]?.["newHead"]).toBe(capture.output["resultCommit"]);

  const confirmed = await capability.confirmCompletion({
    ...handle,
    nativeCompletion: {
      kind: "native-completion",
      actor: "trusted-parent",
      ...expectedChild,
      completedAt: dispatchNow,
    },
    expectedProvenance: prepared.prepared.promptProvenance,
  });
  expect(confirmed.state).toBe("consumed");
  const fetched = await capability.fetch(handle);
  expect(fetched).toMatchObject({ state: "consumed", output: capture.output });
  const consumed = fetched as ConsumedDispatchResult;
  expect(await capability.fetch(handle)).toMatchObject({ state: "output-already-materialized" });
  return {
    route,
    execution,
    consumed,
    resultCommit: String(capture.output["resultCommit"]),
  } as PackagedResolverGateRun<R>;
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("packaged cq-codex-role Git broker", () => {
  test("contains installed-only worker and conflict-resolver provider gates", async () => {
    const source = await readFile(import.meta.filename, "utf8");
    expect(source).not.toMatch(new RegExp(["ROLE", "SCRIPT"].join("_")));
    expect(source).toContain("codexBrokerWorker.ts");
    expect(source).toContain("codexBrokerResolver.ts");
    expect(source).toContain("codexBrokerReviewer.ts");
    expect(source).toContain("reviewerMatrix");
    expect(source).toContain('roleId: "implement-conflict-resolver"');
    expect(source).toContain("priorCriticism");
    expect(source).toContain("nativeExecution");
    expect(source).toContain("installedGateTest");
    expect(source).toMatch(
      /const completion = await implementationEvidence\.prepareCompletion\([\s\S]*?const mergeRun = await runGitEffect\(\s*"merge",\s*round2ResultCommit,\s*mergeOperationId,\s*completion\.completionRef,\s*\);/u,
    );
    const workerFixture = await readFile(WORKER_FIXTURE, "utf8");
    expect(workerFixture).toContain('"update-ref"');
    expect(workerFixture).toContain("trusted result-storage boundary");
    expect(workerFixture).toContain("installed worker instructions do not permit");
    expect(workerFixture).not.toContain("gateDurationMs:");
    const reviewerFixture = await readFile(REVIEWER_FIXTURE, "utf8");
    expect(reviewerFixture).toContain('expectedMode === "sandboxed"');
    expect(reviewerFixture).toContain('expectedMode !== "non-sandboxed"');
    expect(reviewerFixture).not.toContain("danger-full-access");
    const workspacePackage = JSON.parse(
      await readFile(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(workspacePackage.scripts?.["check:codex-installed-gate"]).toBeDefined();
    expect(workspacePackage.scripts?.["check"]).toContain("check:codex-installed-gate");
  });

  installedGateTest(
    "real supervised gate runner cancels, terminates, settles, and admits a successor",
    async () => {
      const worktreePath = await mkdtemp(path.join(tmpdir(), "t2081-real-gate-runner-"));
      roots.push(worktreePath);
      const commandCwd = path.join(worktreePath, "nix", "pkg", "cq-ledgers");
      await mkdir(commandCwd, { recursive: true });
      await git(worktreePath, ["init", "-q"]);
      const startedPath = path.join(worktreePath, "gate-started");
      const terminatedPath = path.join(worktreePath, "gate-terminated");
      await writeFile(
        path.join(commandCwd, "package.json"),
        `${JSON.stringify({ private: true, scripts: { check: "./gate.sh" } }, null, 2)}\n`,
      );
      const gateScript = path.join(commandCwd, "gate.sh");
      await writeFile(
        gateScript,
        `#!/bin/sh\nif test "$CQ_T2081_GATE_MODE" = timeout; then\n  trap 'touch "$CQ_T2081_GATE_TERMINATED"; exit 143' TERM\n  touch "$CQ_T2081_GATE_STARTED"\n  while :; do sleep 0.02; done\nfi\nprintf '1 pass\\n0 fail\\n'\n`,
      );
      await chmod(gateScript, 0o700);
      const priorMode = process.env["CQ_T2081_GATE_MODE"];
      const priorStarted = process.env["CQ_T2081_GATE_STARTED"];
      const priorTerminated = process.env["CQ_T2081_GATE_TERMINATED"];
      process.env["CQ_T2081_GATE_MODE"] = "timeout";
      process.env["CQ_T2081_GATE_STARTED"] = startedPath;
      process.env["CQ_T2081_GATE_TERMINATED"] = terminatedPath;
      try {
        await expect(
          nodeSupervisedWorkerGateRunner.run({
            worktreePath,
            admissionTimeoutMs: 5_000,
            executionTimeoutMs: 1,
          }),
        ).rejects.toThrow("host execution deadline");
        await expect(
          nodeSupervisedWorkerGateRunner.run({
            worktreePath,
            admissionTimeoutMs: 5_000,
            executionTimeoutMs: 1_500,
          }),
        ).rejects.toThrow("host execution deadline");
        expect(await readFile(startedPath, "utf8")).toBe("");
        expect(await readFile(terminatedPath, "utf8")).toBe("");

        process.env["CQ_T2081_GATE_MODE"] = "green";
        await expect(
          nodeSupervisedWorkerGateRunner.run({
            worktreePath,
            admissionTimeoutMs: 5_000,
            executionTimeoutMs: 5_000,
          }),
        ).resolves.toMatchObject({ gateExitCode: 0, passCount: 1, failCount: 0 });
      } finally {
        if (priorMode === undefined) delete process.env["CQ_T2081_GATE_MODE"];
        else process.env["CQ_T2081_GATE_MODE"] = priorMode;
        if (priorStarted === undefined) delete process.env["CQ_T2081_GATE_STARTED"];
        else process.env["CQ_T2081_GATE_STARTED"] = priorStarted;
        if (priorTerminated === undefined) delete process.env["CQ_T2081_GATE_TERMINATED"];
        else process.env["CQ_T2081_GATE_TERMINATED"] = priorTerminated;
      }
    },
  );

  installedGateTest(
    "authenticates installed worker, reviewer, and resolver gates before codex:native registration [Effectual-GoodCommunication, Blackbox-Group]",
    async () => {
      if (
        INSTALLED_ROLE === undefined ||
        SUBSTITUTED_ROLE === undefined ||
        INSTALLED_CODEX === undefined
      ) {
        throw new Error("installed worker gate was not selected");
      }
      const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t2042-packaged-role-"));
      roots.push(repositoryRoot);
      await git(repositoryRoot, ["init", "-q"]);
      await git(repositoryRoot, ["config", "user.name", "T2042"]);
      await git(repositoryRoot, ["config", "user.email", "t2042@example.invalid"]);
      await writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
      await writeFile(path.join(repositoryRoot, "a.txt"), "base a\n");
      await writeFile(path.join(repositoryRoot, "b.txt"), "base b\n");
      await writeFile(path.join(repositoryRoot, "bun.lock"), "{}\n");
      const workspaceRoot = path.join(repositoryRoot, "nix", "pkg", "cq-ledgers");
      await mkdir(workspaceRoot, { recursive: true });
      await writeFile(
        path.join(workspaceRoot, "package.json"),
        `${JSON.stringify({ private: true, scripts: { check: "test -z \"$CQ_T2042_GATE_COUNT\" || printf 'run\\n' >> \"$CQ_T2042_GATE_COUNT\"; printf '1 pass\\n0 fail\\n'" } }, null, 2)}\n`,
      );
      await git(repositoryRoot, ["add", "file.txt", "a.txt", "b.txt", "bun.lock", "nix"]);
      await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
      const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      await writeFile(path.join(repositoryRoot, "cq.toml"), '[ledger]\nbackend = "fs"\n');
      const ledgerStore = await createLedgerStore(repositoryRoot);
      await ledgerStore.store.dispose();
      const baseTree = await git(repositoryRoot, ["rev-parse", `${baseCommit}^{tree}`]);
      const commonObject = path.join(
        repositoryRoot,
        ".git",
        "objects",
        baseTree.slice(0, 2),
        baseTree.slice(2),
      );
      const objectBefore = await readFile(commonObject);
      const canary = path.join(repositoryRoot, ".git", "T2042-canary");
      await writeFile(canary, "unchanged\n");

      const siblingPath = await mkdtemp(path.join(tmpdir(), "t2042-packaged-sibling-"));
      roots.push(siblingPath);
      await rm(siblingPath, { recursive: true });
      await git(repositoryRoot, [
        "worktree",
        "add",
        "-q",
        "-b",
        "sibling",
        siblingPath,
        baseCommit,
      ]);
      const managed = await prepareManagedWorktree(
        { repositoryRoot, taskId: "T2042", baseCommit },
        { skipInstall: true, bunWorkspaceRoot: repositoryRoot },
      );
      if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
      const refsBefore = await git(repositoryRoot, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
      ]);

      const namespace = await resolveSingleProjectAttestationNamespace({
        construction: "direct",
        backend: "fs",
        repoRoot: repositoryRoot,
        projectId: null,
      });
      let backend = new FsAttestationBackend({
        namespace,
        root: fsAttestationProductionRoot(repositoryRoot),
      });
      const dispatchNow = new Date().toISOString();
      let serviceNow = dispatchNow;
      const dispatchRandomBytes = sequentialDispatchRandomBytes(2048);
      let capability = createDispatchCapability({
        backend,
        promptArtifactStore: artifactStore("implement-worker"),
        repositoryRoot,
        now: () => serviceNow,
        randomBytes: dispatchRandomBytes,
      });
      const prepared = await capability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2042",
          headline: "packaged broker probe",
          description: "make two broker commits",
          acceptance: "all confinement negatives remain unchanged",
          worktreePath: managed.handle.absolutePath,
          branch: managed.handle.branch,
          baseCommit,
          round: 0,
          startingCommit: baseCommit,
        },
        idempotencyKey: "T2042-packaged-role",
        timeoutMs: 600_000,
        expectedChild: { childId: "t2042-packaged-child", runId: "t2042-packaged-run" },
      });
      if (
        !prepared.accepted ||
        prepared.prepared.gitChangeCapability === undefined ||
        prepared.prepared.parentGateCapability === undefined
      ) {
        throw new Error("packaged worker dispatch did not receive Git capability");
      }
      const fixtureRoot = await mkdtemp(path.join(tmpdir(), "t2042-packaged-fake-"));
      roots.push(fixtureRoot);
      const fakeCodex = path.join(fixtureRoot, "fake-codex");
      const capturePath = path.join(fixtureRoot, "capture.json");
      const workerStderrPath = path.join(fixtureRoot, "worker.stderr");
      await writeFile(
        fakeCodex,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(WORKER_FIXTURE)} "$@" 2>"$CQ_T2042_WORKER_STDERR"\n`,
      );
      await chmod(fakeCodex, 0o700);
      const ledgerCommand = path.join(path.dirname(INSTALLED_ROLE), "cq");
      const handle = {
        attestationId: prepared.prepared.attestationId,
        generation: prepared.prepared.generation,
      };
      const expectedChild = {
        childId: "t2042-packaged-child",
        runId: "t2042-packaged-run",
      };
      let execution;
      try {
        execution = await executeCodexRoleBoundary(
          createCodexRoleBoundaryPlan({
            roleId: "implement-worker",
            roleInstructions: await readFile(
              path.join(
                path.dirname(path.dirname(INSTALLED_ROLE)),
                "share/cq/prompt-surfaces/codex/roles/implement-worker.md",
              ),
              "utf8",
            ),
            handle,
            inputCapability: prepared.prepared.inputCapability,
            resultCapability: prepared.prepared.resultCapability,
            gitChangeCapability: prepared.prepared.gitChangeCapability,
            parentGateCapability: prepared.prepared.parentGateCapability,
            cwd: managed.handle.absolutePath,
            ledgerCwd: repositoryRoot,
            model: "test-model",
            reasoningEffort: "high",
            sandboxMode: "workspace-write",
            timeoutMs: 30_000,
            promptRoot: path.join(
              path.dirname(path.dirname(INSTALLED_ROLE)),
              "share/cq/prompt-surfaces/codex",
            ),
            ledgerCommand,
            codexExecutable: fakeCodex,
          }),
          "t2042-native-worker",
          {
            ...process.env,
            CQ_T2042_BROKER_CAPTURE: capturePath,
            CQ_T2042_WORKER_STDERR: workerStderrPath,
            CQ_T2042_WORKTREE: managed.handle.absolutePath,
            CQ_T2042_LEDGER_ROOT: repositoryRoot,
          },
          codexWorksetEffect("tasks:T2042"),
        );
      } catch (error) {
        const fixtureStderr = await readFile(workerStderrPath, "utf8").catch(() => "");
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${fixtureStderr}`,
        );
      }
      expect(execution.handle).toEqual(handle);
      const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
        boundary: {
          codexCwd: string;
          ledgerCommand: string;
          ledgerArgs: string[];
          ledgerCwd: string;
          listedTools: string[];
        };
        denied: string[];
        directGit: { attempted: boolean; exitStatus: number; stderrDigest: string };
        failureControls: string[];
        output: Record<string, unknown>;
      };
      expect(JSON.stringify(capture)).not.toContain(prepared.prepared.parentGateCapability.token);
      expect(await readFile(workerStderrPath, "utf8")).not.toContain(
        prepared.prepared.parentGateCapability.token,
      );
      expect(capture.boundary).toMatchObject({
        codexCwd: managed.handle.absolutePath,
        ledgerCommand,
        ledgerCwd: repositoryRoot,
        listedTools: ["fetch_dispatch_input", "git_commit", "store_result"],
      });
      expect(capture.boundary.ledgerArgs).toContain("--prompt-root");
      expect(capture.denied.sort()).toEqual([
        "base",
        "git-metadata",
        "main",
        "refs",
        "repository",
        "sibling",
        "undeclared-path",
      ]);
      expect(capture.failureControls).toEqual([
        "identity",
        "operation",
        "digest",
        "generation",
        "replay",
        "capability",
        "post-store",
      ]);
      expect(capture.directGit).toMatchObject({ attempted: true });
      expect(capture.directGit.exitStatus).not.toBe(0);
      expect(capture.directGit.stderrDigest).toMatch(/^[0-9a-f]{64}$/);
      const receipts = capture.output["gitReceipts"] as Record<string, unknown>[];
      expect(receipts).toHaveLength(2);
      expect(receipts[1]?.["oldHead"]).toBe(receipts[0]?.["newHead"]);
      expect(receipts[1]?.["newHead"]).toBe(capture.output["resultCommit"]);
      expect(receipts.flatMap((receipt) => receipt["paths"] as string[]).sort()).toEqual([
        "file.txt",
        "file.txt",
      ]);
      expect(await git(repositoryRoot, ["rev-parse", "HEAD"])).toBe(baseCommit);
      expect(await readFile(path.join(repositoryRoot, "file.txt"), "utf8")).toBe("before\n");
      expect(await git(siblingPath, ["rev-parse", "HEAD"])).toBe(baseCommit);
      expect(await readFile(path.join(siblingPath, "file.txt"), "utf8")).toBe("before\n");
      const refsAfter = await git(repositoryRoot, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
      ]);
      expect(
        refsAfter
          .split("\n")
          .filter((line) => !line.startsWith(`refs/heads/${managed.handle.branch} `)),
      ).toEqual(
        refsBefore
          .split("\n")
          .filter((line) => !line.startsWith(`refs/heads/${managed.handle.branch} `)),
      );
      expect(await readFile(canary, "utf8")).toBe("unchanged\n");
      expect(await readFile(commonObject)).toEqual(objectBefore);
      expect(
        await git(managed.handle.absolutePath, ["status", "--porcelain", "--untracked-files=all"]),
      ).toBe("");
      expect(
        await git(managed.handle.absolutePath, [
          "diff",
          "--name-only",
          baseCommit,
          String(capture.output["resultCommit"]),
        ]),
      ).toBe("file.txt");
      await git(managed.handle.absolutePath, [
        "merge-base",
        "--is-ancestor",
        baseCommit,
        String(capture.output["resultCommit"]),
      ]);
      if (capability.finalizeParentGate === undefined) {
        throw new Error("packaged worker dispatch lacks parent finalization");
      }
      await capability.finalizeParentGate({
        ...handle,
        parentGateCapability: prepared.prepared.parentGateCapability,
      });
      const completionRejection = await rejectionOf(() =>
        capability.confirmCompletion({
          ...handle,
          nativeCompletion: {
            kind: "native-completion",
            actor: "trusted-parent",
            ...expectedChild,
            childId: "foreign-child",
            completedAt: dispatchNow,
          },
          expectedProvenance: prepared.prepared.promptProvenance,
        }),
      );
      expect(completionRejection).toBeDefined();
      const confirmed = await capability.confirmCompletion({
        ...handle,
        nativeCompletion: {
          kind: "native-completion",
          actor: "trusted-parent",
          ...expectedChild,
          completedAt: dispatchNow,
        },
        expectedProvenance: prepared.prepared.promptProvenance,
      });
      expect(confirmed.state).toBe("consumed");
      const fetched = await capability.fetch(handle);
      expect(fetched).toMatchObject({ state: "consumed", output: capture.output });
      const consumed = fetched as ConsumedDispatchResult;
      expect(capture.output).not.toHaveProperty("supervisedGateEvidence");
      expect(consumed.output).toMatchObject({
        supervisedGateEvidence: {
          kind: "cq-supervised-gate-evidence",
          taskId: "T2042",
          worktreePath: managed.handle.absolutePath,
          branch: managed.handle.branch,
          resultCommit: capture.output["resultCommit"],
          clean: true,
          gateExitCode: 0,
          passCount: 1,
          failCount: 0,
        },
      });
      expect(await capability.fetch(handle)).toMatchObject({
        state: "output-already-materialized",
      });
      const reviewerMatrix: PackagedReviewerGateRun[] = [];
      for (const reviewerMode of ["sandboxed", "non-sandboxed"] as const) {
        reviewerMatrix.push(
          await runPackagedReviewer({
            repositoryRoot,
            managedHandle: managed.handle,
            baseCommit,
            backend,
            randomBytes: dispatchRandomBytes,
            workerRoute: "native",
            reviewerMode,
            workerResult: consumed,
          }),
        );
      }

      await backend.close();
      backend = new FsAttestationBackend({
        namespace,
        root: fsAttestationProductionRoot(repositoryRoot),
      });
      capability = createDispatchCapability({
        backend,
        promptArtifactStore: artifactStore("implement-worker"),
        repositoryRoot,
        now: () => serviceNow,
        randomBytes: dispatchRandomBytes,
      });

      const firstResultCommit = String(capture.output["resultCommit"]);
      const resumed = await prepareManagedWorktree(
        {
          repositoryRoot,
          taskId: managed.handle.taskId,
          handle: managed.handle,
          priorResultCommit: firstResultCommit,
        },
        { skipInstall: true, bunWorkspaceRoot: repositoryRoot },
      );
      if (resumed.status !== "prepared") throw new Error(`unexpected resume ${resumed.status}`);
      expect(resumed.handle).toEqual(managed.handle);
      expect(resumed.evidence).toMatchObject({ mode: "resume", headCommit: firstResultCommit });

      const retryExpectedChild = {
        childId: "t2042-packaged-child-retry",
        runId: "t2042-packaged-run-retry",
      };
      const retryPrepared = await capability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: managed.handle.taskId,
          headline: "packaged broker criticism retry",
          description: "resume the same managed handle and preserve the prior result",
          acceptance: "the criticism retry appends broker receipts without replacing prior history",
          worktreePath: managed.handle.absolutePath,
          branch: managed.handle.branch,
          baseCommit,
          round: 1,
          startingCommit: firstResultCommit,
          priorResultCommit: firstResultCommit,
          priorCriticism: ["append a second installed-boundary round"],
        },
        idempotencyKey: "T2042-packaged-role-retry",
        timeoutMs: 600_000,
        expectedChild: retryExpectedChild,
        reprepareOf: handle,
      });
      if (
        !retryPrepared.accepted ||
        retryPrepared.prepared.gitChangeCapability === undefined ||
        retryPrepared.prepared.parentGateCapability === undefined
      ) {
        throw new Error("packaged worker retry did not receive Git capability");
      }
      const retryHandle = {
        attestationId: retryPrepared.prepared.attestationId,
        generation: retryPrepared.prepared.generation,
      };
      const retryCapturePath = path.join(fixtureRoot, "retry-capture.json");
      const retryStderrPath = path.join(fixtureRoot, "retry.stderr");
      const gateCountPath = path.join(fixtureRoot, "retry-gate-count.log");
      const finalizerAttemptsPath = path.join(fixtureRoot, "retry-finalizer-attempts.log");
      const finalizerCommittedPath = path.join(fixtureRoot, "retry-finalizer-committed");
      const flakyLedgerCommand = path.join(fixtureRoot, "flaky-ledger-command");
      await writeFile(
        flakyLedgerCommand,
        `#!/bin/sh
parent_gate=0
for arg in "$@"; do
  if test "$arg" = "--parent-gate-finalize"; then parent_gate=1; fi
done
if test "$parent_gate" = 1; then
  printf 'attempt\\n' >> ${JSON.stringify(finalizerAttemptsPath)}
  if test ! -e ${JSON.stringify(finalizerCommittedPath)}; then
    ${JSON.stringify(ledgerCommand)} "$@" > /dev/null
    status=$?
    if test "$status" -ne 0; then exit "$status"; fi
    touch ${JSON.stringify(finalizerCommittedPath)}
    exit 1
  fi
fi
exec ${JSON.stringify(ledgerCommand)} "$@"
`,
      );
      await chmod(flakyLedgerCommand, 0o700);
      const retryExecution = await executeInstalledCodexRoleBoundary({
        executable: INSTALLED_ROLE,
        invocation: {
          roleId: "implement-worker",
          handle: retryHandle,
          inputCapability: retryPrepared.prepared.inputCapability,
          resultCapability: retryPrepared.prepared.resultCapability,
          gitChangeCapability: retryPrepared.prepared.gitChangeCapability,
          parentGateCapability: retryPrepared.prepared.parentGateCapability,
          cwd: resumed.handle.absolutePath,
          ledgerCwd: repositoryRoot,
          model: "test-model",
          reasoningEffort: "high",
          sandboxMode: "workspace-write",
          timeoutMs: 30_000,
        },
        managedHandle: resumed.handle,
        expectedChild: retryExpectedChild,
        expectedPromptProvenance: retryPrepared.prepared.promptProvenance,
        correlationId: "t2042-installed-worker-retry",
        environment: {
          ...process.env,
          CQ_SERVE_TOKEN: "must-not-reach-installed-worker",
          CQ_SERVE_MANAGEMENT_TOKEN: "must-not-reach-installed-worker",
          CQ_LEDGER_REMOTE_TOKEN: "must-not-reach-installed-worker",
          CQ_CODEX_EXECUTABLE: fakeCodex,
          CQ_CODEX_LEDGER_COMMAND: flakyLedgerCommand,
          CQ_T2042_GATE_COUNT: gateCountPath,
          CQ_T2042_BROKER_CAPTURE: retryCapturePath,
          CQ_T2042_WORKER_STDERR: retryStderrPath,
          CQ_T2042_WORKTREE: resumed.handle.absolutePath,
          CQ_T2042_LEDGER_ROOT: repositoryRoot,
        },
      });
      const retryCapture = JSON.parse(await readFile(retryCapturePath, "utf8")) as {
        boundary: {
          codexCwd: string;
          ledgerCwd: string;
          listedTools: string[];
        };
        denied: string[];
        inheritedWorksetCredentials: string[];
        directGit: { attempted: boolean; exitStatus: number; stderrDigest: string };
        failureControls: string[];
        output: Record<string, unknown>;
      };
      expect(JSON.stringify(retryCapture)).not.toContain(
        retryPrepared.prepared.parentGateCapability.token,
      );
      expect(await readFile(retryStderrPath, "utf8")).not.toContain(
        retryPrepared.prepared.parentGateCapability.token,
      );
      const retryReceipts = retryCapture.output["gitReceipts"] as Record<string, unknown>[];
      expect(retryExecution.managedHandle).toEqual(managed.handle);
      expect(retryCapture.boundary).toMatchObject({
        codexCwd: managed.handle.absolutePath,
        ledgerCwd: repositoryRoot,
        listedTools: ["fetch_dispatch_input", "git_commit", "store_result"],
      });
      expect(retryCapture.denied).toEqual(expect.arrayContaining(["git-metadata", "refs"]));
      expect(retryCapture.inheritedWorksetCredentials).toEqual([]);
      expect((await readFile(finalizerAttemptsPath, "utf8")).trim().split("\n")).toHaveLength(2);
      expect((await readFile(gateCountPath, "utf8")).trim().split("\n")).toHaveLength(1);
      expect(retryReceipts).toHaveLength(2);
      expect(retryReceipts[0]?.["oldHead"]).toBe(firstResultCommit);
      expect(retryReceipts[1]?.["newHead"]).toBe(retryCapture.output["resultCommit"]);
      await git(managed.handle.absolutePath, [
        "merge-base",
        "--is-ancestor",
        firstResultCommit,
        String(retryCapture.output["resultCommit"]),
      ]);
      const retryConfirmed = await capability.confirmCompletion({
        ...retryHandle,
        nativeCompletion: {
          kind: "native-completion",
          actor: "trusted-parent",
          ...retryExpectedChild,
          completedAt: dispatchNow,
        },
        expectedProvenance: retryPrepared.prepared.promptProvenance,
      });
      expect(retryConfirmed.state).toBe("consumed");
      const retryFetched = await capability.fetch(retryHandle);
      expect(retryFetched).toMatchObject({
        state: "consumed",
        output: {
          ...retryCapture.output,
          gitReceipts: [...receipts, ...retryReceipts],
        },
      });
      const retryConsumed = retryFetched as ConsumedDispatchResult;
      expect((retryConsumed.output as Record<string, unknown>)["gitReceipts"]).toEqual([
        ...receipts,
        ...retryReceipts,
      ]);
      expect(retryCapture.output).not.toHaveProperty("supervisedGateEvidence");
      expect(retryConsumed.output).toMatchObject({
        supervisedGateEvidence: {
          kind: "cq-supervised-gate-evidence",
          taskId: "T2042",
          resultCommit: retryCapture.output["resultCommit"],
          passCount: 1,
        },
      });
      expect(await capability.fetch(retryHandle)).toMatchObject({
        state: "output-already-materialized",
      });
      for (const reviewerMode of ["sandboxed", "non-sandboxed"] as const) {
        reviewerMatrix.push(
          await runPackagedReviewer({
            repositoryRoot,
            managedHandle: managed.handle,
            baseCommit,
            backend,
            randomBytes: dispatchRandomBytes,
            workerRoute: "process",
            reviewerMode,
            workerResult: retryConsumed,
          }),
        );
      }
      const reviewerSummary = reviewerMatrix.map(
        ({
          workerRoute,
          reviewerMode,
          verdict,
          gateReRan,
          evidenceForwarded,
          fastForwardEligible,
        }) => ({
          workerRoute,
          reviewerMode,
          verdict,
          gateReRan,
          evidenceForwarded,
          fastForwardEligible,
        }),
      );
      expect(reviewerSummary).toEqual([
        {
          workerRoute: "native",
          reviewerMode: "sandboxed",
          verdict: "approve",
          gateReRan: false,
          evidenceForwarded: true,
          fastForwardEligible: true,
        },
        {
          workerRoute: "native",
          reviewerMode: "non-sandboxed",
          verdict: "approve",
          gateReRan: true,
          evidenceForwarded: false,
          fastForwardEligible: true,
        },
        {
          workerRoute: "process",
          reviewerMode: "sandboxed",
          verdict: "approve",
          gateReRan: false,
          evidenceForwarded: true,
          fastForwardEligible: true,
        },
        {
          workerRoute: "process",
          reviewerMode: "non-sandboxed",
          verdict: "approve",
          gateReRan: true,
          evidenceForwarded: false,
          fastForwardEligible: true,
        },
      ]);

      const controlInput = {
        taskId: managed.handle.taskId,
        headline: "installed provider failure-control probe",
        description: "exercise one typed terminal path without changing the worktree",
        acceptance: "the control dispatch remains unconsumable",
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
        baseCommit,
        round: 2,
        startingCommit: String(retryCapture.output["resultCommit"]),
        priorResultCommit: String(retryCapture.output["resultCommit"]),
      };
      const cancelledPrepared = await capability.prepare({
        roleId: "implement-worker",
        input: controlInput,
        idempotencyKey: "T2042-packaged-cancel-control",
        timeoutMs: 600_000,
        expectedChild: { childId: "cancel-control", runId: "cancel-control" },
        reprepareOf: retryHandle,
      });
      if (!cancelledPrepared.accepted) throw new Error("cancel control did not prepare");
      const cancelled = await capability.abort({
        attestationId: cancelledPrepared.prepared.attestationId,
        generation: cancelledPrepared.prepared.generation,
        reason: "cancelled",
      });
      expect(cancelled).toMatchObject({ state: "aborted", reason: "cancelled" });

      const nativeResolverRun = await runPackagedResolverGate({
        repositoryRoot,
        managedHandle: resumed.handle,
        baseCommit,
        backend,
        randomBytes: dispatchRandomBytes,
        route: "native",
      });
      const resolverRun = await runPackagedResolverGate({
        repositoryRoot,
        managedHandle: resumed.handle,
        baseCommit,
        backend,
        randomBytes: dispatchRandomBytes,
        route: "process",
      });
      const deadlinePrepared = await capability.prepare({
        roleId: "implement-worker",
        input: controlInput,
        idempotencyKey: "T2042-packaged-deadline-control",
        timeoutMs: 600_000,
        expectedChild: { childId: "deadline-control", runId: "deadline-control" },
        reprepareOf: cancelledPrepared.handle,
      });
      if (!deadlinePrepared.accepted) throw new Error("deadline control did not prepare");
      await capability.fetchInput({
        attestationId: deadlinePrepared.prepared.attestationId,
        generation: deadlinePrepared.prepared.generation,
        inputCapability: deadlinePrepared.prepared.inputCapability,
      });
      serviceNow = new Date(Date.parse(dispatchNow) + 700_000).toISOString();
      const deadline = await capability.storeResult({
        resultCapability: deadlinePrepared.prepared.resultCapability,
        output: {},
      });
      expect(deadline).toMatchObject({
        state: "aborted",
        result: { state: "aborted", reason: "deadline-exceeded" },
      });
      if (deadline.state !== "aborted") throw new Error("deadline control did not abort");
      const sandboxControls = [];
      const credentialNames = [
        "CQ_SERVE_TOKEN",
        "CQ_SERVE_MANAGEMENT_TOKEN",
        "CQ_LEDGER_REMOTE_TOKEN",
      ] as const;
      const priorCredentials = credentialNames.map((name) => [name, process.env[name]] as const);
      for (const name of credentialNames) process.env[name] = "must-not-reach-provider-control";
      try {
        for (const roleId of ["implement-worker", "implement-conflict-resolver"] as const) {
          for (const route of ["native", "process"] as const) {
            sandboxControls.push(
              await executeCodexProviderSandboxControl({
                codexExecutable: INSTALLED_CODEX,
                gitExecutable: process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git",
                managedHandle: resumed.handle,
                roleId,
                route,
              }),
            );
          }
        }
      } finally {
        for (const [name, value] of priorCredentials) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      const released = await releaseManagedWorktree({
        handle: resumed.handle,
        terminalDisposition: "done",
        resultCommit: resolverRun.resultCommit,
        deleteBranch: false,
      });
      expect(released).toMatchObject({ status: "released", idempotent: false });
      if (released.status !== "released") throw new Error(released.detail);
      await backend.close();
      const directGitDenied =
        retryCapture.directGit.attempted &&
        retryCapture.directGit.exitStatus !== 0 &&
        /^[0-9a-f]{64}$/.test(retryCapture.directGit.stderrDigest);
      if (!directGitDenied) throw new Error("installed worker did not deny direct Git metadata");
      const workerAuthentication = {
        execution: retryExecution,
        nativeExecution: execution,
        priorExecution: execution,
        priorConsumed: consumed,
        consumed: retryConsumed,
        release: released,
        sandboxControls: sandboxControls.filter(({ roleId }) => roleId === "implement-worker"),
        completionRejection,
        cancelled,
        deadline: deadline.result,
      } as const;
      const workerGate = authenticateCodexProviderGateObservation(workerAuthentication);
      const resolverAuthentication = {
        execution: resolverRun.execution,
        nativeExecution: nativeResolverRun.execution,
        consumed: resolverRun.consumed,
        release: released,
        sandboxControls: sandboxControls.filter(
          ({ roleId }) => roleId === "implement-conflict-resolver",
        ),
      } as const;
      const resolverGate = authenticateCodexProviderGateObservation(resolverAuthentication);
      expect(workerGate.failureControls).toEqual([...CODEX_PROVIDER_FAILURE_CONTROLS]);
      const qualification = qualifyCodexNativeAdapter({
        cwd: managed.handle.absolutePath,
        handle: managed.handle,
        repositoryRoot,
        taskId: "T2042",
        workerGate,
        resolverGate,
      });
      const replayWorktreeId = "019fef67-3aa4-73a7-90f0-60c2fa5b3a9c";
      const replayHandle = {
        ...managed.handle,
        token: "foreign-replay-handle",
        worktreeId: replayWorktreeId,
        absolutePath: `${repositoryRoot}/.claude/worktrees/${replayWorktreeId}`,
      };
      const foreignRepositoryRoot = `${repositoryRoot}-foreign`;
      const replayVerdicts = [
        qualifyCodexNativeAdapter({
          cwd: replayHandle.absolutePath,
          handle: replayHandle,
          repositoryRoot,
          taskId: managed.handle.taskId,
          workerGate,
          resolverGate,
        }),
        qualifyCodexNativeAdapter({
          cwd: managed.handle.absolutePath,
          handle: { ...managed.handle, taskId: "T2043" },
          repositoryRoot,
          taskId: "T2043",
          workerGate,
          resolverGate,
        }),
        qualifyCodexNativeAdapter({
          cwd: `${foreignRepositoryRoot}/.claude/worktrees/${managed.handle.worktreeId}`,
          handle: {
            ...managed.handle,
            repositoryRoot: foreignRepositoryRoot,
            absolutePath: `${foreignRepositoryRoot}/.claude/worktrees/${managed.handle.worktreeId}`,
          },
          repositoryRoot: foreignRepositoryRoot,
          taskId: managed.handle.taskId,
          workerGate,
          resolverGate,
        }),
      ];
      const installedIdentity = retryExecution.installedIdentity;
      const expectedInstalledDigest = createHash("sha256")
        .update(await readFile(INSTALLED_ROLE))
        .digest("hex");
      const pairedExecutableIdentitySubstitutionRequest = {
        executable: SUBSTITUTED_ROLE,
        expectedInstalledIdentity: await selectedExecutableSelfIdentity(SUBSTITUTED_ROLE),
        invocation: {
          roleId: "implement-worker",
          handle: retryHandle,
          inputCapability: retryPrepared.prepared.inputCapability,
          resultCapability: retryPrepared.prepared.resultCapability,
          gitChangeCapability: retryPrepared.prepared.gitChangeCapability!,
          cwd: resumed.handle.absolutePath,
          ledgerCwd: repositoryRoot,
          model: "test-model",
          reasoningEffort: "high",
          sandboxMode: "workspace-write",
          timeoutMs: 30_000,
        },
        managedHandle: resumed.handle,
        expectedChild: retryExpectedChild,
        expectedPromptProvenance: retryPrepared.prepared.promptProvenance,
        correlationId: "t2044-paired-executable-identity-substitution",
      } as const;
      const pairedExecutableIdentitySubstitutionRejection = await rejectionOf(() =>
        executeInstalledCodexRoleBoundary(pairedExecutableIdentitySubstitutionRequest),
      );
      const configExports = await import("@cq/config");
      expect({
        fabricatedConsumedRejected: rejected(() =>
          authenticateCodexProviderGateObservation({
            ...workerAuthentication,
            consumed: { ...retryConsumed },
          }),
        ),
        fabricatedReleaseRejected: rejected(() =>
          authenticateCodexProviderGateObservation({
            ...workerAuthentication,
            release: { ...released, handle: { ...released.handle } },
          }),
        ),
        fabricatedExecutionRejected: rejected(() =>
          authenticateCodexProviderGateObservation({
            ...workerAuthentication,
            execution: { ...retryExecution },
          } as never),
        ),
        missingRunnerEvidenceRejected: rejected(() =>
          authenticateCodexProviderGateObservation({
            nativeExecution: execution,
            consumed: retryConsumed,
            release: released,
          } as never),
        ),
        publicAuthorityFactoriesAbsent:
          !Object.hasOwn(configExports, "recordManagerOwnedReleaseResult") &&
          !Object.hasOwn(configExports, "attestCodexInstalledGateTestResult"),
        crossHandleTaskRepositoryReplayRejected: replayVerdicts.every(
          (verdict) =>
            verdict.status === "incompatible" && verdict.reason === "provider-gate-failed",
        ),
        exactInstalledIdentity:
          installedIdentity?.storePath === path.dirname(path.dirname(INSTALLED_ROLE)) &&
          installedIdentity.executablePath === retryExecution.executable &&
          installedIdentity.executableDigest === expectedInstalledDigest,
        runnerCapturedEffectivePreturn:
          "effectivePreturn" in retryExecution && "expectedInstalledIdentity" in retryExecution,
        pairedExecutableIdentitySubstitutionRejected:
          pairedExecutableIdentitySubstitutionRejection instanceof Error &&
          pairedExecutableIdentitySubstitutionRejection.message.includes(
            "installed boundary identity differs from the trusted runner derivation",
          ),
        actualCodexWritableSandboxPositive: sandboxControls.every((control) => {
          const observed = control as unknown as Record<string, unknown>;
          return (
            observed["writableSandboxExitStatus"] === 0 &&
            observed["writableSandboxRefMatches"] === true &&
            observed["deniedSandboxRefAbsent"] === true &&
            observed["credentialEnvironmentAbsent"] === true
          );
        }),
      }).toEqual({
        fabricatedConsumedRejected: true,
        fabricatedReleaseRejected: true,
        fabricatedExecutionRejected: true,
        missingRunnerEvidenceRejected: true,
        publicAuthorityFactoriesAbsent: true,
        crossHandleTaskRepositoryReplayRejected: true,
        exactInstalledIdentity: true,
        runnerCapturedEffectivePreturn: true,
        pairedExecutableIdentitySubstitutionRejected: true,
        actualCodexWritableSandboxPositive: true,
      });
      expect(qualification).toMatchObject({
        status: "qualified",
        adapterId: "codex:native",
        defectClosed: "D307",
      });
      const registry = buildPositiveOnlyDispatchRegistry({
        adapters: [
          createNativeDispatchAdapter("codex", () => {
            throw new Error("qualification probe does not launch the adapter");
          }),
        ],
        nativeQualifications: [qualification],
      });
      expect(registry.has("codex:native")).toBe(true);
    },
    60_000,
  );

  installedGateTest(
    "installed guarded-rebase continuation: exact-tip bridge, paired correction, fresh review, and ff-only merge [Effectual-GoodCommunication, Blackbox-Group]",
    async () => {
      if (INSTALLED_ROLE === undefined || INSTALLED_CODEX === undefined) {
        throw new Error("installed guarded-rebase gate was not selected");
      }
      const taskId = "T2151";
      const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t2151-packaged-guarded-"));
      roots.push(repositoryRoot);
      await git(repositoryRoot, ["init", "-q", "-b", "main"]);
      await git(repositoryRoot, ["config", "user.name", "T2151"]);
      await git(repositoryRoot, ["config", "user.email", "t2151@example.invalid"]);
      await writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
      await writeFile(path.join(repositoryRoot, "other.txt"), "other base\n");
      await writeFile(path.join(repositoryRoot, "bun.lock"), "{}\n");
      await writeFile(path.join(repositoryRoot, "cq.toml"), '[ledger]\nbackend = "fs"\n');
      await writeFile(path.join(repositoryRoot, ".gitignore"), ".cq/\n.claude/\n");
      const workspaceRoot = path.join(repositoryRoot, "nix", "pkg", "cq-ledgers");
      await mkdir(workspaceRoot, { recursive: true });
      await writeFile(
        path.join(workspaceRoot, "package.json"),
        `${JSON.stringify({ private: true, scripts: { check: "test -z \"$CQ_T2151_GATE_COUNT\" || printf 'run\\n' >> \"$CQ_T2151_GATE_COUNT\"; printf '1 pass\\n0 fail\\n'" } }, null, 2)}\n`,
      );
      await git(repositoryRoot, ["add", "."]);
      await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
      const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      const seededStore = await createLedgerStore(repositoryRoot);
      const seededMilestone = await seededStore.store.createMilestone({
        title: "installed guarded-rebase continuation gate",
      });
      await seededStore.store.createItem(TASKS_LEDGER, seededMilestone.id, {
        id: taskId,
        status: "planned",
        fields: {
          headline: "installed guarded-rebase continuation",
          description: "terminal worker, guarded rebase, restart, bridge, correction, merge",
          acceptance: "the guarded continuation completes through the installed boundary",
        },
      });
      await seededStore.store.updateItem(TASKS_LEDGER, taskId, { status: "wip" });
      if (seededStore.implementationEvidenceStore === undefined) {
        throw new Error("installed guarded-rebase fixture lacks protected evidence storage");
      }
      const implementationEvidenceStore = seededStore.implementationEvidenceStore;
      await seededStore.store.dispose();

      const fixtureRoot = await mkdtemp(path.join(tmpdir(), "t2151-packaged-fake-"));
      roots.push(fixtureRoot);
      const gateCountPath = path.join(fixtureRoot, "gate-count.log");
      const priorGateCount = process.env["CQ_T2151_GATE_COUNT"];
      process.env["CQ_T2151_GATE_COUNT"] = gateCountPath;
      const gateRuns = async (): Promise<number> =>
        (await readFile(gateCountPath, "utf8").catch(() => ""))
          .split("\n")
          .filter((line) => line === "run").length;

      const managed = await prepareManagedWorktree(
        { repositoryRoot, taskId, baseCommit },
        { skipInstall: true, bunWorkspaceRoot: repositoryRoot },
      );
      if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);

      const namespace = await resolveSingleProjectAttestationNamespace({
        construction: "direct",
        backend: "fs",
        repoRoot: repositoryRoot,
        projectId: null,
      });
      let backend = new FsAttestationBackend({
        namespace,
        root: fsAttestationProductionRoot(repositoryRoot),
      });
      const dispatchRandomBytes = sequentialDispatchRandomBytes(4_096);
      const serviceNow = (): string => new Date().toISOString();
      let capability = createDispatchCapability({
        backend,
        promptArtifactStore: artifactStore("implement-worker"),
        repositoryRoot,
        now: serviceNow,
        randomBytes: dispatchRandomBytes,
      });
      const fakeCodex = path.join(fixtureRoot, "fake-codex");
      await writeFile(
        fakeCodex,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(WORKER_FIXTURE)} "$@" 2>"$CQ_T2042_WORKER_STDERR"\n`,
      );
      await chmod(fakeCodex, 0o700);
      const ledgerCommand = path.join(path.dirname(INSTALLED_ROLE), "cq");

      const runWorker = async (input: {
        readonly label: string;
        readonly dispatchInput: Record<string, unknown>;
        readonly idempotencyKey: string;
        readonly reprepareOf?: { readonly attestationId: string; readonly generation: number };
        readonly guardedRebase?: string;
        readonly guardedMode?: "exact-tip" | "correction";
      }) => {
        const expectedChild = {
          childId: `t2151-${input.label}-child`,
          runId: `t2151-${input.label}-run`,
        };
        const prepared = await capability.prepare({
          roleId: "implement-worker",
          input: JSON.parse(JSON.stringify(input.dispatchInput)),
          idempotencyKey: input.idempotencyKey,
          timeoutMs: 600_000,
          expectedChild,
          ...(input.reprepareOf === undefined ? {} : { reprepareOf: input.reprepareOf }),
          ...(input.guardedRebase === undefined ? {} : { guardedRebase: input.guardedRebase }),
        });
        if (
          !prepared.accepted ||
          prepared.prepared.gitChangeCapability === undefined ||
          prepared.prepared.parentGateCapability === undefined
        ) {
          throw new Error(`${input.label} did not prepare with Git and gate capabilities`);
        }
        const handle = {
          attestationId: prepared.prepared.attestationId,
          generation: prepared.prepared.generation,
        };
        const capturePath = path.join(fixtureRoot, `${input.label}-capture.json`);
        await executeInstalledCodexRoleBoundary({
          executable: INSTALLED_ROLE,
          invocation: {
            roleId: "implement-worker",
            handle,
            inputCapability: prepared.prepared.inputCapability,
            resultCapability: prepared.prepared.resultCapability,
            gitChangeCapability: prepared.prepared.gitChangeCapability,
            parentGateCapability: prepared.prepared.parentGateCapability,
            cwd: managed.handle.absolutePath,
            ledgerCwd: repositoryRoot,
            model: "test-model",
            reasoningEffort: "high",
            sandboxMode: "workspace-write",
            timeoutMs: 30_000,
          },
          managedHandle: managed.handle,
          expectedChild,
          expectedPromptProvenance: prepared.prepared.promptProvenance,
          correlationId: `t2151-${input.label}`,
          environment: {
            ...process.env,
            CQ_CODEX_EXECUTABLE: fakeCodex,
            CQ_CODEX_LEDGER_COMMAND: ledgerCommand,
            CQ_T2042_BROKER_CAPTURE: capturePath,
            CQ_T2042_WORKER_STDERR: path.join(fixtureRoot, `${input.label}.stderr`),
            CQ_T2042_WORKTREE: managed.handle.absolutePath,
            CQ_T2042_LEDGER_ROOT: repositoryRoot,
            ...(input.guardedMode === undefined
              ? {}
              : { CQ_T2151_GUARDED_MODE: input.guardedMode }),
          },
        });
        const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
          guardedMode?: string;
          failureControls: string[];
          directGit: { attempted: boolean; exitStatus: number; stderrDigest: string };
          output: Record<string, unknown>;
        };
        if (capability.finalizeParentGate === undefined) {
          throw new Error("installed worker dispatch lacks parent finalization");
        }
        await capability.finalizeParentGate({
          ...handle,
          parentGateCapability: prepared.prepared.parentGateCapability,
        });
        const confirmed = await capability.confirmCompletion({
          ...handle,
          nativeCompletion: {
            kind: "native-completion",
            actor: "trusted-parent",
            ...expectedChild,
            completedAt: new Date().toISOString(),
          },
          expectedProvenance: prepared.prepared.promptProvenance,
        });
        expect(confirmed.state).toBe("consumed");
        const fetched = await capability.fetch(handle);
        if (fetched.state !== "consumed") throw new Error(`unexpected worker state ${fetched.state}`);
        return { handle, capture, consumed: fetched as ConsumedDispatchResult };
      };

      const runGitEffect = async (
        operation: "rebase" | "merge",
        commit: string,
        operationId?: string,
        completionRef?: string,
      ) => {
        const child = Bun.spawn(
          [
            ledgerCommand,
            "gate",
            "git-effect",
            "--operation",
            operation,
            "--cwd",
            repositoryRoot,
            "--task-id",
            taskId,
            "--commit",
            commit,
            ...(completionRef === undefined ? [] : ["--completion-ref", completionRef]),
            ...(operationId === undefined ? [] : ["--operation-id", operationId]),
          ],
          {
            cwd: repositoryRoot,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      };

      try {
        // 1. Terminal worker at the dispatch base.
        const round0 = await runWorker({
          label: "round0",
          dispatchInput: {
            taskId,
            headline: "installed guarded-rebase continuation",
            description: "make two broker commits",
            acceptance: "the guarded continuation completes through the installed boundary",
            worktreePath: managed.handle.absolutePath,
            branch: managed.handle.branch,
            baseCommit,
            round: 0,
            startingCommit: baseCommit,
          },
          idempotencyKey: `${taskId}-guarded-round-0`,
        });
        const oldResultCommit = String(round0.capture.output["resultCommit"]);
        expect(await gateRuns()).toBe(1);

        // 2. Main advances on a disjoint file; the guarded rebase is clean and
        // the server resolves the exact-tip mode.
        await writeFile(path.join(repositoryRoot, "other.txt"), "main advance\n");
        await git(repositoryRoot, ["add", "other.txt"]);
        await git(repositoryRoot, ["commit", "-q", "-m", "advance main"]);
        const ontoCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
        const operationId = `implement-t2151-rebase-r0`;
        const rebaseRun = await runGitEffect("rebase", ontoCommit, operationId);
        expect(rebaseRun.code).toBe(0);
        const referenceLines = rebaseRun.stdout
          .split("\n")
          .filter((line) => line.startsWith("CQ_GUARDED_REBASE_REFERENCE="));
        expect(referenceLines).toHaveLength(1);
        const guardedRebase = referenceLines[0]!.slice("CQ_GUARDED_REBASE_REFERENCE=".length);
        expect(guardedRebase).toMatch(/^cq-guarded-rebase:v1:[0-9a-f]{64}$/);
        const rebasedStartCommit = await git(managed.handle.absolutePath, ["rev-parse", "HEAD"]);
        expect(rebasedStartCommit).not.toBe(oldResultCommit);
        await git(managed.handle.absolutePath, [
          "merge-base",
          "--is-ancestor",
          ontoCommit,
          rebasedStartCommit,
        ]);

        // 2a. Exact replay returns the same reference without re-running the
        // effect; a changed payload under the same operation id rejects.
        const replayRun = await runGitEffect("rebase", ontoCommit, operationId);
        expect(replayRun.code).toBe(0);
        expect(replayRun.stdout).toContain(`CQ_GUARDED_REBASE_REFERENCE=${guardedRebase}`);
        expect(await git(managed.handle.absolutePath, ["rev-parse", "HEAD"])).toBe(
          rebasedStartCommit,
        );
        const changedPayloadRun = await runGitEffect("rebase", baseCommit, operationId);
        expect(changedPayloadRun.code).not.toBe(0);
        expect(changedPayloadRun.stderr).toContain("was reused with a different request");
        expect(await git(managed.handle.absolutePath, ["rev-parse", "HEAD"])).toBe(
          rebasedStartCommit,
        );

        // 3. Broker and parent-runner restart: the journal and the persisted
        // binding survive; the reference resolves against the durable state.
        await backend.close();
        backend = new FsAttestationBackend({
          namespace,
          root: fsAttestationProductionRoot(repositoryRoot),
        });
        capability = createDispatchCapability({
          backend,
          promptArtifactStore: artifactStore("implement-worker"),
          repositoryRoot,
          now: serviceNow,
          randomBytes: dispatchRandomBytes,
        });

        const bridgeInput = {
          taskId,
          headline: "installed guarded-rebase continuation",
          description: "resume on the rebased managed tree",
          acceptance: "the guarded continuation completes through the installed boundary",
          worktreePath: managed.handle.absolutePath,
          branch: managed.handle.branch,
          baseCommit: ontoCommit,
          round: 1,
          startingCommit: rebasedStartCommit,
          priorResultCommit: oldResultCommit,
        };

        // 3a. Prepare-side negative controls: a dropped reference, substituted
        // lineage coordinates, an unbound prior result, and a caller-minted
        // lineage all reject before allocation.
        const expectPrepareRejection = async (
          label: string,
          override: Record<string, unknown>,
          extra: { readonly guardedRebase?: string },
          path: string,
          detail: string,
        ) => {
          const rejectedPrepare = await capability.prepare({
            roleId: "implement-worker",
            input: JSON.parse(JSON.stringify({ ...bridgeInput, ...override })),
            idempotencyKey: `${taskId}-guarded-reject-${label}`,
            timeoutMs: 600_000,
            expectedChild: {
              childId: `t2151-reject-${label}-child`,
              runId: `t2151-reject-${label}-run`,
            },
            reprepareOf: round0.handle,
            ...(extra.guardedRebase === undefined ? {} : { guardedRebase: extra.guardedRebase }),
          });
          if (rejectedPrepare.accepted) {
            throw new Error(`${label} unexpectedly allocated a guarded continuation`);
          }
          expect(rejectedPrepare.allocated).toBe(false);
          expect(rejectedPrepare.path).toBe(path);
          expect(rejectedPrepare.detail).toContain(detail);
        };
        await expectPrepareRejection(
          "dropped-reference",
          {},
          {},
          "input.startingCommit",
          "prior-generation receipt inheritance failed",
        );
        await expectPrepareRejection(
          "substituted-base",
          { baseCommit },
          { guardedRebase },
          "input.baseCommit",
          "ontoCommit",
        );
        await expectPrepareRejection(
          "unbound-prior-result",
          { priorResultCommit: baseCommit },
          { guardedRebase },
          "input.priorResultCommit",
          "old worker result",
        );
        await expectPrepareRejection(
          "caller-minted-lineage",
          {
            guardedRebaseLineage: {
              guardedRebase,
              oldResultCommit,
              ontoCommit,
              rebasedStartCommit,
              exactTip: true,
            },
          },
          { guardedRebase },
          "input.guardedRebaseLineage",
          "caller must omit",
        );

        // 4. Initial bridge round: the server-resolved exact-tip/no-new-commit
        // mode. No WIP commit, no fresh receipt, the exact rebased tip.
        const round1 = await runWorker({
          label: "round1-exact-tip",
          dispatchInput: bridgeInput,
          idempotencyKey: `${taskId}-guarded-round-1`,
          reprepareOf: round0.handle,
          guardedRebase,
          guardedMode: "exact-tip",
        });
        expect(round1.capture.guardedMode).toBe("exact-tip");
        expect(round1.capture.failureControls).toEqual([]);
        expect(round1.capture.directGit.exitStatus).not.toBe(0);
        expect(round1.capture.output["gitReceipts"]).toEqual([]);
        expect(round1.capture.output["resultCommit"]).toBe(rebasedStartCommit);
        expect(round1.capture.output["gitLineage"]).toEqual({
          kind: "guarded-rebase",
          guardedRebase,
          ontoCommit,
          rebasedStartCommit,
          exactTip: true,
        });
        expect(round1.capture.output["filesTouched"]).toEqual(["file.txt"]);
        expect(round1.capture.output).not.toHaveProperty("supervisedGateEvidence");
        expect(await git(managed.handle.absolutePath, ["rev-parse", "HEAD"])).toBe(
          rebasedStartCommit,
        );
        expect(await gateRuns()).toBe(2);
        expect(round1.consumed.output).toMatchObject({
          supervisedGateEvidence: {
            kind: "cq-supervised-gate-evidence",
            taskId,
            worktreePath: managed.handle.absolutePath,
            branch: managed.handle.branch,
            baseCommit: ontoCommit,
            startingCommit: rebasedStartCommit,
            resultCommit: rebasedStartCommit,
            clean: true,
            gateExitCode: 0,
            passCount: 1,
            failCount: 0,
          },
        });

        // 5. A fresh review of the rebased result (sandboxed: forwarded
        // runner-owned evidence).
        const round1Review = await runPackagedReviewer({
          repositoryRoot,
          managedHandle: managed.handle,
          baseCommit: ontoCommit,
          backend,
          randomBytes: dispatchRandomBytes,
          workerRoute: "process",
          reviewerMode: "sandboxed",
          workerResult: round1.consumed,
        });
        expect(round1Review).toMatchObject({
          verdict: "approve",
          gateReRan: false,
          evidenceForwarded: true,
          fastForwardEligible: true,
        });

        // 6. Paired correction control: early persistence and a non-empty
        // contiguous fresh suffix beginning at the rebased head; mutation
        // evidence rides because the change touches a test path.
        const round2 = await runWorker({
          label: "round2-correction",
          dispatchInput: {
            ...bridgeInput,
            round: 2,
            priorResultCommit: rebasedStartCommit,
            priorCriticism: ["advance the rebased tip with a guarded correction"],
          },
          idempotencyKey: `${taskId}-guarded-round-2`,
          reprepareOf: round1.handle,
          guardedMode: "correction",
        });
        expect(round2.capture.guardedMode).toBe("correction");
        const round2Receipts = round2.capture.output["gitReceipts"] as Record<string, unknown>[];
        expect(round2Receipts).toHaveLength(2);
        expect(round2Receipts[0]?.["oldHead"]).toBe(rebasedStartCommit);
        expect(round2Receipts[0]?.["paths"]).toEqual([`WIP-${taskId}.md`]);
        expect(round2Receipts[1]?.["oldHead"]).toBe(round2Receipts[0]?.["newHead"]);
        expect(round2Receipts[1]?.["newHead"]).toBe(round2.capture.output["resultCommit"]);
        const round2ResultCommit = String(round2.capture.output["resultCommit"]);
        expect(round2.capture.output["filesTouched"]).toEqual(
          [`WIP-${taskId}.md`, "file.txt", "pkg/test/guarded-correction.test.ts"].sort(),
        );
        expect(round2.capture.output["mutationTable"]).toHaveLength(1);
        expect(round2.capture.failureControls).toEqual(["post-store"]);
        expect(round2.capture.output["gitLineage"]).toEqual({
          kind: "guarded-rebase",
          guardedRebase,
          ontoCommit,
          rebasedStartCommit,
          exactTip: true,
        });
        await git(managed.handle.absolutePath, [
          "merge-base",
          "--is-ancestor",
          rebasedStartCommit,
          round2ResultCommit,
        ]);
        expect(await gateRuns()).toBe(3);
        expect(round2.consumed.output).toMatchObject({
          supervisedGateEvidence: {
            kind: "cq-supervised-gate-evidence",
            taskId,
            resultCommit: round2ResultCommit,
            clean: true,
            gateExitCode: 0,
            passCount: 1,
            failCount: 0,
          },
        });

        // 7. A fresh review of the correction (non-sandboxed: the reviewer
        // re-runs the canonical gate on the rebased tree itself).
        const round2Review = await runPackagedReviewer({
          repositoryRoot,
          managedHandle: managed.handle,
          baseCommit: ontoCommit,
          backend,
          randomBytes: dispatchRandomBytes,
          workerRoute: "process",
          reviewerMode: "non-sandboxed",
          workerResult: round2.consumed,
        });
        expect(round2Review).toMatchObject({
          verdict: "approve",
          gateReRan: true,
          evidenceForwarded: false,
          fastForwardEligible: true,
        });
        expect(await gateRuns()).toBe(4);

        // 8. Bind the consumed worker and fresh reviewer dispatches into the
        // protected completion journal before the ff-only merge.
        const reviewerIdentity: ImplementationReviewerIdentity = {
          alias: "t2151-native",
          harness: "codex",
          model: "test-model",
          provider: null,
          launch: "native",
          adapterId: "codex:native",
        };
        const implementationEvidence = new ImplementationEvidenceService({
          store: implementationEvidenceStore,
          reviewerRoster: [reviewerIdentity],
          nativeFallback: reviewerIdentity,
          prepareNativeReview: async () => round2Review.dispatch,
          fetchNativeReview: async (dispatch) => {
            expect(dispatch).toEqual(round2Review.dispatch);
            return { state: "consumed", output: round2Review.consumed.output };
          },
          executeExternalReview: async () => {
            throw new Error("T2151 uses one native reviewer");
          },
          fetchWorker: async (dispatch) => {
            expect(dispatch).toEqual(round2.handle);
            return { state: "consumed", output: round2.consumed.output };
          },
          readTaskAuthority: async (taskRef) => ({
            taskRef,
            ownerGoalRef: "goals:G2151",
            status: "wip",
            finalizedManifest: "T2151 installed guarded-rebase completion manifest\n",
          }),
          repositoryHead: async () => await git(repositoryRoot, ["rev-parse", "HEAD"]),
          verifyImplementation: async () => ({
            baseCommit: ontoCommit,
            startingCommit: rebasedStartCommit,
            clean: true,
            ancestryVerified: true,
            receiptsVerified: true,
            acceptanceVerified: true,
            gateVerified: true,
            details: { fixture: "T2151", ffOnly: true },
          }),
          recordLedgerCompletion: async () => ({ reviewRef: "reviews:R2151" }),
        });
        const panel = await implementationEvidence.prepareReviewPanel({
          taskRef: `tasks:${taskId}`,
          resultCommit: round2ResultCommit,
          workerDispatch: round2.handle,
          operationId: "t2151_review_panel_round2_v1",
          author: "t2151-parent",
        });
        expect(panel.status).toBe("prepared");
        const attemptRef = panel.attemptRefs[0]!;
        const attempt = await implementationEvidence.prepareReviewAttempt({
          panelRef: panel.panelRef,
          attemptRef,
          operationId: "t2151_review_attempt_round2_v1",
          author: "t2151-parent",
        });
        expect(attempt).toMatchObject({
          status: "prepared",
          attemptRef,
          launch: "native",
          dispatch: round2Review.dispatch,
        });
        expect(
          await implementationEvidence.finalizeReviewAttempt({
            attemptRef,
            operationId: "t2151_review_finalize_round2_v1",
            author: "t2151-parent",
          }),
        ).toEqual({ status: "recorded", attemptRef, terminalState: "approved" });
        const mergeOperationId = "implement-t2151-merge-r2";
        const completion = await implementationEvidence.prepareCompletion({
          taskRef: `tasks:${taskId}`,
          expectedRepositoryHead: ontoCommit,
          resultCommit: round2ResultCommit,
          workerDispatch: round2.handle,
          reviewAttemptRefs: [attemptRef],
          completion: "T2151 guarded-rebase result merged through protected completion",
          logPaths: [".cq/logs/t2151-worker.md", ".cq/logs/t2151-reviewer.md"],
          mergeOperationId,
          operationId: "t2151_completion_prepare_round2_v1",
          author: "t2151-parent",
        });

        // 9. The journal-bound ff-only merge lands the rebased lineage and
        // emits the exact acknowledgement retained by implement/advance.
        const mergeRun = await runGitEffect(
          "merge",
          round2ResultCommit,
          mergeOperationId,
          completion.completionRef,
        );
        expect(mergeRun.code).toBe(0);
        expect(mergeRun.stdout.trim()).toBe(
          `CQ_IMPLEMENTATION_COMPLETION_MERGE=${JSON.stringify({
            status: "merged",
            completionRef: completion.completionRef,
            taskRef: `tasks:${taskId}`,
            resultCommit: round2ResultCommit,
            repositoryHead: round2ResultCommit,
            mergeOperationId,
            evidenceFingerprint: completion.evidenceFingerprint,
          })}`,
        );
        expect(await git(repositoryRoot, ["rev-parse", "HEAD"])).toBe(round2ResultCommit);
        expect(
          await git(managed.handle.absolutePath, [
            "status",
            "--porcelain",
            "--untracked-files=all",
          ]),
        ).toBe("");
        await backend.close();
      } finally {
        if (priorGateCount === undefined) delete process.env["CQ_T2151_GATE_COUNT"];
        else process.env["CQ_T2151_GATE_COUNT"] = priorGateCount;
      }
    },
    120_000,
  );
});
