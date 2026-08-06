/**
 * T684 integration: the dispatch prompt materializer over the T683 attested
 * prompt artifact store. With no overlay the injected bytes are byte-identical
 * to the versioned packaged role artifact (the store's attested bytes and
 * digest); a declared fixture overlay deterministically changes the final
 * digest while the attested base digest stays bound.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  DISPATCH_OVERLAY_REGISTRY,
  createDispatchOverlayRegistry,
  materializeDispatchPrompt,
  serializePromptSurfaceManifest,
} from "@cq/config";
import { InMemoryPromptArtifactStore } from "../src/promptArtifactStore.js";

const encoder = new TextEncoder();
const PROMPT_SURFACE = "codex";
const ROLE_ID = "plan-advance";

const INTENTIONAL_DIFFERENCE = Object.freeze({
  kind: "tool-vocabulary",
  reason: "Each prompt surface exposes different host tool names.",
  surfaces: ["claude", "codex", "pi"] as const,
});

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
  fragmentBindings: [
    {
      fragment: "host-tool-vocabulary",
      sourceBlock: "frontmatter host tool and isolation capabilities",
      supportedSurfaces: ["claude", "codex", "pi"],
      forbiddenVocabulary: { claude: ["$cq-"], codex: ["Agent"], pi: ["Agent"] },
      intentionalDifference: INTENTIONAL_DIFFERENCE,
    },
  ],
  dispatchRelations: [],
  intentionalDifferences: [INTENTIONAL_DIFFERENCE],
  sidecar: { schemaRoleId: ROLE_ID },
});

const ARTIFACT_BYTES = encoder.encode(
  "---\ndescription: attested plan-advance artifact\n---\n\nAdvance the goal plan.\n",
);

/** Lowercase hex SHA-256 of raw bytes. */
function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function attestedStore(): InMemoryPromptArtifactStore {
  const manifestBytes = encoder.encode(JSON.stringify([CATALOG_ROLE]));
  const schemaBytes = encoder.encode(
    JSON.stringify({
      id: ROLE_ID,
      version: 1,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    }),
  );
  const surfaceBytes = encoder.encode(
    serializePromptSurfaceManifest(PROMPT_SURFACE, sha256Bytes(manifestBytes), [
      {
        roleId: ROLE_ID,
        version: 1,
        sha256: sha256Bytes(ARTIFACT_BYTES),
        schemaSha256: sha256Bytes(schemaBytes),
      },
    ]),
  );
  return new InMemoryPromptArtifactStore(
    PROMPT_SURFACE,
    surfaceBytes,
    manifestBytes,
    [{ roleId: ROLE_ID, bytes: ARTIFACT_BYTES }],
    [{ roleId: ROLE_ID, bytes: schemaBytes }],
  );
}

describe("dispatch prompt materialization over the attested artifact store", () => {
  test("with no overlay the injected bytes equal the attested packaged artifact exactly", () => {
    const artifact = attestedStore().readRole(ROLE_ID);
    expect(artifact.metadata.promptDigest).toBe(sha256Bytes(ARTIFACT_BYTES));

    const result = materializeDispatchPrompt({
      roleId: ROLE_ID,
      surface: PROMPT_SURFACE,
      artifactBytes: artifact.bytes,
      promptDigest: artifact.metadata.promptDigest!,
      overlays: [],
      registry: DISPATCH_OVERLAY_REGISTRY,
    });
    expect(result.bytes).toEqual(ARTIFACT_BYTES);
    expect(result.finalDigest).toBe(artifact.metadata.promptDigest!);
    expect(result.appliedOverlayIds).toEqual([]);
  });

  test("a declared fixture overlay changes the final digest but not the attested base", () => {
    const artifact = attestedStore().readRole(ROLE_ID);
    const registry = createDispatchOverlayRegistry([
      {
        overlayId: "fixture-focus",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { note: { type: "string", minLength: 1 } },
          required: ["note"],
          additionalProperties: false,
        },
        allowedRoles: [ROLE_ID],
        allowedSurfaces: [PROMPT_SURFACE],
        render: (data) => `Focus note: ${(data as { readonly note: string }).note}`,
      },
    ]);
    const result = materializeDispatchPrompt({
      roleId: ROLE_ID,
      surface: PROMPT_SURFACE,
      artifactBytes: artifact.bytes,
      promptDigest: artifact.metadata.promptDigest!,
      overlays: [{ overlayId: "fixture-focus", data: { note: "prefer the failing suite" } }],
      registry,
    });
    expect(result.promptDigest).toBe(artifact.metadata.promptDigest!);
    expect(result.finalDigest).not.toBe(artifact.metadata.promptDigest!);
    expect(result.finalDigest).toBe(sha256Bytes(result.bytes));
    expect(result.bytes.slice(0, ARTIFACT_BYTES.length)).toEqual(ARTIFACT_BYTES);
  });
});
