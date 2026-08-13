import { promises as fs } from "node:fs";
import { writeFile } from "node:fs/promises";
import { FsAttestationBackend, type AttestationNamespace } from "@cq/config";
import { releaseManagedWorktree, type ManagedWorktreeHandle } from "@cq/ledger";
import { createDispatchCapability } from "../../src/dispatchCapability.js";
import type { PromptArtifactStore } from "../../src/promptArtifactStore.js";

interface PeerRequest {
  readonly operation: "git-commit" | "store-result" | "abort" | "release";
  readonly repositoryRoot: string;
  readonly stateDir: string;
  readonly attestationRoot?: string;
  readonly namespace?: AttestationNamespace;
  readonly input: Record<string, unknown>;
  readonly startedFile?: string;
  readonly completedFile?: string;
  readonly crashBoundary?: "after-constructed" | "after-index-install";
}

function installCrashBoundary(boundary: NonNullable<PeerRequest["crashBoundary"]>): void {
  if (boundary === "after-constructed") {
    fs.copyFile = async () => {
      process.kill(process.pid, "SIGKILL");
      throw new Error("unreachable after constructed-state SIGKILL");
    };
    return;
  }
  const rename = fs.rename.bind(fs);
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args);
    if (String(args[0]).endsWith(`.cq-broker-${String(process.pid)}`)) {
      process.kill(process.pid, "SIGKILL");
      throw new Error("unreachable after index-install SIGKILL");
    }
  };
}

function artifactStore(): PromptArtifactStore {
  const metadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: "codex" as const,
    promptDigest: "a".repeat(64),
    schemaVersion: 8,
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

async function main(): Promise<void> {
  const request = JSON.parse(await Bun.stdin.text()) as PeerRequest;
  if (request.crashBoundary !== undefined) installCrashBoundary(request.crashBoundary);
  if (request.startedFile !== undefined) await writeFile(request.startedFile, request.operation);
  let result: unknown;
  if (request.operation === "release") {
    result = await releaseManagedWorktree(
      request.input as unknown as {
        readonly handle: ManagedWorktreeHandle;
        readonly terminalDisposition: string;
        readonly resultCommit?: string | null;
        readonly deleteBranch?: boolean;
      },
      { stateDir: request.stateDir },
    );
  } else {
    if (request.attestationRoot === undefined || request.namespace === undefined) {
      throw new Error("dispatch peer requires attestationRoot and namespace");
    }
    const backend = new FsAttestationBackend({
      namespace: request.namespace,
      root: request.attestationRoot,
    });
    try {
      const capability = createDispatchCapability({
        backend,
        promptArtifactStore: artifactStore(),
        repositoryRoot: request.repositoryRoot,
        worktreeStateDir: request.stateDir,
        now: () => "2026-08-10T12:00:00.000Z",
      });
      switch (request.operation) {
        case "git-commit":
          if (capability.gitCommit === undefined) throw new Error("git_commit unavailable");
          result = await capability.gitCommit(request.input as never);
          break;
        case "store-result":
          result = await capability.storeResult(request.input as never);
          break;
        case "abort":
          result = await capability.abort(request.input as never);
          break;
      }
    } finally {
      await backend.close();
    }
  }
  if (request.completedFile !== undefined)
    await writeFile(request.completedFile, request.operation);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
