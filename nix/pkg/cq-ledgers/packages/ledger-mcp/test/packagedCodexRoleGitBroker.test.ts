/** T2042 — packaged cq-codex-role broker/confinement acceptance probe. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FsAttestationBackend,
  authenticateCodexProviderGateObservation,
  buildPositiveOnlyDispatchRegistry,
  createNativeDispatchAdapter,
  executeInstalledCodexRoleBoundary,
  implementConflictResolverSidecar,
  qualifyCodexNativeAdapter,
  sequentialDispatchRandomBytes,
  type CodexProviderGateObservation,
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
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const roots: string[] = [];
const INSTALLED_ROLE = process.env["CQ_TEST_CODEX_ROLE_EXECUTABLE"];
const installedGateTest = INSTALLED_ROLE === undefined ? test.skip : test;
const WORKER_FIXTURE = fileURLToPath(new URL("./fixtures/codexBrokerWorker.ts", import.meta.url));
const RESOLVER_FIXTURE = fileURLToPath(new URL("./fixtures/codexBrokerResolver.ts", import.meta.url));

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
  const metadata = {
    roleId,
    roleKind: "dispatched-subagent" as const,
    artifactPath: `roles/${roleId}.md`,
    sidecarSchemaRoleId: roleId,
    promptSurface: "codex" as const,
    promptDigest: "a".repeat(64),
    schemaVersion: roleId === "implement-worker" ? 6 : implementConflictResolverSidecar.version,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: "codex",
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  };
}

async function runPackagedResolverGate(): Promise<CodexProviderGateObservation> {
  if (INSTALLED_ROLE === undefined) throw new Error("installed resolver gate was not selected");
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t2044-packaged-resolver-"));
  roots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "-q", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.name", "T2044"]);
  await git(repositoryRoot, ["config", "user.email", "t2044@example.invalid"]);
  await git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repositoryRoot, "cq.toml"), '[ledger]\nbackend = "fs"\n');
  await writeFile(path.join(repositoryRoot, "bun.lock"), "{}\n");
  await writeFile(path.join(repositoryRoot, "a.txt"), "base a\n");
  await writeFile(path.join(repositoryRoot, "b.txt"), "base b\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const ledgerStore = await createLedgerStore(repositoryRoot);
  await ledgerStore.store.dispose();
  const managed = await prepareManagedWorktree(
    { repositoryRoot, taskId: "T2044", baseCommit },
    { skipInstall: true, bunWorkspaceRoot: repositoryRoot },
  );
  if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
  const binding = await resolveManagedWorktreeDispatchBinding(
    {
      repositoryRoot,
      taskId: "T2044",
      worktreePath: managed.handle.absolutePath,
      branch: managed.handle.branch,
    },
  );
  if (binding === null) throw new Error("resolver managed binding did not resolve");

  await writeFile(path.join(managed.handle.absolutePath, "a.txt"), "task a\n");
  await git(managed.handle.absolutePath, ["add", "a.txt"]);
  await git(managed.handle.absolutePath, ["commit", "-q", "-m", "task a"]);
  await writeFile(path.join(managed.handle.absolutePath, "b.txt"), "task b\n");
  await git(managed.handle.absolutePath, ["add", "b.txt"]);
  await git(managed.handle.absolutePath, ["commit", "-q", "-m", "task b"]);
  await writeFile(path.join(repositoryRoot, "a.txt"), "base changed a\n");
  await writeFile(path.join(repositoryRoot, "b.txt"), "base changed b\n");
  await git(repositoryRoot, ["add", "a.txt", "b.txt"]);
  await git(repositoryRoot, ["commit", "-q", "-m", "base changes"]);
  const onto = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const rebase = Bun.spawnSync(["git", "rebase", onto], {
    cwd: managed.handle.absolutePath,
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

  const namespace = await resolveSingleProjectAttestationNamespace({
    construction: "direct",
    backend: "fs",
    repoRoot: repositoryRoot,
    projectId: null,
  });
  const backend = new FsAttestationBackend({
    namespace,
    root: fsAttestationProductionRoot(repositoryRoot),
  });
  const dispatchNow = new Date().toISOString();
  const capability = createDispatchCapability({
    backend,
    promptArtifactStore: artifactStore("implement-conflict-resolver"),
    repositoryRoot,
    now: () => dispatchNow,
    randomBytes: sequentialDispatchRandomBytes(512),
  });
  const expectedChild = {
    childId: "t2044-packaged-resolver-child",
    runId: "t2044-packaged-resolver-run",
  };
  const prepared = await capability.prepare({
    roleId: "implement-conflict-resolver",
    input: JSON.parse(
      JSON.stringify({
        taskId: "T2044",
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
        baseCommit,
        conflictingFiles: ["a.txt"],
        conflictState,
      }),
    ),
    idempotencyKey: "T2044-packaged-resolver",
    timeoutMs: 600_000,
    expectedChild,
  });
  if (!prepared.accepted || prepared.prepared.gitConflictCapability === undefined) {
    throw new Error("packaged resolver dispatch did not receive Git conflict capability");
  }

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "t2044-packaged-resolver-fake-"));
  roots.push(fixtureRoot);
  const fakeCodex = path.join(fixtureRoot, "fake-codex");
  const capturePath = path.join(fixtureRoot, "resolver-capture.json");
  const resolverStderrPath = path.join(fixtureRoot, "resolver.stderr");
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
  let execution;
  try {
    execution = await executeInstalledCodexRoleBoundary({
      executable: INSTALLED_ROLE,
      invocation: {
      roleId: "implement-conflict-resolver",
      handle,
      inputCapability: prepared.prepared.inputCapability,
      resultCapability: prepared.prepared.resultCapability,
      gitConflictCapability: prepared.prepared.gitConflictCapability,
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
      correlationId: "t2044-installed-resolver",
      environment: {
        ...process.env,
        CQ_CODEX_EXECUTABLE: fakeCodex,
        CQ_CODEX_LEDGER_COMMAND: ledgerCommand,
        CQ_T2044_RESOLVER_CAPTURE: capturePath,
        CQ_T2044_RESOLVER_STDERR: resolverStderrPath,
        CQ_T2044_WORKTREE: managed.handle.absolutePath,
        CQ_T2044_LEDGER_ROOT: repositoryRoot,
      },
    });
  } catch (error) {
    const fixtureStderr = await readFile(resolverStderrPath, "utf8").catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${fixtureStderr}`);
  }
  expect(execution.handle).toEqual(handle);

  const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
    boundary: { listedTools: string[]; codexCwd: string; ledgerCwd: string };
    output: Record<string, unknown>;
  };
  expect(capture.boundary).toEqual(
    expect.objectContaining({
      codexCwd: managed.handle.absolutePath,
      ledgerCwd: repositoryRoot,
      listedTools: ["fetch_dispatch_input", "git_resolve_continue", "store_result"],
    }),
  );
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
  await backend.close();
  const released = await releaseManagedWorktree(
    {
      handle: managed.handle,
      terminalDisposition: "done",
      resultCommit: String(capture.output["resultCommit"]),
      deleteBranch: false,
    },
  );
  expect(released).toMatchObject({ status: "released", idempotent: false });
  if (released.status !== "released") throw new Error(released.detail);
  return authenticateCodexProviderGateObservation({ execution, consumed, release: released });
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
  });

  installedGateTest("authenticates installed worker and resolver gates before codex:native registration", async () => {
    if (INSTALLED_ROLE === undefined) throw new Error("installed worker gate was not selected");
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "t2042-packaged-role-"));
    roots.push(repositoryRoot);
    await git(repositoryRoot, ["init", "-q"]);
    await git(repositoryRoot, ["config", "user.name", "T2042"]);
    await git(repositoryRoot, ["config", "user.email", "t2042@example.invalid"]);
    await writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
    await git(repositoryRoot, ["add", "file.txt"]);
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
    const backend = new FsAttestationBackend({
      namespace,
      root: fsAttestationProductionRoot(repositoryRoot),
    });
    const dispatchNow = new Date().toISOString();
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore("implement-worker"),
      repositoryRoot,
      now: () => dispatchNow,
      randomBytes: sequentialDispatchRandomBytes(128),
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
      execution = await executeInstalledCodexRoleBoundary({
        executable: INSTALLED_ROLE,
        invocation: {
        roleId: "implement-worker",
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
        },
        managedHandle: managed.handle,
        expectedChild,
        expectedPromptProvenance: prepared.prepared.promptProvenance,
        correlationId: "t2042-installed-worker",
        environment: {
          ...process.env,
          CQ_CODEX_EXECUTABLE: fakeCodex,
          CQ_CODEX_LEDGER_COMMAND: ledgerCommand,
          CQ_T2042_BROKER_CAPTURE: capturePath,
          CQ_T2042_WORKER_STDERR: workerStderrPath,
          CQ_T2042_WORKTREE: managed.handle.absolutePath,
          CQ_T2042_LEDGER_ROOT: repositoryRoot,
        },
      });
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
    const released = await releaseManagedWorktree({
      handle: managed.handle,
      terminalDisposition: "done",
      resultCommit: String(capture.output["resultCommit"]),
      deleteBranch: false,
    });
    expect(released).toMatchObject({ status: "released", idempotent: false });
    if (released.status !== "released") throw new Error(released.detail);
    const workerGate = authenticateCodexProviderGateObservation({
      execution,
      consumed,
      release: released,
    });
    const resolverGate = await runPackagedResolverGate();
    const qualification = qualifyCodexNativeAdapter({
      cwd: managed.handle.absolutePath,
      handle: managed.handle,
      repositoryRoot,
      taskId: "T2042",
      workerGate,
      resolverGate,
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
  }, 30_000);
});
