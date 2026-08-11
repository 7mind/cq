/** T2043 — durable resolver receipts remain mandatory on a failure result. */
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
  implementConflictResolverSidecar,
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
  type DispatchJSONValue,
} from "@cq/config";
import {
  observeManagedRebaseConflict,
  prepareManagedWorktree,
  resolveManagedWorktreeDispatchBinding,
  type DispatchBoundGitAuthorization,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const exec = promisify(execFile);
const roots: string[] = [];
const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "t2043-conflict" };

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T2043",
      GIT_AUTHOR_EMAIL: "t2043@example.invalid",
      GIT_COMMITTER_NAME: "T2043",
      GIT_COMMITTER_EMAIL: "t2043@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactStore(): PromptArtifactStore {
  const metadata = {
    roleId: "implement-conflict-resolver",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-conflict-resolver.md",
    sidecarSchemaRoleId: "implement-conflict-resolver",
    promptSurface: "codex" as const,
    promptDigest: "a".repeat(64),
    schemaVersion: implementConflictResolverSidecar.version,
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

async function fixture() {
  const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), "t2043-dispatch-conflict-"));
  roots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "-q", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.name", "T2043"]);
  await git(repositoryRoot, ["config", "user.email", "t2043@example.invalid"]);
  await git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(repositoryRoot, "bun.lock"), "{}\n");
  await fs.writeFile(path.join(repositoryRoot, "a.txt"), "base a\n");
  await fs.writeFile(path.join(repositoryRoot, "b.txt"), "base b\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "seed"]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const stateDir = path.join(repositoryRoot, ".manager-state");
  const managed = await prepareManagedWorktree(
    { repositoryRoot, taskId: "T2043", baseCommit },
    { stateDir, skipInstall: true, bunWorkspaceRoot: repositoryRoot },
  );
  if (managed.status !== "prepared") throw new Error(`unexpected prepare ${managed.status}`);
  const binding = await resolveManagedWorktreeDispatchBinding(
    {
      repositoryRoot,
      taskId: "T2043",
      worktreePath: managed.handle.absolutePath,
      branch: managed.handle.branch,
    },
    { stateDir },
  );
  if (binding === null) throw new Error("managed resolver binding did not resolve");

  await fs.writeFile(path.join(managed.handle.absolutePath, "a.txt"), "task a\n");
  await git(managed.handle.absolutePath, ["add", "a.txt"]);
  await git(managed.handle.absolutePath, ["commit", "-q", "-m", "task a"]);
  await fs.writeFile(path.join(managed.handle.absolutePath, "b.txt"), "task b\n");
  await git(managed.handle.absolutePath, ["add", "b.txt"]);
  await git(managed.handle.absolutePath, ["commit", "-q", "-m", "task b"]);
  await fs.writeFile(path.join(repositoryRoot, "a.txt"), "base changed a\n");
  await fs.writeFile(path.join(repositoryRoot, "b.txt"), "base changed b\n");
  await git(repositoryRoot, ["add", "a.txt", "b.txt"]);
  await git(repositoryRoot, ["commit", "-q", "-m", "base changes"]);
  const onto = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const rebase = Bun.spawnSync(["git", "rebase", onto], {
    cwd: managed.handle.absolutePath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (rebase.exitCode === 0) throw new Error("seeded rebase did not conflict");
  const observerAuthorization: DispatchBoundGitAuthorization = {
    ...binding,
    attestationId: "cq_attest_CCCCCCCCCCCCCCCCCCCCCC",
    generation: 1,
    roleId: "implement-conflict-resolver",
    surface: "codex",
    childCancelAt: "2099-01-01T00:00:00.000Z",
  };
  const conflictState = await observeManagedRebaseConflict(observerAuthorization, { stateDir });
  const capability = createDispatchCapability({
    backend: new InMemoryAttestationBackend(new InMemoryAttestationStore(NAMESPACE)),
    promptArtifactStore: artifactStore(),
    repositoryRoot,
    worktreeStateDir: stateDir,
    now: () => "2026-08-11T00:00:00.000Z",
    randomBytes: sequentialDispatchRandomBytes(0),
  });
  const prepared = await capability.prepare({
    roleId: "implement-conflict-resolver",
    input: JSON.parse(JSON.stringify({
      taskId: "T2043",
      worktreePath: managed.handle.absolutePath,
      branch: managed.handle.branch,
      baseCommit,
      conflictingFiles: ["a.txt"],
      conflictState,
    })) as DispatchJSONValue,
    idempotencyKey: "T2043-conflict-fail-result",
    timeoutMs: 600_000,
    expectedChild: { childId: "t2043-resolver", runId: "t2043-resolver-run" },
  });
  if (!prepared.accepted || prepared.prepared.gitConflictCapability === undefined) {
    throw new Error("resolver dispatch did not receive a conflict capability");
  }
  await capability.fetchInput({
    attestationId: prepared.prepared.attestationId,
    generation: prepared.prepared.generation,
    inputCapability: prepared.prepared.inputCapability,
  });
  return { capability, prepared: prepared.prepared, conflictState, managed, stateDir };
}

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

describe("dispatch-bound Git conflict capability", () => {
  test("rejects receipt-free fail after a durable step, then stores the complete chain", async () => {
    const seeded = await fixture();
    const resolveContinue = seeded.capability.gitResolveContinue;
    if (resolveContinue === undefined) throw new Error("git_resolve_continue is unavailable");
    const resolution = "base changed a + task a\n";
    await fs.writeFile(path.join(seeded.managed.handle.absolutePath, "a.txt"), resolution);
    const receipt = await resolveContinue({
      attestationId: seeded.prepared.attestationId,
      generation: seeded.prepared.generation,
      gitConflictCapability: seeded.prepared.gitConflictCapability!,
      operationId: "T2043-resolution-1",
      expectedState: seeded.conflictState,
      resolutions: [
        {
          kind: "regular",
          path: "a.txt",
          newState: { mode: "100644", digest: digest(resolution) },
        },
      ],
    });
    expect(receipt.outcome.kind).toBe("conflict");
    const incomplete = {
      taskId: "T2043",
      status: "fail",
      resultCommit: null,
      filesResolved: ["a.txt"],
      checkSummary: "stopped after one durable continuation",
      summary: "receipt evidence was omitted",
      blockedReason: "cannot resolve the next conflict",
    };
    await expect(
      seeded.capability.storeResult({
        resultCapability: seeded.prepared.resultCapability,
        output: incomplete,
      }),
    ).rejects.toThrow(/receipt|branch|worktree/i);

    await expect(
      seeded.capability.storeResult({
        resultCapability: seeded.prepared.resultCapability,
        output: JSON.parse(JSON.stringify({
          ...incomplete,
          branch: seeded.managed.handle.branch,
          actualWorktreePath: seeded.managed.handle.absolutePath,
          conflictReceipts: [receipt],
        })) as DispatchJSONValue,
      }),
    ).resolves.toMatchObject({ state: "result-stored" });
  });
});
