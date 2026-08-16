/**
 * T2042 — Effectual Good-Communication tests for the dispatch attestation,
 * managed-worktree registry, broker, and result-store lock integration.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  FsAttestationBackend,
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
  type DispatchJSONValue,
} from "@cq/config";
import { fsAttestationProductionRoot, prepareManagedWorktree } from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const exec = promisify(execFile);
const roots: string[] = [];
const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "t2042-integration" };
const PEER_FIXTURE = new URL("./fixtures/gitChangeBrokerPeer.ts", import.meta.url).pathname;
const RECEIPT_CHAIN_MATRIX_TIMEOUT_MS = 30_000;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T2042",
      GIT_AUTHOR_EMAIL: "t2042@example.invalid",
      GIT_COMMITTER_NAME: "T2042",
      GIT_COMMITTER_EMAIL: "t2042@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactStore(surface: "claude" | "codex" = "claude"): PromptArtifactStore {
  const metadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: surface,
    promptDigest: "a".repeat(64),
    schemaVersion: 8,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: surface,
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  };
}

interface PeerOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnPeer(
  request: Readonly<Record<string, unknown>>,
  environment: Readonly<Record<string, string>> = {},
): {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly outcome: Promise<PeerOutcome>;
  result(): Promise<Record<string, unknown>>;
} {
  const input = Buffer.from(`${JSON.stringify(request)}\n`);
  const child = Bun.spawn([process.execPath, "run", PEER_FIXTURE], {
    env: { ...process.env, ...environment },
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
  });
  const outcome = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
  return {
    child,
    outcome,
    result: async () =>
      await outcome.then(({ code, stdout, stderr }) => {
        if (code !== 0) throw new Error(`broker peer exited ${String(code)}: ${stderr}`);
        return JSON.parse(stdout) as Record<string, unknown>;
      }),
  };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await Bun.file(file).exists())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await Bun.sleep(10);
  }
}

async function blockingGit(
  repositoryRoot: string,
  trigger: "second-top" | "third-top" | "fifth-top" | "index" | "update-ref",
): Promise<{
  readonly environment: Readonly<Record<string, string>>;
  readonly ready: string;
  readonly release: string;
}> {
  const directory = path.join(repositoryRoot, `.blocking-git-${trigger}`);
  const ready = path.join(directory, "ready");
  const release = path.join(directory, "release");
  const counter = path.join(directory, "counter");
  const executable = path.join(directory, "git");
  const realGit = Bun.which(process.env["CQ_TEST_GIT_EXECUTABLE"] ?? "git");
  if (realGit === null) throw new Error("git executable is unavailable");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    executable,
    [
      "#!/bin/sh",
      "set -eu",
      'matched=""',
      'if [ "$CQ_PEER_GIT_TRIGGER" = "update-ref" ]; then',
      '  case " $* " in *" update-ref "*) matched=yes ;; esac',
      'elif [ "$CQ_PEER_GIT_TRIGGER" = "index" ]; then',
      '  case " $* " in *" --git-path index "*) matched=yes ;; esac',
      'elif [ "${1-}" = "rev-parse" ] && [ "${2-}" = "--show-toplevel" ]; then',
      '  count=0; test ! -e "$CQ_PEER_GIT_COUNTER" || read -r count < "$CQ_PEER_GIT_COUNTER"',
      '  count=$((count + 1)); printf "%s\\n" "$count" > "$CQ_PEER_GIT_COUNTER"',
      '  if [ "$CQ_PEER_GIT_TRIGGER" = "second-top" ] && [ "$count" -eq 2 ]; then matched=yes; fi',
      '  if [ "$CQ_PEER_GIT_TRIGGER" = "third-top" ] && [ "$count" -eq 3 ]; then matched=yes; fi',
      '  if [ "$CQ_PEER_GIT_TRIGGER" = "fifth-top" ] && [ "$count" -eq 5 ]; then matched=yes; fi',
      "fi",
      'if [ "$matched" = yes ]; then',
      '  : > "$CQ_PEER_GIT_READY"',
      "  owner=$PPID",
      '  while [ ! -e "$CQ_PEER_GIT_RELEASE" ]; do',
      '    kill -0 "$owner" 2>/dev/null || exit 143',
      "    sleep 0.01",
      "  done",
      "fi",
      'exec "$CQ_PEER_REAL_GIT" "$@"',
      "",
    ].join("\n"),
  );
  await fs.chmod(executable, 0o700);
  return {
    ready,
    release,
    environment: {
      PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
      CQ_PEER_GIT_TRIGGER: trigger,
      CQ_PEER_GIT_COUNTER: counter,
      CQ_PEER_GIT_READY: ready,
      CQ_PEER_GIT_RELEASE: release,
      CQ_PEER_REAL_GIT: realGit,
    },
  };
}

async function durableDispatch(label: string) {
  const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), `t2042-peer-${label}-`));
  roots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "-q"]);
  await fs.writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
  await git(repositoryRoot, ["add", "file.txt"]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const stateDir = path.join(repositoryRoot, ".manager-state");
  const managed = await prepareManagedWorktree(
    { repositoryRoot, taskId: "T2042", baseCommit },
    { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
  );
  if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
  const namespace: AttestationNamespace = {
    backend: "fs",
    projectKey: `t2042-peer-${label}`,
  };
  const attestationRoot = fsAttestationProductionRoot(repositoryRoot);
  const backend = new FsAttestationBackend({ namespace, root: attestationRoot });
  const capability = createDispatchCapability({
    backend,
    promptArtifactStore: artifactStore(),
    repositoryRoot,
    worktreeStateDir: stateDir,
    now: () => "2026-08-10T12:00:00.000Z",
    randomBytes: sequentialDispatchRandomBytes(label.length * 32),
  });
  const prepared = await capability.prepare({
    roleId: "implement-worker",
    input: {
      taskId: "T2042",
      headline: "exercise peer broker",
      description: "serialize durable effects across processes",
      acceptance: "one ordered durable outcome",
      worktreePath: managed.handle.absolutePath,
      branch: managed.handle.branch,
      baseCommit,
      round: 0,
      startingCommit: baseCommit,
    },
    idempotencyKey: `T2042-peer-${label}`,
    timeoutMs: 600_000,
    expectedChild: { childId: `child-${label}`, runId: `run-${label}` },
  });
  if (!prepared.accepted || prepared.prepared.gitChangeCapability === undefined) {
    throw new Error("peer dispatch did not receive a Git capability");
  }
  await capability.fetchInput({
    attestationId: prepared.prepared.attestationId,
    generation: prepared.prepared.generation,
    inputCapability: prepared.prepared.inputCapability,
  });
  await backend.close();
  return {
    repositoryRoot,
    stateDir,
    managed,
    namespace,
    attestationRoot,
    baseCommit,
    prepared: prepared.prepared,
  };
}

function commitPeerRequest(
  fixture: Awaited<ReturnType<typeof durableDispatch>>,
  operationId: string,
  content: string,
): Readonly<Record<string, unknown>> {
  return {
    operation: "git-commit",
    repositoryRoot: fixture.repositoryRoot,
    stateDir: fixture.stateDir,
    attestationRoot: fixture.attestationRoot,
    namespace: fixture.namespace,
    input: {
      attestationId: fixture.prepared.attestationId,
      generation: fixture.prepared.generation,
      gitChangeCapability: fixture.prepared.gitChangeCapability,
      operationId,
      expectedHead: fixture.baseCommit,
      message: operationId,
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("before\n") },
          newState: { mode: "100644", digest: sha256(content) },
        },
      ],
    },
  };
}

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

describe("dispatch-bound Git change capability", () => {
  test("commits once, returns a parent-verifiable receipt, and cannot mutate after result store", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), "t2042-dispatch-broker-"));
    roots.push(repositoryRoot);
    await git(repositoryRoot, ["init", "-q"]);
    await fs.writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
    await git(repositoryRoot, ["add", "file.txt"]);
    await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
    const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const stateDir = path.join(repositoryRoot, ".manager-state");
    const managed = await prepareManagedWorktree(
      { repositoryRoot, taskId: "T2042", baseCommit },
      { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
    );
    if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);

    const store = new InMemoryAttestationStore(NAMESPACE);
    const capability = createDispatchCapability({
      backend: new InMemoryAttestationBackend(store),
      promptArtifactStore: artifactStore(),
      repositoryRoot,
      worktreeStateDir: stateDir,
      now: () => "2026-08-10T12:00:00.000Z",
      randomBytes: sequentialDispatchRandomBytes(0),
    });
    const prepared = await capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2042",
        headline: "exercise broker",
        description: "commit one declared modification",
        acceptance: "one receipt and lifecycle revocation",
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
        baseCommit,
        round: 0,
        startingCommit: baseCommit,
      },
      idempotencyKey: "T2042-integration-round-0",
      timeoutMs: 600_000,
      expectedChild: { childId: "child-t2042", runId: "run-t2042" },
    });
    if (!prepared.accepted || prepared.prepared.gitChangeCapability === undefined) {
      throw new Error("worker dispatch did not receive a Git change capability");
    }
    await capability.fetchInput({
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      inputCapability: prepared.prepared.inputCapability,
    });
    await fs.writeFile(path.join(managed.handle.absolutePath, "file.txt"), "after\n");
    if (capability.gitCommit === undefined) throw new Error("git_commit was not wired");
    const receipt = await capability.gitCommit({
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      gitChangeCapability: prepared.prepared.gitChangeCapability,
      operationId: "T2042-integration-commit-1",
      expectedHead: baseCommit,
      message: "brokered integration change",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("before\n") },
          newState: { mode: "100644", digest: sha256("after\n") },
        },
      ],
    });
    expect(await git(managed.handle.absolutePath, ["rev-parse", `${receipt.newHead}^`])).toBe(
      receipt.oldHead,
    );
    expect(await git(managed.handle.absolutePath, ["rev-parse", `${receipt.newHead}^{tree}`])).toBe(
      receipt.tree,
    );
    await fs.writeFile(path.join(managed.handle.absolutePath, "file.txt"), "after again\n");
    const incrementalReceipt = await capability.gitCommit({
      attestationId: prepared.prepared.attestationId,
      generation: prepared.prepared.generation,
      gitChangeCapability: prepared.prepared.gitChangeCapability,
      operationId: "T2042-integration-commit-2",
      expectedHead: receipt.newHead,
      message: "brokered incremental integration change",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("after\n") },
          newState: { mode: "100644", digest: sha256("after again\n") },
        },
      ],
    });
    expect(incrementalReceipt.oldHead).toBe(receipt.newHead);
    expect(
      await git(managed.handle.absolutePath, ["rev-parse", `${incrementalReceipt.newHead}^`]),
    ).toBe(receipt.newHead);
    const stored = await capability.storeResult({
      resultCapability: prepared.prepared.resultCapability,
      output: {
        taskId: "T2042",
        status: "pass",
        resultCommit: incrementalReceipt.newHead,
        branch: managed.handle.branch,
        actualWorktreePath: managed.handle.absolutePath,
        filesTouched: ["file.txt"],
        gitReceipts: [
          {
            ...receipt,
            objectOids: [...receipt.objectOids],
            paths: [...receipt.paths],
          },
          {
            ...incrementalReceipt,
            objectOids: [...incrementalReceipt.objectOids],
            paths: [...incrementalReceipt.paths],
          },
        ],
        checkSummary: "REAL_CHECK_EXIT=0",
        summary: "broker integration passed",
        gateDurationMs: 1,
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit,
          headCommit: incrementalReceipt.newHead,
        },
      },
    });
    expect(stored.state).toBe("result-stored");
    await expect(
      capability.gitCommit({
        attestationId: prepared.prepared.attestationId,
        generation: prepared.prepared.generation,
        gitChangeCapability: prepared.prepared.gitChangeCapability,
        operationId: "T2042-after-store",
        expectedHead: incrementalReceipt.newHead,
        message: "must not commit",
        changes: [
          {
            kind: "modify",
            path: "file.txt",
            oldState: { mode: "100644", digest: sha256("after again\n") },
            newState: { mode: "100644", digest: sha256("after again\n") },
          },
        ],
      }),
    ).rejects.toThrow(/live prepared dispatch/);
    expect(await git(managed.handle.absolutePath, ["rev-parse", "HEAD"])).toBe(
      incrementalReceipt.newHead,
    );
  });

  // Regression D316: a lost pre-store report stranded its durable broker receipts.
  test("D316 reprepares with an exact immutable prior-generation receipt chain [Behavioral-Active, Effectual-GoodCommunication]", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), "t2082-reprepare-receipts-"));
    roots.push(repositoryRoot);
    await git(repositoryRoot, ["init", "-q"]);
    await fs.writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
    await git(repositoryRoot, ["add", "file.txt"]);
    await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
    const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const stateDir = path.join(repositoryRoot, ".manager-state");
    const managed = await prepareManagedWorktree(
      { repositoryRoot, taskId: "T2082", baseCommit },
      { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
    );
    if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
    let gateRuns = 0;
    const capability = createDispatchCapability({
      backend: new InMemoryAttestationBackend(new InMemoryAttestationStore(NAMESPACE)),
      promptArtifactStore: artifactStore("codex"),
      repositoryRoot,
      worktreeStateDir: stateDir,
      now: () => "2026-08-13T09:00:00.000Z",
      randomBytes: sequentialDispatchRandomBytes(96),
      supervisedWorkerGateRunner: {
        run: async () => {
          gateRuns += 1;
          return {
            gateExitCode: 0,
            passCount: 1,
            failCount: 0,
            gateDurationMs: 10,
            capturedAt: "2026-08-13T09:00:01.000Z",
            outputTail: "1 pass\n0 fail",
          };
        },
      },
    });
    const workerInput = (round: number, startingCommit: string) => ({
      taskId: "T2082",
      headline: "recover a lost broker report",
      description: "inherit prior-generation receipts without synthetic Git effects",
      acceptance: "the retry receives the exact durable receipt chain",
      worktreePath: managed.handle.absolutePath,
      branch: managed.handle.branch,
      baseCommit,
      round,
      startingCommit,
      ...(round === 0 ? {} : { priorResultCommit: startingCommit }),
    });
    const first = await capability.prepare({
      roleId: "implement-worker",
      input: workerInput(0, baseCommit),
      idempotencyKey: "T2082-lost-report-r0",
      timeoutMs: 600_000,
      expectedChild: { childId: "lost-r0", runId: "lost-r0" },
    });
    if (!first.accepted || first.prepared.gitChangeCapability === undefined) {
      throw new Error("first worker did not receive a Git capability");
    }
    await capability.fetchInput({
      ...first.handle,
      inputCapability: first.prepared.inputCapability,
    });
    await fs.writeFile(path.join(managed.handle.absolutePath, "file.txt"), "recovered\n");
    if (capability.gitCommit === undefined) throw new Error("git_commit was not wired");
    const receipt = await capability.gitCommit({
      ...first.handle,
      gitChangeCapability: first.prepared.gitChangeCapability,
      operationId: "T2082-lost-r0-change",
      expectedHead: baseCommit,
      message: "durable change before lost report",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("before\n") },
          newState: { mode: "100644", digest: sha256("recovered\n") },
        },
      ],
    });
    await capability.abort({ ...first.handle, reason: "parent-lost" });

    const callerForged = await capability.prepare({
      roleId: "implement-worker",
      input: {
        ...workerInput(1, receipt.newHead),
        inheritedGitReceipts: [receipt] as unknown as DispatchJSONValue,
      },
      idempotencyKey: "T2082-lost-report-forged-input",
      timeoutMs: 600_000,
      expectedChild: { childId: "lost-forged", runId: "lost-forged" },
      reprepareOf: first.handle,
    });
    expect(callerForged).toMatchObject({
      accepted: false,
      path: "input.inheritedGitReceipts",
    });

    const stale = await capability.prepare({
      roleId: "implement-worker",
      input: workerInput(1, baseCommit),
      idempotencyKey: "T2082-lost-report-stale-tip",
      timeoutMs: 600_000,
      expectedChild: { childId: "lost-stale", runId: "lost-stale" },
      reprepareOf: first.handle,
    });
    expect(stale).toMatchObject({ accepted: false, path: "input.startingCommit" });

    const second = await capability.prepare({
      roleId: "implement-worker",
      input: workerInput(1, receipt.newHead),
      idempotencyKey: "T2082-lost-report-r1",
      timeoutMs: 600_000,
      expectedChild: { childId: "lost-r1", runId: "lost-r1" },
      reprepareOf: first.handle,
    });
    if (!second.accepted) throw new Error(second.detail);
    expect(second.handle).toEqual({
      attestationId: first.handle.attestationId,
      generation: first.handle.generation + 1,
    });
    const materialized = await capability.fetchInput({
      ...second.handle,
      inputCapability: second.prepared.inputCapability,
    });
    expect((materialized.input as Record<string, unknown>)["inheritedGitReceipts"]).toEqual([
      receipt,
    ]);
    const output = {
      taskId: "T2082",
      status: "pass" as const,
      resultCommit: receipt.newHead,
      branch: managed.handle.branch,
      actualWorktreePath: managed.handle.absolutePath,
      filesTouched: ["file.txt"],
      gitReceipts: [receipt],
      checkSummary: "trusted gate delegated to result storage",
      baseVerification: {
        status: "verified" as const,
        relation: "descendant" as const,
        baseCommit,
        headCommit: receipt.newHead,
      },
      summary: "recovered without a synthetic Git effect",
    };
    for (const altered of [
      { ...receipt, requestDigest: "f".repeat(64) },
      { ...receipt, attestationId: `${receipt.attestationId}-foreign` },
      { ...receipt, oldHead: receipt.newHead },
      { ...receipt, newHead: baseCommit },
    ]) {
      await expect(
        capability.storeResult({
          resultCapability: second.prepared.resultCapability,
          output: { ...output, gitReceipts: [altered] } as unknown as DispatchJSONValue,
        }),
      ).rejects.toThrow(/receipt/);
    }
    await expect(
      capability.storeResult({
        resultCapability: second.prepared.resultCapability,
        output: { ...output, filesTouched: [] } as unknown as DispatchJSONValue,
      }),
    ).rejects.toThrow(/filesTouched|receipt paths/);
    expect(gateRuns).toBe(0);
    await expect(
      capability.storeResult({
        resultCapability: second.prepared.resultCapability,
        output: output as unknown as DispatchJSONValue,
      }),
    ).resolves.toMatchObject({ state: "result-stored" });
    expect(gateRuns).toBe(1);
    expect(await git(managed.handle.absolutePath, ["rev-parse", "HEAD"])).toBe(receipt.newHead);
    expect(receipt.generation).toBe(first.handle.generation);
  });

  test("rehydrates a prepared worker's inherited receipt prefix after a broker restart", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), "t2119-inherited-reload-"));
    roots.push(repositoryRoot);
    await git(repositoryRoot, ["init", "-q"]);
    await fs.writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
    await git(repositoryRoot, ["add", "file.txt"]);
    await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
    const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const stateDir = path.join(repositoryRoot, ".manager-state");
    const managed = await prepareManagedWorktree(
      { repositoryRoot, taskId: "T2119", baseCommit },
      { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
    );
    if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
    const namespace: AttestationNamespace = {
      backend: "fs",
      projectKey: "t2119-inherited-reload",
    };
    const attestationRoot = fsAttestationProductionRoot(repositoryRoot);
    const firstChild = { childId: "t2119-child-1", runId: "t2119-run-1" };
    const supervisedWorkerGateRunner = {
      run: async () => ({
        gateExitCode: 0,
        passCount: 1,
        failCount: 0,
        gateDurationMs: 10,
        capturedAt: "2026-08-16T09:00:04.000Z",
        outputTail: "1 pass\n0 fail",
      }),
    };
    let backend = new FsAttestationBackend({ namespace, root: attestationRoot });
    let capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore("codex"),
      repositoryRoot,
      worktreeStateDir: stateDir,
      now: () => "2026-08-16T09:00:00.000Z",
      randomBytes: sequentialDispatchRandomBytes(160),
      supervisedWorkerGateRunner,
    });
    const first = await capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2119",
        headline: "persist generation one",
        description: "complete one brokered generation before reprepare",
        acceptance: "generation one contributes the immutable receipt prefix",
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
        baseCommit,
        round: 0,
        startingCommit: baseCommit,
      },
      idempotencyKey: "T2119-inherited-reload-r0",
      timeoutMs: 600_000,
      expectedChild: firstChild,
    });
    if (!first.accepted || first.prepared.gitChangeCapability === undefined) {
      throw new Error("first worker did not receive a Git capability");
    }
    await capability.fetchInput({
      ...first.handle,
      inputCapability: first.prepared.inputCapability,
    });
    await fs.writeFile(path.join(managed.handle.absolutePath, "file.txt"), "generation one\n");
    if (capability.gitCommit === undefined) throw new Error("git_commit was not wired");
    const firstReceipt = await capability.gitCommit({
      ...first.handle,
      gitChangeCapability: first.prepared.gitChangeCapability,
      operationId: "T2119-generation-1",
      expectedHead: baseCommit,
      message: "generation one",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("before\n") },
          newState: { mode: "100644", digest: sha256("generation one\n") },
        },
      ],
    });
    const firstOutput = {
      taskId: "T2119",
      status: "pass" as const,
      resultCommit: firstReceipt.newHead,
      branch: managed.handle.branch,
      actualWorktreePath: managed.handle.absolutePath,
      filesTouched: ["file.txt"],
      gitReceipts: [firstReceipt],
      checkSummary: "trusted gate delegated to result storage",
      baseVerification: {
        status: "verified" as const,
        relation: "descendant" as const,
        baseCommit,
        headCommit: firstReceipt.newHead,
      },
      summary: "generation one completed",
    };
    await capability.abort({ ...first.handle, reason: "parent-lost" });

    const secondChild = { childId: "t2119-child-2", runId: "t2119-run-2" };
    const second = await capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T2119",
        headline: "persist generation two",
        description: "reload a prepared inherited receipt binding",
        acceptance: "the correction appends one receipt to the exact immutable prefix",
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
        baseCommit,
        round: 1,
        startingCommit: firstReceipt.newHead,
        priorResultCommit: firstReceipt.newHead,
      },
      idempotencyKey: "T2119-inherited-reload-r1",
      timeoutMs: 600_000,
      expectedChild: secondChild,
      reprepareOf: first.handle,
    });
    if (!second.accepted || second.prepared.gitChangeCapability === undefined) {
      throw new Error("second worker did not receive a Git capability");
    }
    expect(second.prepared.generation).toBe(first.prepared.generation + 1);

    await backend.close();
    backend = new FsAttestationBackend({ namespace, root: attestationRoot });
    capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore("codex"),
      repositoryRoot,
      worktreeStateDir: stateDir,
      now: () => "2026-08-16T09:00:02.000Z",
      randomBytes: sequentialDispatchRandomBytes(224),
      supervisedWorkerGateRunner,
    });
    const inherited = await capability.fetchInput({
      ...second.handle,
      inputCapability: second.prepared.inputCapability,
    });
    expect((inherited.input as Record<string, unknown>)["inheritedGitReceipts"]).toEqual([
      firstReceipt,
    ]);

    await fs.writeFile(path.join(managed.handle.absolutePath, "file.txt"), "generation two\n");
    if (capability.gitCommit === undefined) throw new Error("git_commit was not wired");
    const secondReceipt = await capability.gitCommit({
      ...second.handle,
      gitChangeCapability: second.prepared.gitChangeCapability,
      operationId: "T2119-generation-2",
      expectedHead: firstReceipt.newHead,
      message: "generation two correction",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("generation one\n") },
          newState: { mode: "100644", digest: sha256("generation two\n") },
        },
      ],
    });
    expect(secondReceipt.newHead).not.toBe(firstReceipt.newHead);
    const secondOutput = {
      ...firstOutput,
      resultCommit: secondReceipt.newHead,
      gitReceipts: [firstReceipt, secondReceipt],
      baseVerification: {
        ...firstOutput.baseVerification,
        headCommit: secondReceipt.newHead,
      },
      summary: "generation two correction completed after restart",
    };
    await expect(
      capability.storeResult({
        resultCapability: second.prepared.resultCapability,
        output: secondOutput,
      }),
    ).resolves.toMatchObject({ state: "result-stored" });
    await expect(
      capability.confirmCompletion({
        ...second.handle,
        nativeCompletion: {
          kind: "native-completion",
          actor: "trusted-parent",
          ...secondChild,
          completedAt: "2026-08-16T09:00:03.000Z",
        },
        expectedProvenance: second.prepared.promptProvenance,
      }),
    ).resolves.toMatchObject({ state: "consumed" });
    const consumed = await capability.fetch(second.handle);
    expect(consumed).toMatchObject({ state: "consumed", output: secondOutput });
    if (consumed.state !== "consumed") throw new Error(`unexpected state ${consumed.state}`);
    expect((consumed.output as Record<string, unknown>)["gitReceipts"]).toEqual([
      firstReceipt,
      secondReceipt,
    ]);
    await backend.close();
  });

  test("serializes broker commits against result storage, abort, and guarded release in peer processes", async () => {
    for (const contender of ["store-result", "abort", "release"] as const) {
      const fixture = await durableDispatch(contender);
      const content = `${contender}\n`;
      await fs.writeFile(path.join(fixture.managed.handle.absolutePath, "file.txt"), content);
      const blocker = await blockingGit(fixture.repositoryRoot, "second-top");
      const broker = spawnPeer(
        commitPeerRequest(fixture, `T2042-peer-${contender}`, content),
        blocker.environment,
      );
      await waitForFile(blocker.ready);

      const startedFile = path.join(fixture.repositoryRoot, `${contender}.started`);
      const completedFile = path.join(fixture.repositoryRoot, `${contender}.completed`);
      const peerInput =
        contender === "store-result"
          ? {
              resultCapability: fixture.prepared.resultCapability,
              output: {
                taskId: "T2042",
                status: "fail",
                resultCommit: null,
                branch: fixture.managed.handle.branch,
                actualWorktreePath: fixture.managed.handle.absolutePath,
                filesTouched: [],
                checkSummary: "peer serialization probe",
                summary: "controlled failure after the broker effect",
                blockedReason: "serialization probe",
                baseVerification: {
                  status: "unresolvable",
                  reason: "base-missing",
                  baseCommit: null,
                  headCommit: null,
                },
              },
            }
          : contender === "abort"
            ? {
                attestationId: fixture.prepared.attestationId,
                generation: fixture.prepared.generation,
                reason: "cancelled",
              }
            : {
                handle: fixture.managed.handle,
                terminalDisposition: "done",
                deleteBranch: false,
              };
      const peer = spawnPeer({
        operation: contender,
        repositoryRoot: fixture.repositoryRoot,
        stateDir: fixture.stateDir,
        attestationRoot: fixture.attestationRoot,
        namespace: fixture.namespace,
        input: peerInput,
        startedFile,
        completedFile,
      });
      await waitForFile(startedFile);
      await Bun.sleep(150);
      expect(await Bun.file(completedFile).exists(), contender).toBe(false);

      await fs.writeFile(blocker.release, "release\n");
      const [receipt, peerResult] = await Promise.all([broker.result(), peer.result()]);
      expect(receipt["newHead"], contender).toBe(
        await git(fixture.repositoryRoot, ["rev-parse", fixture.managed.handle.branch]),
      );
      expect(await Bun.file(completedFile).exists(), contender).toBe(true);
      expect(contender === "release" ? peerResult["status"] : peerResult["state"], contender).toBe(
        contender === "store-result"
          ? "result-stored"
          : contender === "abort"
            ? "aborted"
            : "released",
      );
    }
  }, 30_000);

  test("a fresh broker process recovers each durable journal and post-index-install boundary", async () => {
    for (const boundary of [
      { trigger: "third-top", state: "intent" },
      { crashBoundary: "after-constructed", state: "constructed" },
      { trigger: "fifth-top", state: "objects-installed" },
      { trigger: "index", state: "ref-advanced" },
      {
        crashBoundary: "after-index-install",
        state: "ref-advanced",
        indexInstalled: true,
      },
    ] as const) {
      const label =
        "crashBoundary" in boundary
          ? `${boundary.state}-${boundary.crashBoundary}`
          : boundary.state;
      const fixture = await durableDispatch(label);
      const content = `${label}\n`;
      await fs.writeFile(path.join(fixture.managed.handle.absolutePath, "file.txt"), content);
      const request = commitPeerRequest(fixture, `T2042-restart-${label}`, content);
      const blocker =
        "trigger" in boundary
          ? await blockingGit(fixture.repositoryRoot, boundary.trigger)
          : undefined;
      const interrupted = spawnPeer(
        "crashBoundary" in boundary
          ? { ...request, crashBoundary: boundary.crashBoundary }
          : request,
        blocker?.environment,
      );
      if (blocker !== undefined) await waitForFile(blocker.ready);
      else {
        const killed = await interrupted.outcome;
        expect(killed.code, label).not.toBe(0);
      }
      const operationDirectories = await fs.readdir(path.join(fixture.stateDir, "git-broker"));
      expect(operationDirectories).toHaveLength(1);
      const operationDirectory = operationDirectories[0];
      if (operationDirectory === undefined) throw new Error("broker operation journal is absent");
      const journalFile = path.join(
        fixture.stateDir,
        "git-broker",
        operationDirectory,
        "journal.json",
      );
      const journal = JSON.parse(await fs.readFile(journalFile, "utf8")) as {
        readonly state: string;
        readonly privateIndex?: string;
      };
      expect(journal.state, label).toBe(boundary.state);
      if ("indexInstalled" in boundary) {
        if (journal.privateIndex === undefined)
          throw new Error("broker journal lacks private index");
        const indexPath = await git(fixture.managed.handle.absolutePath, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "index",
        ]);
        expect(await fs.readFile(indexPath), label).toEqual(
          await fs.readFile(journal.privateIndex),
        );
      }
      if (blocker !== undefined) {
        interrupted.child.kill("SIGKILL");
        const killed = await interrupted.outcome;
        expect(killed.code, label).not.toBe(0);
      }

      const recovered = await spawnPeer(request).result();
      expect(recovered["newHead"], label).toBe(
        await git(fixture.managed.handle.absolutePath, ["rev-parse", "HEAD"]),
      );
      expect(await git(fixture.managed.handle.absolutePath, ["status", "--porcelain"]), label).toBe(
        "",
      );
      expect(await spawnPeer(request).result(), label).toEqual(recovered);
    }
  }, 30_000);

  test("preserves a peer-process ref CAS winner", async () => {
    const fixture = await durableDispatch("ref-cas");
    await fs.writeFile(path.join(fixture.managed.handle.absolutePath, "file.txt"), "candidate\n");
    const baseTree = await git(fixture.repositoryRoot, [
      "rev-parse",
      `${fixture.baseCommit}^{tree}`,
    ]);
    const competingHead = await git(fixture.repositoryRoot, [
      "commit-tree",
      baseTree,
      "-p",
      fixture.baseCommit,
      "-m",
      "peer ref winner",
    ]);
    const blocker = await blockingGit(fixture.repositoryRoot, "update-ref");
    const broker = spawnPeer(
      commitPeerRequest(fixture, "T2042-peer-ref-cas", "candidate\n"),
      blocker.environment,
    );
    await waitForFile(blocker.ready);
    await git(fixture.repositoryRoot, [
      "update-ref",
      `refs/heads/${fixture.managed.handle.branch}`,
      competingHead,
      fixture.baseCommit,
    ]);
    await fs.writeFile(blocker.release, "release\n");
    const rejected = await broker.outcome;
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toMatch(/update-ref failed/);
    expect(await git(fixture.managed.handle.absolutePath, ["rev-parse", "HEAD"])).toBe(
      competingHead,
    );
  });

  test(
    "broker-capable result storage rejects missing or substituted receipt chains",
    async () => {
      let attempt = 0;
      async function storeCandidate(
        mutate: (output: Record<string, unknown>) => void,
      ): Promise<void> {
        attempt += 1;
        const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), `t2042-receipt-${attempt}-`));
        roots.push(repositoryRoot);
        await git(repositoryRoot, ["init", "-q"]);
        await fs.writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
        await git(repositoryRoot, ["add", "file.txt"]);
        await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
        const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
        const stateDir = path.join(repositoryRoot, ".manager-state");
        const managed = await prepareManagedWorktree(
          { repositoryRoot, taskId: "T2042", baseCommit },
          { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
        );
        if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
        const store = new InMemoryAttestationStore(NAMESPACE);
        const capability = createDispatchCapability({
          backend: new InMemoryAttestationBackend(store),
          promptArtifactStore: artifactStore(),
          repositoryRoot,
          worktreeStateDir: stateDir,
          now: () => "2026-08-10T12:00:00.000Z",
          randomBytes: sequentialDispatchRandomBytes(attempt * 16),
        });
        const prepared = await capability.prepare({
          roleId: "implement-worker",
          input: {
            taskId: "T2042",
            headline: "verify receipt chain",
            description: "reject substituted receipt evidence",
            acceptance: "receipt chain matches Git",
            worktreePath: managed.handle.absolutePath,
            branch: managed.handle.branch,
            baseCommit,
            round: 0,
            startingCommit: baseCommit,
          },
          idempotencyKey: `T2042-receipt-attempt-${attempt}`,
          timeoutMs: 600_000,
          expectedChild: { childId: `child-${attempt}`, runId: `run-${attempt}` },
        });
        if (!prepared.accepted || prepared.prepared.gitChangeCapability === undefined) {
          throw new Error("worker dispatch did not receive a Git change capability");
        }
        await capability.fetchInput({
          attestationId: prepared.prepared.attestationId,
          generation: prepared.prepared.generation,
          inputCapability: prepared.prepared.inputCapability,
        });
        if (capability.gitCommit === undefined) throw new Error("git_commit was not wired");
        await fs.writeFile(path.join(managed.handle.absolutePath, "file.txt"), "first\n");
        const first = await capability.gitCommit({
          attestationId: prepared.prepared.attestationId,
          generation: prepared.prepared.generation,
          gitChangeCapability: prepared.prepared.gitChangeCapability,
          operationId: `T2042-receipt-${attempt}-1`,
          expectedHead: baseCommit,
          message: "first receipt",
          changes: [
            {
              kind: "modify",
              path: "file.txt",
              oldState: { mode: "100644", digest: sha256("before\n") },
              newState: { mode: "100644", digest: sha256("first\n") },
            },
          ],
        });
        await fs.writeFile(path.join(managed.handle.absolutePath, "file.txt"), "second\n");
        const second = await capability.gitCommit({
          attestationId: prepared.prepared.attestationId,
          generation: prepared.prepared.generation,
          gitChangeCapability: prepared.prepared.gitChangeCapability,
          operationId: `T2042-receipt-${attempt}-2`,
          expectedHead: first.newHead,
          message: "second receipt",
          changes: [
            {
              kind: "modify",
              path: "file.txt",
              oldState: { mode: "100644", digest: sha256("first\n") },
              newState: { mode: "100644", digest: sha256("second\n") },
            },
          ],
        });
        const output: Record<string, unknown> = {
          taskId: "T2042",
          status: "pass",
          resultCommit: second.newHead,
          branch: managed.handle.branch,
          actualWorktreePath: managed.handle.absolutePath,
          filesTouched: ["file.txt"],
          gitReceipts: [
            { ...first, objectOids: [...first.objectOids], paths: [...first.paths] },
            { ...second, objectOids: [...second.objectOids], paths: [...second.paths] },
          ],
          checkSummary: "REAL_CHECK_EXIT=0",
          summary: "receipt verification candidate",
          gateDurationMs: 1,
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit,
            headCommit: second.newHead,
          },
        };
        mutate(output);
        await expect(
          capability.storeResult({
            resultCapability: prepared.prepared.resultCapability,
            output: output as never,
          }),
        ).rejects.toThrow(/receipt/i);
      }

      await storeCandidate((output) => {
        delete output["gitReceipts"];
      });
      await storeCandidate((output) => {
        const receipts = output["gitReceipts"] as Record<string, unknown>[];
        receipts.shift();
      });
      await storeCandidate((output) => {
        const receipts = output["gitReceipts"] as Record<string, unknown>[];
        receipts[0] = { ...receipts[0], operationId: "substituted-operation" };
      });
      await storeCandidate((output) => {
        const receipts = output["gitReceipts"] as Record<string, unknown>[];
        receipts[0] = { ...receipts[0], requestDigest: "f".repeat(64) };
      });
      await storeCandidate((output) => {
        const receipts = output["gitReceipts"] as Record<string, unknown>[];
        receipts[0] = { ...receipts[0], committedAt: "2099-01-01T00:00:00.000Z" };
      });
      await storeCandidate((output) => {
        const receipts = output["gitReceipts"] as Record<string, unknown>[];
        const first = receipts[0]!;
        receipts[0] = {
          ...first,
          objectOids: [first["newHead"], first["tree"]],
        };
      });
      await storeCandidate((output) => {
        const receipts = output["gitReceipts"] as Record<string, unknown>[];
        const first = receipts[0]!;
        const second = receipts[1]!;
        receipts[0] = {
          ...first,
          objectOids: [...(first["objectOids"] as string[]), second["newHead"]],
        };
      });
      await storeCandidate((output) => {
        const receipts = output["gitReceipts"] as Record<string, unknown>[];
        receipts[1] = { ...receipts[1], oldHead: "a".repeat(40) };
      });
      await storeCandidate((output) => {
        const receipts = output["gitReceipts"] as Record<string, unknown>[];
        receipts[1] = { ...receipts[1], tree: "a".repeat(40) };
      });
      await storeCandidate((output) => {
        const receipts = output["gitReceipts"] as Record<string, unknown>[];
        receipts[1] = { ...receipts[1], paths: ["other.txt"] };
      });
      await storeCandidate((output) => {
        const receipts = output["gitReceipts"] as Record<string, unknown>[];
        const first = receipts[0]!;
        output["resultCommit"] = first["newHead"];
        output["baseVerification"] = {
          ...(output["baseVerification"] as Record<string, unknown>),
          headCommit: first["newHead"],
        };
      });
    },
    RECEIPT_CHAIN_MATRIX_TIMEOUT_MS,
  );
});
