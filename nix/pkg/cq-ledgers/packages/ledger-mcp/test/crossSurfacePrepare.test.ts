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
const NOW = "2026-08-02T05:00:00.000Z";
const NAMESPACE: AttestationNamespace = {
  backend: "xdg",
  projectKey: "cross-surface-prepare",
};
function roleBytes(surface: string): Uint8Array {
  return encoder.encode(`---\nname: implement-worker\n---\n\nThe ${surface} role body.\n`);
}
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

function artifactStore(surface: "claude" | "codex" | "pi"): InMemoryPromptArtifactStore {
  const bytes = roleBytes(surface);
  const catalogBytes = encoder.encode(JSON.stringify([CATALOG_ROLE]));
  const schemaJson = JSON.stringify({
    id: ROLE_ID,
    version: 2,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  });
  const schemaBytes = encoder.encode(schemaJson);
  const surfaceBytes = encoder.encode(
    serializePromptSurfaceManifest(surface, sha256(catalogBytes), [
      {
        roleId: ROLE_ID,
        version: 2,
        sha256: sha256(bytes),
        schemaSha256: sha256(schemaBytes),
      },
    ]),
  );
  return new InMemoryPromptArtifactStore(
    surface,
    surfaceBytes,
    catalogBytes,
    [{ roleId: ROLE_ID, bytes }],
    [{ roleId: ROLE_ID, bytes: schemaBytes }],
  );
}

const WORKER_INPUT = {
  taskId: "T224",
  headline: "Prepare against the target harness's prompt surface",
  description: "Cross-harness dispatch binds the target surface's role bytes.",
  acceptance: "The prepared provenance names the target surface and its digest.",
  worktreePath: "/tmp/wt-T224",
  branch: "implement/T224",
  baseCommit: "1c0405a6a3c287eab42502520ed5f2807d6d3f7b",
  round: 0,
  startingCommit: "1c0405a6a3c287eab42502520ed5f2807d6d3f7b",
  validationIntent: "final",
} as const;

function crossSurfaceCapability() {
  return createDispatchCapability({
    backend: new InMemoryAttestationBackend(new InMemoryAttestationStore(NAMESPACE)),
    promptArtifactStore: artifactStore("claude"),
    targetPromptArtifactStores: { claude: artifactStore("claude"), codex: artifactStore("codex") },
    now: () => NOW,
    randomBytes: sequentialDispatchRandomBytes(0),
  });
}

function prepareFor(surface: string | undefined, key: string) {
  return crossSurfaceCapability().prepare({
    roleId: ROLE_ID,
    input: WORKER_INPUT,
    ...(surface === undefined ? {} : { surface }),
    idempotencyKey: key,
    timeoutMs: 600_000,
    expectedChild: { childId: "cross-child", runId: "cross-run" },
  });
}

describe("G224 cross-surface prepare", () => {
  test("a requested target surface binds that surface's role bytes", async () => {
    const outcome = await prepareFor("codex", "G224-codex");
    if (!outcome.accepted) throw new Error(`unexpected rejection: ${outcome.detail}`);
    expect(outcome.prepared.promptProvenance).toMatchObject({
      surface: "codex",
      promptDigest: sha256(roleBytes("codex")),
    });
  });

  test("without a requested surface the server's own surface is bound", async () => {
    const outcome = await prepareFor(undefined, "G224-default");
    if (!outcome.accepted) throw new Error(`unexpected rejection: ${outcome.detail}`);
    expect(outcome.prepared.promptProvenance).toMatchObject({
      surface: "claude",
      promptDigest: sha256(roleBytes("claude")),
    });
  });

  test("a surface with no configured artifact store is refused", async () => {
    const outcome = await prepareFor("pi", "G224-pi");
    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) return;
    expect(outcome.detail).toContain('requested prompt surface "pi"');
  });
});
