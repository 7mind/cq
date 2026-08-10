/**
 * T2042 — Blackbox-Atomic communication test for the dispatch attestation,
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
  sequentialDispatchRandomBytes,
  type AttestationNamespace,
} from "@cq/config";
import { prepareManagedWorktree } from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const exec = promisify(execFile);
const roots: string[] = [];
const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "t2042-integration" };

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

function artifactStore(): PromptArtifactStore {
  const metadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: "codex" as const,
    promptDigest: "a".repeat(64),
    schemaVersion: 6,
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
});
