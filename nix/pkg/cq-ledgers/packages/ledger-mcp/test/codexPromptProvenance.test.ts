import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  sequentialDispatchRandomBytes,
  serializePromptSurfaceManifest,
  type AttestationNamespace,
} from "@cq/config";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import { InMemoryPromptArtifactStore } from "../src/promptArtifactStore.js";

const encoder = new TextEncoder();
const ROLE_ID = "implement-worker";
const SURFACE = "codex";
const NOW = "2026-08-02T05:00:00.000Z";
const NAMESPACE: AttestationNamespace = {
  backend: "xdg",
  projectKey: "codex-prompt-provenance",
};
const CODEX_INJECTED_ROLE_BYTES = encoder.encode(
  "---\nname: implement-worker\n---\n\nUse the Codex dispatch capability boundary.\n",
);
const CATALOG_ROLE = Object.freeze({
  roleId: ROLE_ID,
  roleKind: "dispatched-subagent",
  canonicalSource: `agents/${ROLE_ID}.md`,
  surfaces: ["claude", "codex", "pi"],
  sharedSourceBlock: {
    classification: "shared-prose",
    sourceBlock: "all prose outside the classified surface-sensitive blocks",
    targetFragment: null,
  },
  fragmentBindings: [],
  dispatchRelations: [],
  intentionalDifferences: [],
  sidecar: { schemaRoleId: ROLE_ID },
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function codexArtifactStore(): InMemoryPromptArtifactStore {
  const catalogBytes = encoder.encode(JSON.stringify([CATALOG_ROLE]));
  const surfaceBytes = encoder.encode(
    serializePromptSurfaceManifest(SURFACE, sha256(catalogBytes), [
      { roleId: ROLE_ID, version: 2, sha256: sha256(CODEX_INJECTED_ROLE_BYTES) },
    ]),
  );
  return new InMemoryPromptArtifactStore(SURFACE, surfaceBytes, catalogBytes, [
    { roleId: ROLE_ID, bytes: CODEX_INJECTED_ROLE_BYTES },
  ]);
}

describe("Codex prepared prompt provenance", () => {
  test("persists surface=codex and hashes the exact role instructions injected at the boundary", async () => {
    const attestationStore = new InMemoryAttestationStore(NAMESPACE);
    const capability = createDispatchCapability({
      backend: new InMemoryAttestationBackend(attestationStore),
      promptArtifactStore: codexArtifactStore(),
      now: () => NOW,
      randomBytes: sequentialDispatchRandomBytes(0),
    });
    const outcome = await capability.prepare({
      roleId: ROLE_ID,
      input: {
        taskId: "T1627",
        headline: "Bind Codex preparation to the exact Codex prompt artifact",
        description: "Prove the prepared digest against the injected role bytes.",
        acceptance: "Persist the Codex surface and exact role-byte digest.",
        worktreePath: "/tmp/wt-T1627",
        branch: "implement/T1627",
        baseCommit: "1c0405a6a3c287eab42502520ed5f2807d6d3f7b",
        round: 0,
        startingCommit: "1c0405a6a3c287eab42502520ed5f2807d6d3f7b",
      },
      idempotencyKey: "T1627-codex-provenance",
      timeoutMs: 600_000,
      expectedChild: { childId: "codex-child", runId: "codex-run" },
    });
    if (!outcome.accepted) throw new Error(`unexpected rejection: ${outcome.detail}`);

    const expectedDigest = sha256(CODEX_INJECTED_ROLE_BYTES);
    expect(outcome.prepared.promptProvenance).toMatchObject({
      surface: SURFACE,
      promptDigest: expectedDigest,
    });
    const row = attestationStore.read(outcome.handle);
    if (row === undefined || row.kind !== "envelope") throw new Error("expected envelope");
    expect(row.promptProvenance).toMatchObject({
      surface: SURFACE,
      promptDigest: expectedDigest,
    });
  });
});
