import { describe, expect, test } from "bun:test";
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

function fixture(
  roles: readonly Readonly<Record<string, unknown>>[],
  artifacts: readonly InMemoryPromptRoleArtifact[],
): StoreFixture {
  return {
    manifestBytes: encoder.encode(JSON.stringify(roles)),
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
      store: new InMemoryPromptArtifactStore(PROMPT_SURFACE, input.manifestBytes, input.artifacts),
      cleanup: () => undefined,
    }),
  };
}

function filesystemAdapter(): StoreAdapter {
  return {
    label: "production filesystem adapter",
    create: (input) => {
      const root = mkdtempSync(path.join(tmpdir(), "cq-prompt-artifact-store-"));
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
        });
        expect(decoder.decode(artifact.bytes)).toBe(
          "---\ndescription: rendered\n---\n\nKeep {{cq:literal}}, $ARGUMENTS, and ${INPUT} unchanged.\n",
        );
        expect(handle.store.readRole("plan/advance").bytes).toEqual(
          Uint8Array.from([0x00, 0x7f, 0x80, 0xff]),
        );
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
