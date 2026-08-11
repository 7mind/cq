/** T2042 — packaged cq-codex-role broker/confinement acceptance probe. */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  qualifyCodexNativeAdapter,
  sequentialDispatchRandomBytes,
  type CodexInstalledIdentity,
  type CodexInstalledRoleBoundaryExecution,
  type CodexRoleBoundaryExecutionResult,
  type ConsumedDispatchResult,
} from "@cq/config";
import {
  createLedgerStore,
  fsAttestationProductionRoot,
  observeManagedRebaseConflict,
  prepareManagedWorktree,
  releaseManagedWorktree,
  resolveManagedWorktreeDispatchBinding,
  resolveSingleProjectAttestationNamespace,
  type DispatchBoundGitAuthorization,
  type ManagedWorktreeHandle,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const roots: string[] = [];
const INSTALLED_ROLE = process.env["CQ_TEST_CODEX_ROLE_EXECUTABLE"];
const INSTALLED_CODEX = process.env["CQ_TEST_CODEX_SANDBOX_EXECUTABLE"];
const installedGateTest =
  INSTALLED_ROLE === undefined || INSTALLED_CODEX === undefined ? test.skip : test;
const WORKER_FIXTURE = fileURLToPath(new URL("./fixtures/codexBrokerWorker.ts", import.meta.url));
const RESOLVER_FIXTURE = fileURLToPath(new URL("./fixtures/codexBrokerResolver.ts", import.meta.url));

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
  roleId: "implement-worker" | "implement-conflict-resolver",
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
    schemaVersion: roleId === "implement-worker" ? 6 : implementConflictResolverSidecar.version,
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

async function expectedInstalledIdentity(executable: string): Promise<CodexInstalledIdentity> {
  return {
    storePath: path.dirname(path.dirname(executable)),
    executablePath: executable,
    executableDigest: createHash("sha256").update(await readFile(executable)).digest("hex"),
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
  const binding = await resolveManagedWorktreeDispatchBinding(
    {
      repositoryRoot,
      taskId: managedHandle.taskId,
      worktreePath: managedHandle.absolutePath,
      branch: managedHandle.branch,
    },
  );
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
          )
        : await executeInstalledCodexRoleBoundary({
            executable: INSTALLED_ROLE,
            expectedInstalledIdentity: await expectedInstalledIdentity(INSTALLED_ROLE),
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
    expect(source).toContain('roleId: "implement-conflict-resolver"');
    expect(source).toContain("priorCriticism");
    expect(source).toContain("nativeExecution");
    expect(source).toContain("installedGateTest");
    const workerFixture = await readFile(WORKER_FIXTURE, "utf8");
    expect(workerFixture).toContain('"update-ref"');
    const workspacePackage = JSON.parse(
      await readFile(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(workspacePackage.scripts?.["check:codex-installed-gate"]).toBeDefined();
    expect(workspacePackage.scripts?.["check"]).toContain("check:codex-installed-gate");
  });

  installedGateTest("authenticates installed worker and resolver gates before codex:native registration [Effectual-GoodCommunication, Blackbox-Group]", async () => {
    if (INSTALLED_ROLE === undefined || INSTALLED_CODEX === undefined) {
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
    await git(repositoryRoot, ["add", "file.txt", "a.txt", "b.txt", "bun.lock"]);
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
    await git(repositoryRoot, ["worktree", "add", "-q", "-b", "sibling", siblingPath, baseCommit]);
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
    if (!prepared.accepted || prepared.prepared.gitChangeCapability === undefined) {
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
      );
    } catch (error) {
      const fixtureStderr = await readFile(workerStderrPath, "utf8").catch(() => "");
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${fixtureStderr}`);
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
    expect(await capability.fetch(handle)).toMatchObject({ state: "output-already-materialized" });

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
    });
    if (!retryPrepared.accepted || retryPrepared.prepared.gitChangeCapability === undefined) {
      throw new Error("packaged worker retry did not receive Git capability");
    }
    const retryHandle = {
      attestationId: retryPrepared.prepared.attestationId,
      generation: retryPrepared.prepared.generation,
    };
    const retryCapturePath = path.join(fixtureRoot, "retry-capture.json");
    const retryStderrPath = path.join(fixtureRoot, "retry.stderr");
    const retryExecution = await executeInstalledCodexRoleBoundary({
      executable: INSTALLED_ROLE,
      expectedInstalledIdentity: await expectedInstalledIdentity(INSTALLED_ROLE),
      invocation: {
        roleId: "implement-worker",
        handle: retryHandle,
        inputCapability: retryPrepared.prepared.inputCapability,
        resultCapability: retryPrepared.prepared.resultCapability,
        gitChangeCapability: retryPrepared.prepared.gitChangeCapability,
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
        CQ_CODEX_EXECUTABLE: fakeCodex,
        CQ_CODEX_LEDGER_COMMAND: ledgerCommand,
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
      directGit: { attempted: boolean; exitStatus: number; stderrDigest: string };
      failureControls: string[];
      output: Record<string, unknown>;
    };
    const retryReceipts = retryCapture.output["gitReceipts"] as Record<string, unknown>[];
    expect(retryExecution.managedHandle).toEqual(managed.handle);
    expect(retryCapture.boundary).toMatchObject({
      codexCwd: managed.handle.absolutePath,
      ledgerCwd: repositoryRoot,
      listedTools: ["fetch_dispatch_input", "git_commit", "store_result"],
    });
    expect(retryCapture.denied).toEqual(expect.arrayContaining(["git-metadata", "refs"]));
    expect(retryReceipts[0]?.["oldHead"]).toBe(firstResultCommit);
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
    expect(retryFetched).toMatchObject({ state: "consumed", output: retryCapture.output });
    const retryConsumed = retryFetched as ConsumedDispatchResult;
    expect(await capability.fetch(retryHandle)).toMatchObject({
      state: "output-already-materialized",
    });

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
    });
    if (!deadlinePrepared.accepted) throw new Error("deadline control did not prepare");
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
    const released = await releaseManagedWorktree({
      handle: resumed.handle,
      terminalDisposition: "done",
      resultCommit: resolverRun.resultCommit,
      deleteBranch: false,
    });
    expect(released).toMatchObject({ status: "released", idempotent: false });
    if (released.status !== "released") throw new Error(released.detail);
    await backend.close();
    const directGitDenied = retryCapture.directGit.attempted &&
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
        (verdict) => verdict.status === "incompatible" && verdict.reason === "provider-gate-failed",
      ),
      exactInstalledIdentity:
        installedIdentity?.storePath === path.dirname(path.dirname(INSTALLED_ROLE)) &&
        installedIdentity.executablePath === retryExecution.executable &&
        installedIdentity.executableDigest === expectedInstalledDigest,
      runnerCapturedEffectivePreturn:
        "effectivePreturn" in retryExecution &&
        "expectedInstalledIdentity" in retryExecution,
    }).toEqual({
      fabricatedConsumedRejected: true,
      fabricatedReleaseRejected: true,
      fabricatedExecutionRejected: true,
      missingRunnerEvidenceRejected: true,
      publicAuthorityFactoriesAbsent: true,
      crossHandleTaskRepositoryReplayRejected: true,
      exactInstalledIdentity: true,
      runnerCapturedEffectivePreturn: true,
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
  }, 60_000);
});
