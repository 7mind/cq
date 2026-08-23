/**
 * T2042 — Effectual Good-Communication tests for the dispatch attestation,
 * managed-worktree registry, broker, and result-store lock integration.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import {
  createLedgerStore,
  fsAttestationProductionRoot,
  MILESTONES_AMBIENT_ID,
  prepareManagedWorktree,
  resolveManagedWorktreeDispatchBinding,
  TASKS_LEDGER,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const exec = promisify(execFile);
const roots: string[] = [];
const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "t2042-integration" };
const PEER_FIXTURE = new URL("./fixtures/gitChangeBrokerPeer.ts", import.meta.url).pathname;
const RECEIPT_CHAIN_MATRIX_TIMEOUT_MS = 30_000;
const CQ_CLI = new URL("../../cq-cli/src/main.ts", import.meta.url).pathname;
const GUARDED_REBASE_SETUP_TIMEOUT_MS = 120_000;
const D334_GIT_USER_NAME = "CQ D334 fixture";
const D334_GIT_USER_EMAIL = "d334@example.invalid";
/** Test-glob path the guarded fixture's change touches, so mutation evidence is mandatory. */
const GUARDED_FIXTURE_PATH = "pkg/test/guarded-fixture.test.ts";
const openBackends = new Set<FsAttestationBackend>();

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
    schemaVersion: 9,
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

type DispatchCapabilityInstance = ReturnType<typeof createDispatchCapability>;
type AcceptedPrepare = Extract<
  Awaited<ReturnType<DispatchCapabilityInstance["prepare"]>>,
  { readonly accepted: true }
>;

interface GuardedRetryFixture {
  readonly label: string;
  readonly repositoryRoot: string;
  readonly stateDir: string;
  readonly managed: Extract<
    Awaited<ReturnType<typeof prepareManagedWorktree>>,
    { status: "prepared" }
  >;
  readonly namespace: AttestationNamespace;
  readonly attestationRoot: string;
  readonly baseCommit: string;
  readonly capability: DispatchCapabilityInstance;
  readonly backend: FsAttestationBackend;
  readonly first: AcceptedPrepare;
  readonly firstReceipt: Awaited<ReturnType<NonNullable<DispatchCapabilityInstance["gitCommit"]>>>;
}

function openGuardedRetryCapability(
  fixture: Pick<
    GuardedRetryFixture,
    "repositoryRoot" | "stateDir" | "namespace" | "attestationRoot"
  >,
  randomSeed: number,
): {
  readonly backend: FsAttestationBackend;
  readonly capability: DispatchCapabilityInstance;
} {
  const backend = new FsAttestationBackend({
    namespace: fixture.namespace,
    root: fixture.attestationRoot,
  });
  openBackends.add(backend);
  return {
    backend,
    capability: createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore("codex"),
      repositoryRoot: fixture.repositoryRoot,
      worktreeStateDir: fixture.stateDir,
      now: () => "2026-08-18T12:00:00.000Z",
      randomBytes: sequentialDispatchRandomBytes(randomSeed),
      supervisedWorkerGateRunner: {
        run: async () => ({
          gateExitCode: 0,
          passCount: 1,
          failCount: 0,
          gateDurationMs: 10,
          capturedAt: "2026-08-18T12:00:01.000Z",
          outputTail: "1 pass\n0 fail",
        }),
      },
    }),
  };
}

async function closeGuardedRetryBackend(backend: FsAttestationBackend): Promise<void> {
  await backend.close();
  openBackends.delete(backend);
}

function guardedWorkerInput(
  fixture: Pick<GuardedRetryFixture, "managed" | "baseCommit">,
  round: number,
  startingCommit: string,
) {
  return {
    taskId: "T2148",
    headline: "reproduce the remaining current-main worker authority gaps",
    description: "exercise one exact brokered worker continuation boundary",
    acceptance: "the public dispatch lifecycle completes at the managed worktree tip",
    worktreePath: fixture.managed.handle.absolutePath,
    branch: fixture.managed.handle.branch,
    baseCommit: fixture.baseCommit,
    round,
    startingCommit,
    ...(round === 0 ? {} : { priorResultCommit: startingCommit }),
  };
}

async function createGuardedRetryFixture(
  label: string,
  randomSeed: number,
  productionManagerState = false,
): Promise<GuardedRetryFixture> {
  const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), `t2148-${label}-`));
  roots.push(repositoryRoot);
  await git(repositoryRoot, [
    "init",
    "-q",
    ...(productionManagerState ? ["--initial-branch=main"] : []),
  ]);
  if (productionManagerState) {
    await git(repositoryRoot, ["config", "--local", "user.name", D334_GIT_USER_NAME]);
    await git(repositoryRoot, ["config", "--local", "user.email", D334_GIT_USER_EMAIL]);
  }
  await fs.mkdir(path.join(repositoryRoot, "pkg", "test"), { recursive: true });
  await fs.writeFile(path.join(repositoryRoot, GUARDED_FIXTURE_PATH), "before\n");
  await git(repositoryRoot, ["add", GUARDED_FIXTURE_PATH]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (productionManagerState) {
    expect(await git(repositoryRoot, ["rev-parse", "--verify", "refs/heads/main"])).toBe(
      baseCommit,
    );
  }
  const stateDir = productionManagerState
    ? path.join(repositoryRoot, ".claude", "worktrees", ".cq-managed-registry")
    : path.join(repositoryRoot, ".manager-state");
  const managed = await prepareManagedWorktree(
    { repositoryRoot, taskId: "T2148", baseCommit },
    { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
  );
  if (managed.status !== "prepared")
    throw new Error(`${label}: unexpected prepare ${managed.status}`);
  const namespace: AttestationNamespace = { backend: "fs", projectKey: `t2148-${label}` };
  const attestationRoot = fsAttestationProductionRoot(repositoryRoot);
  const opened = openGuardedRetryCapability(
    { repositoryRoot, stateDir, namespace, attestationRoot },
    randomSeed,
  );
  const partial = {
    label,
    repositoryRoot,
    stateDir,
    managed,
    namespace,
    attestationRoot,
    baseCommit,
    capability: opened.capability,
    backend: opened.backend,
  };
  const first = await opened.capability.prepare({
    roleId: "implement-worker",
    input: guardedWorkerInput(partial, 0, baseCommit),
    idempotencyKey: `T2148-${label}-round-0`,
    timeoutMs: 600_000,
    expectedChild: { childId: `${label}-round-0`, runId: `${label}-round-0` },
  });
  if (!first.accepted || first.prepared.gitChangeCapability === undefined) {
    throw new Error(`${label}: initial worker prepare did not allocate the broker capability`);
  }
  await opened.capability.fetchInput({
    ...first.handle,
    inputCapability: first.prepared.inputCapability,
  });
  await fs.writeFile(path.join(managed.handle.absolutePath, GUARDED_FIXTURE_PATH), "first\n");
  if (opened.capability.gitCommit === undefined) throw new Error("git_commit was not wired");
  const firstReceipt = await opened.capability.gitCommit({
    ...first.handle,
    gitChangeCapability: first.prepared.gitChangeCapability,
    operationId: `t2148-${label}-round-0-change`,
    expectedHead: baseCommit,
    message: `${label}: durable first-generation change`,
    changes: [
      {
        kind: "modify",
        path: GUARDED_FIXTURE_PATH,
        oldState: { mode: "100644", digest: sha256("before\n") },
        newState: { mode: "100644", digest: sha256("first\n") },
      },
    ],
  });
  await opened.capability.abort({ ...first.handle, reason: "parent-lost" });
  return { ...partial, first, firstReceipt };
}

interface GuardedRebaseContinuationContext {
  readonly guardedRebase: string;
  readonly oldResultCommit: string;
  readonly ontoCommit: string;
  readonly rebasedStartCommit: string;
}

interface GuardedContinuationReceiptContext {
  readonly handle: AcceptedPrepare["handle"];
  readonly resultCommit: string;
  readonly receipts: readonly GuardedRetryFixture["firstReceipt"][];
}

async function completeGuardedContinuation(
  fixture: GuardedRetryFixture,
  capability: DispatchCapabilityInstance,
  prepared: AcceptedPrepare,
  context: GuardedRebaseContinuationContext,
  round: number,
  correction: {
    readonly content: string;
    readonly baseReceipts: readonly GuardedRetryFixture["firstReceipt"][];
  },
): Promise<GuardedContinuationReceiptContext> {
  const materialized = await capability.fetchInput({
    ...prepared.handle,
    inputCapability: prepared.prepared.inputCapability,
  });
  const input = materialized.input as Readonly<Record<string, unknown>>;
  const injected = input["guardedRebaseLineage"] as Readonly<Record<string, unknown>> | undefined;
  if (injected === undefined) {
    throw new Error("guarded-rebase continuation did not receive the server-injected lineage");
  }
  if (
    JSON.stringify(injected) !==
    JSON.stringify({
      guardedRebase: context.guardedRebase,
      oldResultCommit: context.oldResultCommit,
      ontoCommit: context.ontoCommit,
      rebasedStartCommit: context.rebasedStartCommit,
      exactTip: true,
    })
  ) {
    throw new Error(`guarded-rebase lineage mismatch: ${JSON.stringify(injected)}`);
  }
  const inherited = input["inheritedGitReceipts"];
  if (round === 1 && inherited !== undefined) {
    throw new Error("a pre-rebase receipt must never be inherited across a guarded rebase");
  }
  if (
    round > 1 &&
    (inherited === undefined ||
      JSON.stringify(inherited) !== JSON.stringify(correction.baseReceipts))
  ) {
    throw new Error("a guarded correction lost its exact post-rebase receipt prefix");
  }
  await fs.writeFile(
    path.join(fixture.managed.handle.absolutePath, GUARDED_FIXTURE_PATH),
    correction.content,
  );
  if (capability.gitCommit === undefined || prepared.prepared.gitChangeCapability === undefined) {
    throw new Error("guarded-rebase continuation did not receive git_commit authorization");
  }
  if (prepared.prepared.parentGateCapability === undefined) {
    throw new Error("guarded-rebase continuation did not receive parent gate authority");
  }
  const parentGateCapability = prepared.prepared.parentGateCapability;
  const expectedHead =
    round === 1 ? context.rebasedStartCommit : correction.baseReceipts.at(-1)!.newHead;
  const currentReceipt = await capability.gitCommit({
    ...prepared.handle,
    gitChangeCapability: prepared.prepared.gitChangeCapability,
    operationId: `t2148-${fixture.label}-round-${String(round)}-change`,
    expectedHead,
    message: `${fixture.label}: continue after the guarded rebase (round ${String(round)})`,
    changes: [
      {
        kind: "modify",
        path: GUARDED_FIXTURE_PATH,
        oldState: { mode: "100644", digest: sha256(round === 1 ? "first\n" : "continued\n") },
        newState: { mode: "100644", digest: sha256(correction.content) },
      },
    ],
  });
  const receipts = [...correction.baseReceipts, currentReceipt];
  const stored = await capability.storeResult({
    resultCapability: prepared.prepared.resultCapability,
    output: {
      taskId: "T2148",
      status: "pass",
      resultCommit: currentReceipt.newHead,
      branch: fixture.managed.handle.branch,
      actualWorktreePath: fixture.managed.handle.absolutePath,
      filesTouched: [GUARDED_FIXTURE_PATH],
      gitReceipts: receipts,
      gitLineage: {
        kind: "guarded-rebase",
        guardedRebase: context.guardedRebase,
        ontoCommit: context.ontoCommit,
        rebasedStartCommit: context.rebasedStartCommit,
        exactTip: true,
      },
      checkSummary: "trusted gate delegated to result storage",
      baseVerification: {
        status: "verified",
        relation: "descendant",
        baseCommit: context.ontoCommit,
        headCommit: currentReceipt.newHead,
      },
      summary: "completed the guarded-rebase continuation through public lifecycle boundaries",
      mutationTable: [
        {
          mutation: `${GUARDED_FIXTURE_PATH}: replaced the rebased content with the round ${String(round)} continuation`,
          observed: "the durable broker receipt pins the exact rebased-to-continuation diff",
          restored: "the continuation content is committed verbatim by the broker",
        },
      ],
    } as unknown as DispatchJSONValue,
  });
  if (stored.state !== "gate-pending") throw new Error(`unexpected stored state ${stored.state}`);
  if (capability.finalizeParentGate === undefined) {
    throw new Error("guarded-rebase continuation lacks parent gate finalization");
  }
  const finalized = await capability.finalizeParentGate({
    ...prepared.handle,
    parentGateCapability,
  });
  if (finalized.state !== "result-stored") {
    throw new Error(`unexpected finalized state ${finalized.state}`);
  }
  const confirmed = await capability.confirmCompletion({
    ...prepared.handle,
    nativeCompletion: {
      kind: "native-completion",
      actor: "trusted-parent",
      childId: `${fixture.label}-round-${String(round)}`,
      runId: `${fixture.label}-round-${String(round)}`,
      completedAt: "2026-08-18T12:00:02.000Z",
    },
    expectedProvenance: prepared.prepared.promptProvenance,
  });
  if (confirmed.state !== "consumed") {
    throw new Error(`unexpected confirmation ${confirmed.state}`);
  }
  const fetched = await capability.fetch(prepared.handle);
  if (fetched.state !== "consumed") throw new Error(`unexpected fetched state ${fetched.state}`);
  const output = fetched.output as Readonly<Record<string, unknown>>;
  if (JSON.stringify(output["gitReceipts"]) !== JSON.stringify(receipts)) {
    throw new Error("consumed result lost the exact guarded-rebase receipt suffix");
  }
  if (
    JSON.stringify(output["gitLineage"]) !==
    JSON.stringify({
      kind: "guarded-rebase",
      guardedRebase: context.guardedRebase,
      ontoCommit: context.ontoCommit,
      rebasedStartCommit: context.rebasedStartCommit,
      exactTip: true,
    })
  ) {
    throw new Error("consumed result lost the exact guarded-rebase lineage");
  }
  return { handle: prepared.handle, resultCommit: currentReceipt.newHead, receipts };
}

afterAll(async () => {
  for (const backend of openBackends) await backend.close();
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
    const attestationStore = new InMemoryAttestationStore(NAMESPACE);
    const capability = createDispatchCapability({
      backend: new InMemoryAttestationBackend(attestationStore),
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
    const liveBinding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot,
        taskId: managed.handle.taskId,
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
      },
      { stateDir },
    );
    if (liveBinding === null || capability.resolveRecovery === undefined) {
      throw new Error("managed recovery resolution was not wired");
    }
    const recovery = await capability.resolveRecovery(liveBinding, receipt.newHead);
    expect(recovery).toMatchObject({
      status: "dispatch-recovery-resolved",
      taskId: "T2082",
      liveTip: receipt.newHead,
    });
    const rowsBeforeForgery = attestationStore.rows().length;
    const forgedRecovery = await capability.prepare({
      roleId: "implement-worker",
      input: workerInput(1, receipt.newHead),
      idempotencyKey: "T2082-lost-report-forged-recovery",
      timeoutMs: 600_000,
      expectedChild: { childId: "lost-forged-recovery", runId: "lost-forged-recovery" },
      recovery: `cq-dispatch-recovery:v1:${"f".repeat(64)}`,
    });
    expect(forgedRecovery).toMatchObject({ accepted: false, path: "recovery" });
    expect(attestationStore.rows()).toHaveLength(rowsBeforeForgery);

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
      recovery: recovery.recoveryReference,
    });
    if (!second.accepted) throw new Error(second.detail);
    if (second.prepared.parentGateCapability === undefined) {
      throw new Error("Codex retry did not receive parent gate authority");
    }
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
    ).resolves.toMatchObject({ state: "gate-pending" });
    expect(gateRuns).toBe(0);
    if (capability.finalizeParentGate === undefined) {
      throw new Error("Codex retry lacks parent gate finalization");
    }
    await expect(
      capability.finalizeParentGate({
        ...second.handle,
        parentGateCapability: second.prepared.parentGateCapability,
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
    if (
      !second.accepted ||
      second.prepared.gitChangeCapability === undefined ||
      second.prepared.parentGateCapability === undefined
    ) {
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
    await expect(
      capability.fetchInput({
        ...second.handle,
        inputCapability: second.prepared.inputCapability,
      }),
    ).rejects.toThrow(/already materialized/);

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
        output: secondOutput as unknown as DispatchJSONValue,
      }),
    ).resolves.toMatchObject({ state: "gate-pending" });
    if (capability.finalizeParentGate === undefined) {
      throw new Error("restarted broker lacks parent gate finalization");
    }
    await expect(
      capability.finalizeParentGate({
        ...second.handle,
        parentGateCapability: second.prepared.parentGateCapability,
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

  test("a consumed parked worker resumes through restart-stable continuation authority [Behavioral-Progression Blackbox-GoodCommunication]", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), "t2310-consumed-continuation-"));
    roots.push(repositoryRoot);
    await git(repositoryRoot, ["init", "-q"]);
    await fs.writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
    await git(repositoryRoot, ["add", "file.txt"]);
    await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
    const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const stateDir = path.join(repositoryRoot, ".manager-state");
    const managed = await prepareManagedWorktree(
      { repositoryRoot, taskId: "T2310", baseCommit },
      { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
    );
    if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
    const namespace: AttestationNamespace = {
      backend: "fs",
      projectKey: "t2310-consumed-continuation",
    };
    const attestationRoot = fsAttestationProductionRoot(repositoryRoot);
    const gateRunner = {
      run: async () => ({
        gateExitCode: 0,
        passCount: 1,
        failCount: 0,
        gateDurationMs: 10,
        capturedAt: "2026-08-22T20:00:02.000Z",
        outputTail: "1 pass\n0 fail",
      }),
    };
    let backend = new FsAttestationBackend({ namespace, root: attestationRoot });
    let capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore("codex"),
      repositoryRoot,
      worktreeStateDir: stateDir,
      now: () => "2026-08-22T20:00:00.000Z",
      randomBytes: sequentialDispatchRandomBytes(2310),
      supervisedWorkerGateRunner: gateRunner,
    });
    const workerInput = (round: number, startingCommit: string) => ({
      taskId: "T2310",
      headline: "resume a consumed parked worker",
      description: "retain continuation authority across a broker restart",
      acceptance: "the resumed generation inherits the exact receipt closure",
      worktreePath: managed.handle.absolutePath,
      branch: managed.handle.branch,
      baseCommit,
      round,
      startingCommit,
      ...(round === 0 ? {} : { priorResultCommit: startingCommit }),
    });
    const firstChild = { childId: "t2310-child-1", runId: "t2310-run-1" };
    const first = await capability.prepare({
      roleId: "implement-worker",
      input: workerInput(0, baseCommit),
      idempotencyKey: "T2310-consumed-r0",
      timeoutMs: 600_000,
      expectedChild: firstChild,
    });
    if (
      !first.accepted ||
      first.prepared.gitChangeCapability === undefined ||
      first.prepared.parentGateCapability === undefined ||
      capability.gitCommit === undefined ||
      capability.finalizeParentGate === undefined
    ) {
      throw new Error("first worker lacks brokered completion authority");
    }
    await capability.fetchInput({
      ...first.handle,
      inputCapability: first.prepared.inputCapability,
    });
    await fs.writeFile(path.join(managed.handle.absolutePath, "file.txt"), "consumed\n");
    const receipt = await capability.gitCommit({
      ...first.handle,
      gitChangeCapability: first.prepared.gitChangeCapability,
      operationId: "T2310-consumed-r0-change",
      expectedHead: baseCommit,
      message: "persist consumed generation",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("before\n") },
          newState: { mode: "100644", digest: sha256("consumed\n") },
        },
      ],
    });
    const output = {
      taskId: "T2310",
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
      summary: "generation one consumed before the task was parked",
    };
    await capability.storeResult({
      resultCapability: first.prepared.resultCapability,
      output: output as unknown as DispatchJSONValue,
    });
    await capability.finalizeParentGate({
      ...first.handle,
      parentGateCapability: first.prepared.parentGateCapability,
    });
    await capability.confirmCompletion({
      ...first.handle,
      nativeCompletion: {
        kind: "native-completion",
        actor: "trusted-parent",
        ...firstChild,
        completedAt: "2026-08-22T20:00:03.000Z",
      },
      expectedProvenance: first.prepared.promptProvenance,
    });

    // The orchestrator parks the task by retaining its manager handle, while
    // the process-local capability and every cached attestation projection die.
    await backend.close();
    backend = new FsAttestationBackend({ namespace, root: attestationRoot });
    capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore("codex"),
      repositoryRoot,
      worktreeStateDir: stateDir,
      now: () => "2026-08-22T20:00:04.000Z",
      randomBytes: sequentialDispatchRandomBytes(2410),
      supervisedWorkerGateRunner: gateRunner,
    });
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot,
        taskId: managed.handle.taskId,
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
      },
      { stateDir },
    );
    if (binding === null || capability.resolveContinuation === undefined) {
      throw new Error("restart-stable consumed continuation resolution was not wired");
    }
    const continuation = await capability.resolveContinuation(binding, receipt.newHead);
    expect(continuation).toMatchObject({
      status: "dispatch-continuation-resolved",
      taskId: "T2310",
      liveTip: receipt.newHead,
    });
    expect(continuation.continuationReference).toMatch(
      /^cq-dispatch-continuation:v1:[0-9a-f]{64}$/,
    );
    const second = await capability.prepare({
      roleId: "implement-worker",
      input: workerInput(1, receipt.newHead),
      idempotencyKey: "T2310-consumed-r1",
      timeoutMs: 600_000,
      expectedChild: { childId: "t2310-child-2", runId: "t2310-run-2" },
      continuation: continuation.continuationReference,
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
  });

  test("successful continuation prepare and consumed confirm replay without mutable manager state [Behavioral-Active Blackbox-GoodCommunication]", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), "t2312-continuation-replay-"));
    roots.push(repositoryRoot);
    await git(repositoryRoot, ["init", "-q"]);
    await fs.writeFile(path.join(repositoryRoot, "file.txt"), "before\n");
    await git(repositoryRoot, ["add", "file.txt"]);
    await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
    const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const stateDir = path.join(repositoryRoot, ".manager-state");
    const managed = await prepareManagedWorktree(
      { repositoryRoot, taskId: "T2312", baseCommit },
      { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
    );
    if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
    const namespace: AttestationNamespace = {
      backend: "fs",
      projectKey: "t2312-continuation-replay",
    };
    const backend = new FsAttestationBackend({
      namespace,
      root: fsAttestationProductionRoot(repositoryRoot),
    });
    const capability = createDispatchCapability({
      backend,
      promptArtifactStore: artifactStore("codex"),
      repositoryRoot,
      worktreeStateDir: stateDir,
      now: () => "2026-08-23T00:00:00.000Z",
      randomBytes: sequentialDispatchRandomBytes(2512),
      supervisedWorkerGateRunner: {
        run: async () => ({
          gateExitCode: 0,
          passCount: 1,
          failCount: 0,
          gateDurationMs: 10,
          capturedAt: "2026-08-23T00:00:02.000Z",
          outputTail: "1 pass\n0 fail",
        }),
      },
    });
    const workerInput = (round: number, startingCommit: string) => ({
      taskId: "T2312",
      headline: "replay a successful consumed continuation",
      description: "do not re-resolve terminal work after success",
      acceptance: "identical prepare and confirm calls return their original result",
      worktreePath: managed.handle.absolutePath,
      branch: managed.handle.branch,
      baseCommit,
      round,
      startingCommit,
      ...(round === 0 ? {} : { priorResultCommit: startingCommit }),
    });
    const firstChild = { childId: "t2312-child-1", runId: "t2312-run-1" };
    const first = await capability.prepare({
      roleId: "implement-worker",
      input: workerInput(0, baseCommit),
      idempotencyKey: "T2312-consumed-r0",
      timeoutMs: 600_000,
      expectedChild: firstChild,
    });
    if (
      !first.accepted ||
      first.prepared.gitChangeCapability === undefined ||
      first.prepared.parentGateCapability === undefined ||
      capability.gitCommit === undefined ||
      capability.finalizeParentGate === undefined ||
      capability.resolveContinuation === undefined
    ) {
      throw new Error("first worker lacks brokered completion authority");
    }
    await capability.fetchInput({
      ...first.handle,
      inputCapability: first.prepared.inputCapability,
    });
    await fs.writeFile(path.join(managed.handle.absolutePath, "file.txt"), "consumed\n");
    const receipt = await capability.gitCommit({
      ...first.handle,
      gitChangeCapability: first.prepared.gitChangeCapability,
      operationId: "T2312-consumed-r0-change",
      expectedHead: baseCommit,
      message: "persist consumed generation",
      changes: [
        {
          kind: "modify",
          path: "file.txt",
          oldState: { mode: "100644", digest: sha256("before\n") },
          newState: { mode: "100644", digest: sha256("consumed\n") },
        },
      ],
    });
    await capability.storeResult({
      resultCapability: first.prepared.resultCapability,
      output: {
        taskId: "T2312",
        status: "pass",
        resultCommit: receipt.newHead,
        branch: managed.handle.branch,
        actualWorktreePath: managed.handle.absolutePath,
        filesTouched: ["file.txt"],
        gitReceipts: [receipt],
        checkSummary: "trusted gate delegated to result storage",
        baseVerification: {
          status: "verified",
          relation: "descendant",
          baseCommit,
          headCommit: receipt.newHead,
        },
        summary: "generation one consumed before replay",
      } as unknown as DispatchJSONValue,
    });
    await capability.finalizeParentGate({
      ...first.handle,
      parentGateCapability: first.prepared.parentGateCapability,
    });
    const confirmation = {
      ...first.handle,
      nativeCompletion: {
        kind: "native-completion" as const,
        actor: "trusted-parent" as const,
        ...firstChild,
        completedAt: "2026-08-23T00:00:03.000Z",
      },
      expectedProvenance: first.prepared.promptProvenance,
    };
    const consumed = await capability.confirmCompletion(confirmation);
    const binding = await resolveManagedWorktreeDispatchBinding(
      {
        repositoryRoot,
        taskId: managed.handle.taskId,
        worktreePath: managed.handle.absolutePath,
        branch: managed.handle.branch,
      },
      { stateDir },
    );
    if (binding === null) throw new Error("managed continuation binding disappeared");
    const continuation = await capability.resolveContinuation(binding, receipt.newHead);
    const secondRequest = {
      roleId: "implement-worker",
      input: workerInput(1, receipt.newHead),
      idempotencyKey: "T2312-consumed-r1",
      timeoutMs: 600_000,
      expectedChild: { childId: "t2312-child-2", runId: "t2312-run-2" },
      continuation: continuation.continuationReference,
    } as const;
    const second = await capability.prepare(secondRequest);
    if (!second.accepted) throw new Error(second.detail);

    await fs.rename(
      managed.handle.absolutePath,
      path.join(repositoryRoot, ".unavailable-managed-worktree"),
    );
    await fs.rename(stateDir, `${stateDir}.unavailable`);
    const [prepareReplay, confirmReplay] = await Promise.allSettled([
      capability.prepare(secondRequest),
      capability.confirmCompletion(confirmation),
    ]);
    expect(confirmReplay).toEqual({ status: "fulfilled", value: consumed });
    expect(prepareReplay).toEqual({ status: "fulfilled", value: second });
    await backend.close();
  });

  describe("T2148 current-main worker authority regressions", () => {
    let d332!: GuardedRetryFixture;
    let d334!: GuardedRetryFixture;
    let d334RebasedHead!: string;
    let d334OntoCommit!: string;
    let d334GuardedRebase!: string;
    let d334Negative!: GuardedRetryFixture;
    let d334NegativeRebasedHead!: string;
    let d334NegativeOntoCommit!: string;
    let d334NegativeReference!: string;
    let d334ExactTip!: GuardedRetryFixture;
    let d334ExactTipRebasedHead!: string;
    let d334ExactTipOntoCommit!: string;
    let d334ExactTipReference!: string;

    async function runGuardedRebaseCli(
      fixture: GuardedRetryFixture,
      ontoCommit: string,
      operationId: string,
    ): Promise<{ readonly rebasedHead: string; readonly reference: string }> {
      const run = await exec(
        process.execPath,
        [
          "run",
          CQ_CLI,
          "gate",
          "git-effect",
          "--operation",
          "rebase",
          "--cwd",
          fixture.repositoryRoot,
          "--task-id",
          "T2148",
          "--commit",
          ontoCommit,
          "--operation-id",
          operationId,
        ],
        { cwd: fixture.repositoryRoot, encoding: "utf8", env: process.env },
      );
      const match = /^CQ_GUARDED_REBASE_REFERENCE=(\S+)$/mu.exec(run.stdout);
      if (match === null) {
        throw new Error(`guarded rebase emitted no reference: ${run.stdout}\n${run.stderr}`);
      }
      return {
        rebasedHead: await git(fixture.managed.handle.absolutePath, ["rev-parse", "HEAD"]),
        reference: match[1]!,
      };
    }

    async function setupGuardedRebase(
      fixture: GuardedRetryFixture,
      operationId: string,
    ): Promise<{
      readonly ontoCommit: string;
      readonly rebasedHead: string;
      readonly reference: string;
    }> {
      await closeGuardedRetryBackend(fixture.backend);
      await fs.writeFile(path.join(fixture.repositoryRoot, ".gitignore"), ".claude/\n.cq/\n");
      await fs.writeFile(
        path.join(fixture.repositoryRoot, "cq.toml"),
        '[ledger]\nbackend = "fs"\n',
      );
      await fs.writeFile(path.join(fixture.repositoryRoot, "main.txt"), "advanced main\n");
      await git(fixture.repositoryRoot, ["add", ".gitignore", "cq.toml", "main.txt"]);
      await git(fixture.repositoryRoot, ["commit", "-q", "-m", "advance main"]);
      const ontoCommit = await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
      const ledger = await createLedgerStore(fixture.repositoryRoot);
      try {
        await ledger.store.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
          id: "T2148",
          status: "wip",
          fields: { headline: "D334 guarded-rebase continuation" },
        });
      } finally {
        await ledger.store.dispose();
      }
      const { rebasedHead, reference } = await runGuardedRebaseCli(
        fixture,
        ontoCommit,
        operationId,
      );
      if (rebasedHead === fixture.firstReceipt.newHead) {
        throw new Error("D334 setup did not produce a real rebased commit");
      }
      return { ontoCommit, rebasedHead, reference };
    }

    beforeAll(async () => {
      d332 = await createGuardedRetryFixture("d332-lineage-free", 2_148);

      d334 = await createGuardedRetryFixture("d334-guarded-rebase", 2_149, true);
      const setup = await setupGuardedRebase(d334, "d334-guarded-rebase-operation");
      d334OntoCommit = setup.ontoCommit;
      d334RebasedHead = setup.rebasedHead;
      d334GuardedRebase = setup.reference;

      d334Negative = await createGuardedRetryFixture("d334-negative", 2_152, true);
      const negative = await setupGuardedRebase(d334Negative, "d334-negative-rebase-operation");
      d334NegativeOntoCommit = negative.ontoCommit;
      d334NegativeRebasedHead = negative.rebasedHead;
      d334NegativeReference = negative.reference;

      d334ExactTip = await createGuardedRetryFixture("d334-exact-tip", 2_153, true);
      const exactTip = await setupGuardedRebase(d334ExactTip, "d334-exact-tip-rebase-operation");
      d334ExactTipOntoCommit = exactTip.ontoCommit;
      d334ExactTipRebasedHead = exactTip.rebasedHead;
      d334ExactTipReference = exactTip.reference;
    }, GUARDED_REBASE_SETUP_TIMEOUT_MS);

    test("D332 rejects a lineage-free implement-worker retry at an advanced managed-worktree tip [Behavioral-Progression Blackbox-GoodCommunication]", async () => {
      let retry: Awaited<ReturnType<DispatchCapabilityInstance["prepare"]>>;
      try {
        retry = await d332.capability.prepare({
          roleId: "implement-worker",
          input: guardedWorkerInput(d332, 1, d332.firstReceipt.newHead),
          idempotencyKey: "T2148-d332-lineage-free-round-1",
          timeoutMs: 600_000,
          expectedChild: {
            childId: "d332-lineage-free-round-1",
            runId: "d332-lineage-free-round-1",
          },
        });
      } catch (error) {
        process.stderr.write(
          `D332 prepare threw instead of returning a decision: ${String(error)}\n`,
        );
        return;
      }
      if (retry.accepted) {
        if (retry.prepared.gitChangeCapability === undefined) {
          process.stderr.write("D332 retry accepted without a Git capability\n");
          return;
        }
        throw new Error(
          `D332 observed lineage-free advanced-tip acceptance: prepare allocated attestation ${retry.handle.attestationId} generation ${String(retry.handle.generation)} with a broker Git capability at managed tip ${d332.firstReceipt.newHead} without reprepareOf lineage`,
        );
      }
      if (
        Object.hasOwn(retry, "handle") ||
        Object.hasOwn(retry, "prepared") ||
        retry.allocated !== false
      ) {
        throw new Error(
          `D332 rejected prepare still allocated authority: ${JSON.stringify(retry)}`,
        );
      }
    });

    test("D334 accepts an exact guarded-rebase continuation after broker restart [Behavioral-Progression Blackbox-GoodCommunication]", async () => {
      const restarted = openGuardedRetryCapability(d334, 3_149);
      const retry = await restarted.capability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2148",
          headline: "reproduce the remaining current-main worker authority gaps",
          description: "exercise one exact brokered worker continuation boundary",
          acceptance: "the public dispatch lifecycle completes at the managed worktree tip",
          worktreePath: d334.managed.handle.absolutePath,
          branch: d334.managed.handle.branch,
          baseCommit: d334OntoCommit,
          round: 1,
          startingCommit: d334RebasedHead,
          priorResultCommit: d334.firstReceipt.newHead,
        },
        idempotencyKey: "T2148-d334-guarded-rebase-round-1",
        timeoutMs: 600_000,
        expectedChild: {
          childId: "d334-guarded-rebase-round-1",
          runId: "d334-guarded-rebase-round-1",
        },
        reprepareOf: d334.first.handle,
        guardedRebase: d334GuardedRebase,
      });
      if (!retry.accepted) {
        throw new Error(
          `D334 rejected the exact guarded-rebase continuation at ${retry.path}: ${retry.detail}`,
        );
      }
      const context = {
        guardedRebase: d334GuardedRebase,
        oldResultCommit: d334.firstReceipt.newHead,
        ontoCommit: d334OntoCommit,
        rebasedStartCommit: d334RebasedHead,
      };
      const first = await completeGuardedContinuation(
        d334,
        restarted.capability,
        retry,
        context,
        1,
        {
          content: "continued\n",
          baseReceipts: [],
        },
      );

      // A later correction round carries the verified bridge from the
      // persisted prior binding: no caller reference, early persistence, and
      // a non-empty contiguous suffix beginning at the rebased head.
      const corrected = await restarted.capability.prepare({
        roleId: "implement-worker",
        input: {
          taskId: "T2148",
          headline: "reproduce the remaining current-main worker authority gaps",
          description: "exercise one exact brokered worker continuation boundary",
          acceptance: "the public dispatch lifecycle completes at the managed worktree tip",
          worktreePath: d334.managed.handle.absolutePath,
          branch: d334.managed.handle.branch,
          baseCommit: d334OntoCommit,
          round: 2,
          startingCommit: first.resultCommit,
          priorResultCommit: first.resultCommit,
        },
        idempotencyKey: "T2148-d334-guarded-rebase-round-2",
        timeoutMs: 600_000,
        expectedChild: {
          childId: "d334-guarded-rebase-round-2",
          runId: "d334-guarded-rebase-round-2",
        },
        reprepareOf: first.handle,
      });
      if (!corrected.accepted) {
        throw new Error(
          `D334 rejected the guarded correction round at ${corrected.path}: ${corrected.detail}`,
        );
      }
      await completeGuardedContinuation(d334, restarted.capability, corrected, context, 2, {
        content: "corrected\n",
        baseReceipts: first.receipts,
      });
    });

    function guardedContinuationInput(
      fixture: GuardedRetryFixture,
      ontoCommit: string,
      startingCommit: string,
      priorResultCommit: string,
      round: number,
    ): DispatchJSONValue {
      return {
        taskId: "T2148",
        headline: "reproduce the remaining current-main worker authority gaps",
        description: "exercise one exact brokered worker continuation boundary",
        acceptance: "the public dispatch lifecycle completes at the managed worktree tip",
        worktreePath: fixture.managed.handle.absolutePath,
        branch: fixture.managed.handle.branch,
        baseCommit: ontoCommit,
        round,
        startingCommit,
        priorResultCommit,
      } as unknown as DispatchJSONValue;
    }

    function expectRejection(
      retry: Awaited<ReturnType<DispatchCapabilityInstance["prepare"]>>,
      path: string,
      detail: string,
    ): void {
      if (retry.accepted) {
        throw new Error(
          `guarded-rebase control unexpectedly allocated attestation ${retry.handle.attestationId} generation ${String(retry.handle.generation)}`,
        );
      }
      if (
        Object.hasOwn(retry, "handle") ||
        Object.hasOwn(retry, "prepared") ||
        retry.allocated !== false
      ) {
        throw new Error(`rejected prepare still allocated authority: ${JSON.stringify(retry)}`);
      }
      expect(retry.path).toBe(path);
      expect(retry.detail).toContain(detail);
    }

    test("guarded prepare controls: caller injection, omission, substitution, and foreign coordinates reject [Behavioral-Progression Blackbox-GoodCommunication]", async () => {
      const opened = openGuardedRetryCapability(d334Negative, 3_152);
      const capability = opened.capability;
      try {
        const roundOne = {
          roleId: "implement-worker" as const,
          idempotencyKey: "T2148-d334-negative-injection",
          timeoutMs: 600_000,
          expectedChild: { childId: "d334-negative-injection", runId: "d334-negative-injection" },
          reprepareOf: d334Negative.first.handle,
        };
        // Caller-injected lineage is never accepted, even with the exact coordinates.
        expectRejection(
          await capability.prepare({
            ...roundOne,
            input: {
              ...(guardedContinuationInput(
                d334Negative,
                d334NegativeOntoCommit,
                d334NegativeRebasedHead,
                d334Negative.firstReceipt.newHead,
                1,
              ) as Readonly<Record<string, unknown>>),
              guardedRebaseLineage: {
                guardedRebase: d334NegativeReference,
                oldResultCommit: d334Negative.firstReceipt.newHead,
                ontoCommit: d334NegativeOntoCommit,
                rebasedStartCommit: d334NegativeRebasedHead,
                exactTip: true,
              },
            },
            guardedRebase: d334NegativeReference,
          }),
          "input.guardedRebaseLineage",
          "caller must omit the server-injected guarded-rebase lineage",
        );
        // Omission: the advanced rebased tip without the reference stays unauthorized.
        expectRejection(
          await capability.prepare({
            ...roundOne,
            idempotencyKey: "T2148-d334-negative-omission",
            expectedChild: { childId: "d334-negative-omission", runId: "d334-negative-omission" },
            input: guardedContinuationInput(
              d334Negative,
              d334NegativeOntoCommit,
              d334NegativeRebasedHead,
              d334Negative.firstReceipt.newHead,
              1,
            ),
          }),
          "input.startingCommit",
          "prior-generation receipt inheritance failed",
        );
        // Substitution: a well-formed but unknown reference resolves nothing.
        expectRejection(
          await capability.prepare({
            ...roundOne,
            idempotencyKey: "T2148-d334-negative-substitution",
            expectedChild: {
              childId: "d334-negative-substitution",
              runId: "d334-negative-substitution",
            },
            input: guardedContinuationInput(
              d334Negative,
              d334NegativeOntoCommit,
              d334NegativeRebasedHead,
              d334Negative.firstReceipt.newHead,
              1,
            ),
            guardedRebase: `cq-guarded-rebase:v1:${"1".repeat(64)}`,
          }),
          "guardedRebase",
          "does not resolve to a durable journal",
        );
        // Foreign/stale coordinates: the exact reference with a wrong declared base.
        expectRejection(
          await capability.prepare({
            ...roundOne,
            idempotencyKey: "T2148-d334-negative-foreign-base",
            expectedChild: {
              childId: "d334-negative-foreign-base",
              runId: "d334-negative-foreign-base",
            },
            input: guardedContinuationInput(
              d334Negative,
              d334Negative.baseCommit,
              d334NegativeRebasedHead,
              d334Negative.firstReceipt.newHead,
              1,
            ),
            guardedRebase: d334NegativeReference,
          }),
          "input.baseCommit",
          "baseCommit to equal the journaled ontoCommit",
        );
        // No broader ancestry exception: priorResultCommit must equal oldResultCommit exactly.
        expectRejection(
          await capability.prepare({
            ...roundOne,
            idempotencyKey: "T2148-d334-negative-foreign-prior",
            expectedChild: {
              childId: "d334-negative-foreign-prior",
              runId: "d334-negative-foreign-prior",
            },
            input: guardedContinuationInput(
              d334Negative,
              d334NegativeOntoCommit,
              d334NegativeRebasedHead,
              d334NegativeRebasedHead,
              1,
            ),
            guardedRebase: d334NegativeReference,
          }),
          "input.priorResultCommit",
          "priorResultCommit to equal the bound old worker result",
        );
      } finally {
        await closeGuardedRetryBackend(opened.backend);
      }
    });

    test("guarded store controls: pre-rebase receipts, lineage omission/substitution, and mode spoofing fail closed [Behavioral-Progression Blackbox-GoodCommunication]", async () => {
      const opened = openGuardedRetryCapability(d334Negative, 3_155);
      const capability = opened.capability;
      try {
        const baseOutput = {
          taskId: "T2148",
          status: "pass",
          resultCommit: d334NegativeRebasedHead,
          branch: d334Negative.managed.handle.branch,
          actualWorktreePath: d334Negative.managed.handle.absolutePath,
          filesTouched: [GUARDED_FIXTURE_PATH],
          gitReceipts: [] as readonly unknown[],
          gitLineage: {
            kind: "guarded-rebase",
            guardedRebase: d334NegativeReference,
            ontoCommit: d334NegativeOntoCommit,
            rebasedStartCommit: d334NegativeRebasedHead,
            exactTip: true,
          },
          checkSummary: "trusted gate delegated to result storage",
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit: d334NegativeOntoCommit,
            headCommit: d334NegativeRebasedHead,
          },
          summary: "control payload",
          mutationTable: [
            {
              mutation: `${GUARDED_FIXTURE_PATH}: rebased change`,
              observed: "the journal pins the rebased diff",
              restored: "no local mutation",
            },
          ],
        };
        const controls = [
          {
            label: "pre-rebase-receipt",
            output: { ...baseOutput, gitReceipts: [d334Negative.firstReceipt] },
            error: "guarded receipt suffix must begin at the journaled rebased head",
          },
          {
            label: "lineage-omission",
            output: Object.fromEntries(
              Object.entries(baseOutput).filter(([key]) => key !== "gitLineage"),
            ),
            error: "omitted or substituted its resolved lineage",
          },
          {
            label: "lineage-substitution",
            output: {
              ...baseOutput,
              gitLineage: { ...baseOutput.gitLineage, exactTip: false },
            },
            error: "omitted or substituted its resolved lineage",
          },
          {
            label: "mode-spoofing",
            output: { ...baseOutput, resultCommit: d334Negative.firstReceipt.newHead },
            error: "empty guarded receipt suffix",
          },
        ] as const;
        let prior = d334Negative.first.handle;
        for (const [index, control] of controls.entries()) {
          const prepared = await capability.prepare({
            roleId: "implement-worker",
            input: guardedContinuationInput(
              d334Negative,
              d334NegativeOntoCommit,
              d334NegativeRebasedHead,
              d334Negative.firstReceipt.newHead,
              index + 1,
            ),
            idempotencyKey: `T2148-d334-negative-store-${control.label}`,
            timeoutMs: 600_000,
            expectedChild: {
              childId: `d334-negative-store-${control.label}`,
              runId: `d334-negative-store-${control.label}`,
            },
            reprepareOf: prior,
            guardedRebase: d334NegativeReference,
          });
          if (!prepared.accepted) {
            throw new Error(`control ${control.label} did not prepare: ${prepared.detail}`);
          }
          await capability.fetchInput({
            ...prepared.handle,
            inputCapability: prepared.prepared.inputCapability,
          });
          await expect(
            capability.storeResult({
              resultCapability: prepared.prepared.resultCapability,
              output: control.output as unknown as DispatchJSONValue,
            }),
          ).rejects.toThrow(control.error);
          await capability.abort({ ...prepared.handle, reason: "parent-lost" });
          prior = prepared.handle;
        }
      } finally {
        await closeGuardedRetryBackend(opened.backend);
      }
    });

    test("D334 no-new-commit control: the exact-tip mode stages with an empty fresh suffix and a trusted parent gate [Behavioral-Progression Blackbox-GoodCommunication]", async () => {
      const opened = openGuardedRetryCapability(d334ExactTip, 3_153);
      const capability = opened.capability;
      try {
        const prepared = await capability.prepare({
          roleId: "implement-worker",
          input: guardedContinuationInput(
            d334ExactTip,
            d334ExactTipOntoCommit,
            d334ExactTipRebasedHead,
            d334ExactTip.firstReceipt.newHead,
            1,
          ),
          idempotencyKey: "T2148-d334-exact-tip-round-1",
          timeoutMs: 600_000,
          expectedChild: { childId: "d334-exact-tip-round-1", runId: "d334-exact-tip-round-1" },
          reprepareOf: d334ExactTip.first.handle,
          guardedRebase: d334ExactTipReference,
        });
        if (!prepared.accepted) {
          throw new Error(`exact-tip prepare rejected: ${prepared.path}: ${prepared.detail}`);
        }
        const materialized = await capability.fetchInput({
          ...prepared.handle,
          inputCapability: prepared.prepared.inputCapability,
        });
        const input = materialized.input as Readonly<Record<string, unknown>>;
        expect(input["guardedRebaseLineage"]).toEqual({
          guardedRebase: d334ExactTipReference,
          oldResultCommit: d334ExactTip.firstReceipt.newHead,
          ontoCommit: d334ExactTipOntoCommit,
          rebasedStartCommit: d334ExactTipRebasedHead,
          exactTip: true,
        });
        expect(input["inheritedGitReceipts"]).toBeUndefined();
        // No WIP commit and no git_commit call: the rebased tip already carries
        // the byte-identical approved change, so resultCommit is the rebased head.
        const stored = await capability.storeResult({
          resultCapability: prepared.prepared.resultCapability,
          output: {
            taskId: "T2148",
            status: "pass",
            resultCommit: d334ExactTipRebasedHead,
            branch: d334ExactTip.managed.handle.branch,
            actualWorktreePath: d334ExactTip.managed.handle.absolutePath,
            filesTouched: [GUARDED_FIXTURE_PATH],
            gitReceipts: [],
            gitLineage: {
              kind: "guarded-rebase",
              guardedRebase: d334ExactTipReference,
              ontoCommit: d334ExactTipOntoCommit,
              rebasedStartCommit: d334ExactTipRebasedHead,
              exactTip: true,
            },
            checkSummary: "trusted gate delegated to result storage",
            baseVerification: {
              status: "verified",
              relation: "descendant",
              baseCommit: d334ExactTipOntoCommit,
              headCommit: d334ExactTipRebasedHead,
            },
            summary: "no-new-commit exact-tip continuation at the journaled rebased head",
            mutationTable: [
              {
                mutation: `${GUARDED_FIXTURE_PATH}: rebased change re-proven at the rebased tip`,
                observed: "the onto..result diff equals the approved pre-rebase change",
                restored: "no local mutation; the tree stays clean at the rebased head",
              },
            ],
          } as unknown as DispatchJSONValue,
        });
        if (stored.state !== "gate-pending")
          throw new Error(`unexpected stored state ${stored.state}`);
        if (
          capability.finalizeParentGate === undefined ||
          prepared.prepared.parentGateCapability === undefined
        ) {
          throw new Error("exact-tip control lacks parent gate authority");
        }
        const finalized = await capability.finalizeParentGate({
          ...prepared.handle,
          parentGateCapability: prepared.prepared.parentGateCapability,
        });
        expect(finalized.state).toBe("result-stored");
        const confirmed = await capability.confirmCompletion({
          ...prepared.handle,
          nativeCompletion: {
            kind: "native-completion",
            actor: "trusted-parent",
            childId: "d334-exact-tip-round-1",
            runId: "d334-exact-tip-round-1",
            completedAt: "2026-08-18T12:00:03.000Z",
          },
          expectedProvenance: prepared.prepared.promptProvenance,
        });
        expect(confirmed.state).toBe("consumed");
        const fetched = await capability.fetch(prepared.handle);
        if (fetched.state !== "consumed")
          throw new Error(`unexpected fetched state ${fetched.state}`);
        const output = fetched.output as Readonly<Record<string, unknown>>;
        expect(output["resultCommit"]).toBe(d334ExactTipRebasedHead);
        expect(output["gitReceipts"]).toEqual([]);
        expect(output["filesTouched"]).toEqual([GUARDED_FIXTURE_PATH]);
        expect(output["gitLineage"]).toEqual({
          kind: "guarded-rebase",
          guardedRebase: d334ExactTipReference,
          ontoCommit: d334ExactTipOntoCommit,
          rebasedStartCommit: d334ExactTipRebasedHead,
          exactTip: true,
        });
      } finally {
        await closeGuardedRetryBackend(opened.backend);
      }
    });
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
