import { describe, expect, test } from "bun:test";
import { PROMPT_FRAGMENT_SLOTS } from "@cq/config";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FileSystemPromptArtifactStore,
  InMemoryPromptArtifactStore,
  PromptArtifactNotFoundError,
  PromptArtifactStoreError,
  type InMemoryPromptRoleArtifact,
  type PromptArtifactStore,
} from "../src/promptArtifactStore.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PROMPT_SURFACE = "codex";

const INTENTIONAL_DIFFERENCE = Object.freeze({
  kind: "tool-vocabulary",
  reason: "Each prompt surface exposes different host tool names.",
  surfaces: ["claude", "codex", "pi"] as const,
});

const FRAGMENT_BINDING = Object.freeze({
  fragment: "host-tool-vocabulary",
  sourceBlock: "frontmatter host tool and isolation capabilities",
  supportedSurfaces: ["claude", "codex", "pi"] as const,
  forbiddenVocabulary: {
    claude: ["$cq-"] as const,
    codex: ["Agent"] as const,
    pi: ["Agent"] as const,
  },
  intentionalDifference: INTENTIONAL_DIFFERENCE,
});

const SHARED_SOURCE_BLOCK = Object.freeze({
  classification: "shared-prose",
  sourceBlock: "all prose outside the classified surface-sensitive blocks",
  targetFragment: null,
});

interface StoreFixture {
  readonly surfaceBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly artifacts: readonly InMemoryPromptRoleArtifact[];
}

interface StoreHandle {
  readonly store: PromptArtifactStore;
  cleanup(): void;
}

interface StoreAdapter {
  readonly label: string;
  create(fixture: StoreFixture): StoreHandle;
}

function role(
  roleId: string,
  roleKind: "dispatched-subagent" | "orchestrator-command",
  dispatchRelations: readonly Readonly<Record<string, string>>[] = [],
): Readonly<Record<string, unknown>> {
  return {
    roleId,
    roleKind,
    canonicalSource:
      roleKind === "dispatched-subagent"
        ? `agents/${roleId}.md`
        : `commands/cq/${roleId}.md`,
    surfaces: ["claude", "codex", "pi"],
    sharedSourceBlock: SHARED_SOURCE_BLOCK,
    fragmentBindings: [FRAGMENT_BINDING],
    dispatchRelations,
    intentionalDifferences: [INTENTIONAL_DIFFERENCE],
    sidecar: roleKind === "dispatched-subagent" ? { schemaRoleId: roleId } : null,
  };
}

/** Lowercase hex SHA-256 of raw bytes. */
function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Serialize the attested surface manifest (T683 canonical byte shape) for a
 * fixture: per-role exact-byte digests in catalog order, the catalog metadata
 * hash, and the recomputed surface aggregate digest. The optional `mutate`
 * hook tampers with the manifest BEFORE the aggregate is restamped, so tests
 * can target exactly one verification layer.
 */
function surfaceManifestBytes(
  surface: string,
  manifestBytes: Uint8Array,
  roles: readonly Readonly<Record<string, unknown>>[],
  artifacts: readonly InMemoryPromptRoleArtifact[],
  mutate?: (manifest: {
    catalogMetadataHash: string;
    roles: { roleId: string; version: number | null; sha256: string }[];
    surfaceDigest: string;
  }) => void,
): Uint8Array {
  const entries = roles.map((candidate) => {
    const roleId = candidate.roleId as string;
    const bytes = artifacts.find((artifact) => artifact.roleId === roleId)?.bytes;
    return {
      roleId,
      version: candidate.sidecar === null ? null : 1,
      sha256: sha256Bytes(bytes ?? new Uint8Array()),
    };
  });
  const core = {
    surface,
    catalogMetadataHash: sha256Bytes(manifestBytes),
    roles: entries,
  };
  const manifest = {
    ...core,
    surfaceDigest: sha256Bytes(encoder.encode(JSON.stringify(core))),
  };
  if (mutate !== undefined) {
    mutate(manifest);
    const restampedCore = {
      surface,
      catalogMetadataHash: manifest.catalogMetadataHash,
      roles: manifest.roles,
    };
    manifest.surfaceDigest = sha256Bytes(encoder.encode(JSON.stringify(restampedCore)));
  }
  return encoder.encode(JSON.stringify(manifest));
}

function fixture(
  roles: readonly Readonly<Record<string, unknown>>[],
  artifacts: readonly InMemoryPromptRoleArtifact[],
  mutateSurface?: Parameters<typeof surfaceManifestBytes>[4],
): StoreFixture {
  const manifestBytes = encoder.encode(JSON.stringify(roles));
  return {
    surfaceBytes: surfaceManifestBytes(
      PROMPT_SURFACE,
      manifestBytes,
      roles,
      artifacts,
      mutateSurface,
    ),
    manifestBytes,
    artifacts,
  };
}

const CONTRACT_FIXTURE = fixture(
  [
    role("plan/advance", "orchestrator-command", [
      { kind: "dispatch", targetRoleId: "plan-advance" },
    ]),
    role("plan-advance", "dispatched-subagent"),
  ],
  [
    {
      roleId: "plan-advance",
      bytes: encoder.encode(
        "---\ndescription: rendered\n---\n\nKeep {{cq:literal}}, $ARGUMENTS, and ${INPUT} unchanged.\n",
      ),
    },
    {
      roleId: "plan/advance",
      bytes: Uint8Array.from([0x00, 0x7f, 0x80, 0xff]),
    },
  ],
);

function memoryAdapter(): StoreAdapter {
  return {
    label: "strict in-memory dummy",
    create: (input) => ({
      store: new InMemoryPromptArtifactStore(
        PROMPT_SURFACE,
        input.surfaceBytes,
        input.manifestBytes,
        input.artifacts,
      ),
      cleanup: () => undefined,
    }),
  };
}

function filesystemAdapter(): StoreAdapter {
  return {
    label: "production filesystem adapter",
    create: (input) => {
      const root = mkdtempSync(path.join(tmpdir(), "cq-prompt-artifact-store-"));
      writeFileSync(path.join(root, "surface.json"), input.surfaceBytes);
      writeFileSync(path.join(root, "catalog.json"), input.manifestBytes);
      mkdirSync(path.join(root, "roles"));
      for (const artifact of [...input.artifacts].reverse()) {
        const artifactPath = path.join(root, "roles", `${artifact.roleId}.md`);
        mkdirSync(path.dirname(artifactPath), { recursive: true });
        writeFileSync(artifactPath, artifact.bytes);
      }
      return {
        store: new FileSystemPromptArtifactStore(PROMPT_SURFACE, root),
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  };
}

function runPromptArtifactStoreContract(adapter: StoreAdapter): void {
  describe(`PromptArtifactStore contract — ${adapter.label}`, () => {
    test("reads exact manifest bytes and preserves deterministic manifest order", () => {
      const handle = adapter.create(CONTRACT_FIXTURE);
      try {
        const manifest = handle.store.readManifest();
        expect(manifest.bytes).toEqual(CONTRACT_FIXTURE.manifestBytes);
        expect(manifest.roles.map((entry) => entry.roleId)).toEqual([
          "plan/advance",
          "plan-advance",
        ]);
        expect(manifest.roles.map((entry) => entry.artifactPath)).toEqual([
          "roles/plan/advance.md",
          "roles/plan-advance.md",
        ]);
        expect(manifest.promptSurface).toBe(PROMPT_SURFACE);
        expect(manifest.catalogHash).toBe(sha256Bytes(CONTRACT_FIXTURE.manifestBytes));
      } finally {
        handle.cleanup();
      }
    });

    test("looks up manifest-corresponding role metadata and exact uninterpolated bytes", () => {
      const handle = adapter.create(CONTRACT_FIXTURE);
      try {
        const artifact = handle.store.readRole("plan-advance");
        expect(artifact.metadata).toEqual({
          roleId: "plan-advance",
          roleKind: "dispatched-subagent",
          artifactPath: "roles/plan-advance.md",
          sidecarSchemaRoleId: "plan-advance",
          promptSurface: "codex",
          renderer: {
            sharedSourceBlock: SHARED_SOURCE_BLOCK,
            fragmentBindings: [FRAGMENT_BINDING],
          },
          sourcePath: "agents/plan-advance.md",
          workflowDependencies: [],
          requiredCapabilities: ["host-tool-vocabulary"],
          intentionalDifferences: [INTENTIONAL_DIFFERENCE],
          promptDigest: sha256Bytes(CONTRACT_FIXTURE.artifacts[0]!.bytes),
          schemaVersion: 1,
        });
        expect(decoder.decode(artifact.bytes)).toBe(
          "---\ndescription: rendered\n---\n\nKeep {{cq:literal}}, $ARGUMENTS, and ${INPUT} unchanged.\n",
        );
        expect(handle.store.readRole("plan/advance").bytes).toEqual(
          Uint8Array.from([0x00, 0x7f, 0x80, 0xff]),
        );
        expect(handle.store.readRole("plan/advance").metadata.schemaVersion).toBeNull();
      } finally {
        handle.cleanup();
      }
    });

    test("returns immutable snapshots whose byte buffers cannot mutate later reads", () => {
      const handle = adapter.create(CONTRACT_FIXTURE);
      try {
        const manifest = handle.store.readManifest();
        const artifact = handle.store.readRole("plan-advance");
        manifest.bytes.fill(0);
        artifact.bytes.fill(0);

        expect(handle.store.readManifest().bytes).toEqual(CONTRACT_FIXTURE.manifestBytes);
        expect(decoder.decode(handle.store.readRole("plan-advance").bytes)).toContain(
          "Keep {{cq:literal}}",
        );
        expect(Object.isFrozen(manifest)).toBe(true);
        expect(Object.isFrozen(manifest.roles)).toBe(true);
        const firstRole = manifest.roles[0];
        if (firstRole === undefined || firstRole.renderer === undefined) {
          throw new Error("expected rendered role metadata");
        }
        expect(Object.isFrozen(firstRole)).toBe(true);
        expect(Object.isFrozen(firstRole.renderer)).toBe(true);
        expect(Object.isFrozen(firstRole.renderer.fragmentBindings)).toBe(true);
        expect(Object.isFrozen(artifact)).toBe(true);
      } finally {
        handle.cleanup();
      }
    });

    test("rejects traversal and absolute role lookups before filesystem access", () => {
      const handle = adapter.create(CONTRACT_FIXTURE);
      try {
        for (const roleId of ["../secret", "plan/../../../secret", "/absolute"]) {
          expect(() => handle.store.readRole(roleId)).toThrow(PromptArtifactStoreError);
          expect(() => handle.store.readRole(roleId)).toThrow(/without traversal/);
        }
      } finally {
        handle.cleanup();
      }
    });

    test("fails precisely when a safe role is absent from the manifest", () => {
      const handle = adapter.create(CONTRACT_FIXTURE);
      try {
        expect(() => handle.store.readRole("missing-role")).toThrow(PromptArtifactNotFoundError);
        expect(() => handle.store.readRole("missing-role")).toThrow(
          "role is not declared by the manifest",
        );
      } finally {
        handle.cleanup();
      }
    });

    test("rejects a manifest role with no corresponding artifact", () => {
      const missing = fixture([role("plan-advance", "dispatched-subagent")], []);
      expect(() => adapter.create(missing)).toThrow(
        'missing artifact for manifest role "plan-advance"',
      );
    });

    test("rejects an artifact with no corresponding manifest role", () => {
      const extra = fixture([], [{ roleId: "extra-role", bytes: encoder.encode("extra") }]);
      expect(() => adapter.create(extra)).toThrow('artifact has no manifest role "extra-role"');
    });

    test("rejects mismatched dispatched sidecar metadata", () => {
      const mismatched = fixture(
        [
          {
            roleId: "plan-advance",
            roleKind: "dispatched-subagent",
            sidecar: { schemaRoleId: "other-role" },
          },
        ],
        [{ roleId: "plan-advance", bytes: encoder.encode("body") }],
      );
      expect(() => adapter.create(mismatched)).toThrow(
        'catalog.json[0].sidecar.schemaRoleId: expected "plan-advance"',
      );
    });

    test("rejects incomplete renderer metadata instead of silently dropping it", () => {
      const incomplete = fixture(
        [
          {
            roleId: "plan-advance",
            roleKind: "dispatched-subagent",
            canonicalSource: "agents/plan-advance.md",
            surfaces: ["claude", "codex", "pi"],
            sharedSourceBlock: SHARED_SOURCE_BLOCK,
            sidecar: { schemaRoleId: "plan-advance" },
          },
        ],
        [{ roleId: "plan-advance", bytes: encoder.encode("body") }],
      );
      expect(() => adapter.create(incomplete)).toThrow(
        "catalog.json[0].fragmentBindings: expected an array",
      );
    });

    test("rejects a selected surface that does not match the immutable root identity", () => {
      const mismatched = {
        ...CONTRACT_FIXTURE,
        surfaceBytes: surfaceManifestBytes(
          "pi",
          CONTRACT_FIXTURE.manifestBytes,
          [
            role("plan/advance", "orchestrator-command", [
              { kind: "dispatch", targetRoleId: "plan-advance" },
            ]),
            role("plan-advance", "dispatched-subagent"),
          ],
          CONTRACT_FIXTURE.artifacts,
        ),
      };
      expect(() => adapter.create(mismatched)).toThrow(
        'surface.json.surface: selected prompt surface "codex" does not match built root "pi"',
      );
    });

    test("rejects additional surface metadata fields", () => {
      const malformed = {
        ...CONTRACT_FIXTURE,
        surfaceBytes: encoder.encode(
          '{"surface":"codex","catalogMetadataHash":"' + "0".repeat(64) + '","roles":[],"surfaceDigest":"' + "0".repeat(64) + '","extra":true}',
        ),
      };
      expect(() => adapter.create(malformed)).toThrow(
        "surface.json.extra: unexpected field in the attested surface manifest",
      );
    });

    test("rejects a tampered surface aggregate digest", () => {
      const tampered = {
        ...CONTRACT_FIXTURE,
        surfaceBytes: surfaceManifestBytes(
          PROMPT_SURFACE,
          CONTRACT_FIXTURE.manifestBytes,
          [
            role("plan/advance", "orchestrator-command", [
              { kind: "dispatch", targetRoleId: "plan-advance" },
            ]),
            role("plan-advance", "dispatched-subagent"),
          ],
          CONTRACT_FIXTURE.artifacts,
        ),
      };
      const parsed = JSON.parse(decoder.decode(tampered.surfaceBytes)) as {
        surfaceDigest: string;
      };
      parsed.surfaceDigest = "f".repeat(64);
      expect(() =>
        adapter.create({
          ...tampered,
          surfaceBytes: encoder.encode(JSON.stringify(parsed)),
        }),
      ).toThrow("surface aggregate digest does not match the attested contents");
    });

    test("rejects stale role bytes that no longer match the attested digest", () => {
      const stale = fixture(
        [role("plan-advance", "dispatched-subagent")],
        [{ roleId: "plan-advance", bytes: encoder.encode("body") }],
        (manifest) => {
          manifest.roles[0]!.sha256 = "0".repeat(64);
        },
      );
      expect(() => adapter.create(stale)).toThrow(
        'installed bytes do not match the attested digest for role "plan-advance"',
      );
    });

    test("rejects a stale catalog metadata hash", () => {
      const stale = fixture(
        [role("plan-advance", "dispatched-subagent")],
        [{ roleId: "plan-advance", bytes: encoder.encode("body") }],
        (manifest) => {
          manifest.catalogMetadataHash = "0".repeat(64);
        },
      );
      expect(() => adapter.create(stale)).toThrow(
        "does not match the installed catalog.json bytes",
      );
    });

    test("rejects a missing digest entry for a manifest role", () => {
      const missing = fixture(
        [
          role("plan/advance", "orchestrator-command", [
            { kind: "dispatch", targetRoleId: "plan-advance" },
          ]),
          role("plan-advance", "dispatched-subagent"),
        ],
        CONTRACT_FIXTURE.artifacts,
        (manifest) => {
          manifest.roles = manifest.roles.filter(
            (entry) => entry.roleId !== "plan-advance",
          );
        },
      );
      expect(() => adapter.create(missing)).toThrow(
        'missing digest for manifest role "plan-advance"',
      );
    });

    test("rejects a digest entry with no manifest role", () => {
      const extra = fixture(
        [role("plan-advance", "dispatched-subagent")],
        [{ roleId: "plan-advance", bytes: encoder.encode("body") }],
        (manifest) => {
          manifest.roles.push({
            roleId: "ghost-role",
            version: 1,
            sha256: "0".repeat(64),
          });
        },
      );
      expect(() => adapter.create(extra)).toThrow(
        'digest entry has no manifest role "ghost-role"',
      );
    });

    test("rejects version and role-kind mismatches in the attestation", () => {
      const dispatchedWithoutVersion = fixture(
        [role("plan-advance", "dispatched-subagent")],
        [{ roleId: "plan-advance", bytes: encoder.encode("body") }],
        (manifest) => {
          manifest.roles[0]!.version = null;
        },
      );
      expect(() => adapter.create(dispatchedWithoutVersion)).toThrow(
        'dispatched role "plan-advance" has no attested schema-sidecar version',
      );

      const orchestratorWithVersion = fixture(
        [role("plan/advance", "orchestrator-command")],
        [{ roleId: "plan/advance", bytes: encoder.encode("body") }],
        (manifest) => {
          manifest.roles[0]!.version = 3;
        },
      );
      expect(() => adapter.create(orchestratorWithVersion)).toThrow(
        'orchestrator-command role "plan/advance" must not carry a schema-sidecar version',
      );
    });
  });
}

runPromptArtifactStoreContract(memoryAdapter());
runPromptArtifactStoreContract(filesystemAdapter());

test("the filesystem contract leg constructs the production adapter", () => {
  const handle = filesystemAdapter().create(CONTRACT_FIXTURE);
  try {
    expect(handle.store).toBeInstanceOf(FileSystemPromptArtifactStore);
    expect(handle.store).not.toBeInstanceOf(InMemoryPromptArtifactStore);
  } finally {
    handle.cleanup();
  }
});

test("the filesystem adapter requires an explicit absolute root", () => {
  expect(() => new FileSystemPromptArtifactStore(PROMPT_SURFACE, "relative/root")).toThrow(
    "root: expected an absolute path",
  );
});

// Regression: the packaged MCP must accept every fragment emitted by the generated catalog.
test("the production adapter accepts the generated prompt-fragment vocabulary", () => {
  const generatedRole = {
    ...role("implement-worker", "dispatched-subagent"),
    fragmentBindings: PROMPT_FRAGMENT_SLOTS.map((fragment) => ({
      ...FRAGMENT_BINDING,
      fragment,
    })),
  };
  const generatedVocabulary = fixture(
    [generatedRole],
    [{ roleId: "implement-worker", bytes: encoder.encode("body") }],
  );

  const handle = filesystemAdapter().create(generatedVocabulary);
  try {
    expect(handle.store.readManifest().roles[0]?.requiredCapabilities).toEqual(
      PROMPT_FRAGMENT_SLOTS,
    );
  } finally {
    handle.cleanup();
  }
});
