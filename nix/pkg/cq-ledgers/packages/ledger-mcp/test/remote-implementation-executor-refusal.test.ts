import { describe, expect, test } from "bun:test";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  type AttestationNamespace,
  type PromptSurface,
} from "@cq/config";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import type {
  PromptArtifactRoleMetadata,
  PromptArtifactStore,
} from "../src/promptArtifactStore.js";

const namespace: AttestationNamespace = {
  backend: "postgres",
  projectKey: "remote-executor-refusal",
};
const handle = { attestationId: `att_${"a".repeat(32)}`, generation: 1 } as const;

function artifactStore(surface: PromptSurface): PromptArtifactStore {
  const metadata: PromptArtifactRoleMetadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent",
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: surface,
    promptDigest: "a".repeat(64),
    schemaVersion: 1,
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

function remoteHarness() {
  const store = new InMemoryAttestationStore(namespace);
  return {
    store,
    capability: createDispatchCapability({
      backend: new InMemoryAttestationBackend(store),
      promptArtifactStore: artifactStore("codex"),
    }),
  };
}

describe("remote implementation executor refusal", () => {
  test("refuses runnable implementation preparation before allocating a row", async () => {
    const harness = remoteHarness();
    const outcome = await harness.capability.prepare({
      roleId: "implement-worker",
      input: {
        taskId: "T6521",
        headline: "Do not run remotely",
        description: "Remote construction has metadata authority only.",
        acceptance: "No attestation row is allocated.",
        worktreePath: "/tmp/unreachable",
        branch: "implement/T6521",
        baseCommit: "a".repeat(40),
        startingCommit: "a".repeat(40),
        round: 0,
      },
      idempotencyKey: "remote-implementation-refusal",
      timeoutMs: 600_000,
      expectedChild: { childId: "remote-child", runId: "remote-run" },
    });

    expect(outcome).toEqual({
      accepted: false,
      outcome: "pre-launch-rejection",
      reason: "executor-unavailable",
      path: "roleId",
      detail:
        "implementation execution requires a local XDG runtime with repository and evidence authority",
      allocated: false,
    });
    expect(harness.store.rows()).toEqual([]);
  });

  test("refuses qualification and acquisition before observing a queue row", async () => {
    const harness = remoteHarness();
    await expect(
      harness.capability.qualifyImplementationCandidate!({
        ...handle,
        roleId: "implement-worker",
        correlationId: "correlation",
        childThreadId: "thread",
        expectedRunId: "run",
        outcome: "completed",
        exitStatus: 0,
        observedAt: "2026-09-19T00:00:00.000Z",
        promptDigest: "a".repeat(64),
      }),
    ).rejects.toThrow(
      "implementation executor unavailable for qualify: local XDG repository and evidence authority are required",
    );
    await expect(
      harness.capability.coordinateImplementationCandidate!({
        partitionKey: "partition",
        holderId: "holder",
      }),
    ).rejects.toThrow(
      "implementation executor unavailable for acquire: local XDG repository and evidence authority are required",
    );
    expect(harness.store.rows()).toEqual([]);
  });

  test("retains read-only status while refusing Git before filesystem access", async () => {
    const harness = remoteHarness();
    expect(await harness.capability.fetch(handle)).toEqual({
      state: "attestation-not-found",
      ...handle,
    });
    await expect(
      harness.capability.gitCommit!({
        ...handle,
        gitChangeCapability: { scope: "git-change", token: "cq_git_remote" },
        operationId: "remote-git",
        expectedHead: "a".repeat(40),
        message: "must not run",
        changes: [],
      }),
    ).rejects.toThrow(
      "implementation executor unavailable for git: local XDG repository and evidence authority are required",
    );
    expect(harness.store.rows()).toEqual([]);
  });
});
