import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  DISPATCHED_ROLE_SIDECARS,
  getRoleSidecar,
  PI_ROLE_TOOL_PROFILE_MANIFEST_PATH,
  serializePiRoleToolProfileManifest,
  serializePromptSurfaceManifest,
  verifyPromptCatalog,
  type PromptSurface,
  type PromptVerificationRoot,
} from "@cq/config";
import { serializeRoleSchemaArtifact } from "@cq/config/prompt-renderer";
import { PROMPT_CATALOG_PROJECTION } from "../src/promptCatalog.gen.js";

interface CatalogEntry {
  readonly roleId: string;
  readonly canonicalSource: string;
  readonly [key: string]: unknown;
}

interface FragmentBinding {
  readonly fragment: string;
}

interface FragmentSource {
  readonly surface: PromptSurface;
  readonly roleId: string;
  readonly fragment: string;
  readonly source: string;
}

interface CatalogProjection {
  readonly schemaVersion: number;
  readonly catalog: readonly CatalogEntry[];
  readonly fragmentContracts: readonly unknown[];
  readonly catalogMetadataHash: string;
}

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const NIX_ROOT = path.join(REPO_ROOT, "nix");
const AUTHORITY = path.join(NIX_ROOT, "pkg", "cq-assets", "assets.nix");
const WORKSPACE_ROOT = path.join(NIX_ROOT, "pkg", "cq-ledgers");
const GENERATED_CATALOG = path.join(
  WORKSPACE_ROOT,
  "packages",
  "cq-config",
  "src",
  "promptCatalog.gen.ts",
);
const ASSETS_ROOT = path.join(NIX_ROOT, "pkg", "cq-assets");
const SURFACES = ["claude", "codex", "pi"] as const;

function run(command: readonly string[]): string {
  const result = Bun.spawnSync([...command], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trimEnd();
}

function evaluateProjection(): CatalogProjection {
  return JSON.parse(
    run(["nix", "eval", "--json", ".#llmAssets.promptCatalogProjection"]),
  ) as CatalogProjection;
}

function assertProjectionParity(
  authority: CatalogProjection,
  generated: CatalogProjection,
): void {
  if (
    !/^[0-9a-f]{64}$/.test(authority.catalogMetadataHash) ||
    !/^[0-9a-f]{64}$/.test(generated.catalogMetadataHash)
  ) {
    throw new Error("catalog metadata hash must be a SHA-256 hex digest");
  }
  if (generated.schemaVersion !== authority.schemaVersion) {
    throw new Error("generated projection has a different schema version");
  }
  const authorityRoleIds = authority.catalog.map((entry) => entry.roleId);
  const generatedRoleIds = generated.catalog.map((entry) => entry.roleId);
  if (JSON.stringify(generatedRoleIds) !== JSON.stringify(authorityRoleIds)) {
    throw new Error("generated projection has a different ordered role catalog");
  }
  if (JSON.stringify(generated.catalog) !== JSON.stringify(authority.catalog)) {
    throw new Error("generated projection has catalog metadata drift");
  }
  if (generated.catalogMetadataHash !== authority.catalogMetadataHash) {
    throw new Error("generated projection has a different catalog metadata hash");
  }
  if (JSON.stringify(generated.fragmentContracts) !== JSON.stringify(authority.fragmentContracts)) {
    throw new Error("generated projection has fragment-contract drift");
  }
}

function cloneProjection(projection: CatalogProjection): {
  schemaVersion: number;
  catalog: CatalogEntry[];
  fragmentContracts: unknown[];
  catalogMetadataHash: string;
} {
  return {
    schemaVersion: projection.schemaVersion,
    catalog: structuredClone([...projection.catalog]),
    fragmentContracts: structuredClone([...projection.fragmentContracts]),
    catalogMetadataHash: projection.catalogMetadataHash,
  };
}

function evaluateCatalog(): readonly CatalogEntry[] {
  return JSON.parse(
    run(["nix", "eval", "--json", ".#llmAssets.catalog"]),
  ) as readonly CatalogEntry[];
}

function evaluateRaw(attribute: string): string {
  return run(["nix", "eval", "--raw", `.#llmAssets.${attribute}`]);
}

function buildPromptRoot(surface: PromptSurface): string {
  return run([
    "nix",
    "build",
    "--no-link",
    "--print-out-paths",
    `.#${surface}-prompt-root`,
  ]);
}

function rootFromArtifacts(
  surface: PromptSurface,
  artifacts: readonly { readonly path: string; readonly content: string }[],
): PromptVerificationRoot {
  return {
    surface,
    artifacts: Object.fromEntries(
      artifacts.map((artifact) => [artifact.path, artifact.content]),
    ),
  };
}

function rootFromFilesystem(
  surface: PromptSurface,
  root: string,
): PromptVerificationRoot {
  const artifacts = [...new Bun.Glob("**/*").scanSync({
    cwd: root,
    onlyFiles: true,
  })]
    .sort()
    .map((artifactPath) => ({
      path: artifactPath,
      content: readFileSync(path.join(root, artifactPath), "utf8"),
    }));
  return rootFromArtifacts(surface, artifacts);
}

function substitutePromptSlots(
  role: CatalogEntry & { readonly fragmentBindings: readonly FragmentBinding[] },
  surface: PromptSurface,
  canonicalSource: string,
  fragmentSources: readonly FragmentSource[],
): string {
  let rendered = canonicalSource;
  for (const binding of role.fragmentBindings) {
    const marker = `{{cq:fragment:${binding.fragment}}}`;
    const parts = rendered.split(marker);
    if (parts.length !== 2) {
      throw new Error(
        `${role.canonicalSource}: expected one typed slot marker "${marker}"`,
      );
    }
    const fragmentSource = fragmentSources.find(
      (candidate) =>
        candidate.surface === surface &&
        candidate.roleId === role.roleId &&
        candidate.fragment === binding.fragment,
    );
    if (fragmentSource === undefined) {
      throw new Error(
        `missing fragment source ${surface}:${role.roleId}:${binding.fragment}`,
      );
    }
    rendered =
      parts[0]! +
      readFileSync(path.join(ASSETS_ROOT, fragmentSource.source), "utf8") +
      parts[1]!;
  }
  if (rendered.includes("{{cq:fragment:")) {
    throw new Error(`${role.canonicalSource}: unresolved typed slot marker`);
  }
  return rendered;
}

function independentlyRenderRoot(
  surface: PromptSurface,
  catalogJson: string,
  roles: readonly (CatalogEntry & {
    readonly fragmentBindings: readonly FragmentBinding[];
  })[],
  canonicalSources: Readonly<Record<string, string>>,
  fragmentSources: readonly FragmentSource[],
): PromptVerificationRoot {
  const roleArtifacts = roles.map((role) => ({
    path: `roles/${role.roleId}.md`,
    content: substitutePromptSlots(
      role,
      surface,
      canonicalSources[role.canonicalSource]!,
      fragmentSources,
    ),
  }));
  const schemaArtifacts = roles.flatMap((role) => {
    if (role.roleKind !== "dispatched-subagent") {
      return [];
    }
    const sidecar = getRoleSidecar(role.roleId);
    if (sidecar === undefined) {
      throw new Error(`missing sidecar for dispatched role ${role.roleId}`);
    }
    return [
      {
        path: `schemas/${role.roleId}.json`,
        content: serializeRoleSchemaArtifact(sidecar),
      },
    ];
  });
  const manifestRoles = roles.map((role, index) => {
    const sidecar =
      role.roleKind === "dispatched-subagent" ? getRoleSidecar(role.roleId) : undefined;
    if (sidecar === undefined) {
      return {
        roleId: role.roleId,
        version: null,
        sha256: createHash("sha256").update(roleArtifacts[index]!.content, "utf8").digest("hex"),
        schemaSha256: null,
      };
    }
    const schemaJson = serializeRoleSchemaArtifact(sidecar);
    return {
      roleId: role.roleId,
      version: sidecar.version,
      sha256: createHash("sha256").update(roleArtifacts[index]!.content, "utf8").digest("hex"),
      schemaSha256: createHash("sha256").update(schemaJson, "utf8").digest("hex"),
    };
  });
  return rootFromArtifacts(surface, [
    { path: "catalog.json", content: catalogJson },
    {
      path: "surface.json",
      content: serializePromptSurfaceManifest(
        surface,
        createHash("sha256").update(catalogJson, "utf8").digest("hex"),
        manifestRoles,
      ),
    },
    ...(surface === "pi"
      ? [
          {
            path: PI_ROLE_TOOL_PROFILE_MANIFEST_PATH,
            content: serializePiRoleToolProfileManifest(),
          },
        ]
      : []),
    ...schemaArtifacts,
    ...roleArtifacts,
  ]);
}

function publishClaudeRoot(
  artifacts: PromptVerificationRoot["artifacts"],
): PromptVerificationRoot {
  const script = `
    import { mkdir, mkdtemp } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import * as path from "node:path";
    import {
      materializeClaudePrompts,
      NodePromptPublicationStore,
    } from "./scripts/link-prompts.ts";

    const store = new NodePromptPublicationStore();
    const files = JSON.parse(await Bun.stdin.text());
    const tempRoot = await mkdtemp(path.join(tmpdir(), "cq-prompt-verification-"));
    const ledgersRoot = path.join(tempRoot, "nix", "pkg", "cq-ledgers");
    const generatedRoot = path.join(
      tempRoot,
      "nix",
      "pkg",
      "cq-assets",
      ".generated",
      "claude",
    );
    await mkdir(ledgersRoot, { recursive: true });
    try {
      await materializeClaudePrompts({
        store,
        ledgersRoot,
        generatedRoot,
        renderer: { render: async () => files },
      });
      process.stdout.write(JSON.stringify(
        await store.readTree(path.join(generatedRoot, "current")),
      ));
    } finally {
      await store.removeTree(tempRoot);
    }
  `;
  const files = Object.entries(artifacts).map(([artifactPath, content]) => ({
    path: artifactPath,
    content,
  }));
  const result = Bun.spawnSync(["bun", "--eval", script], {
    cwd: WORKSPACE_ROOT,
    stdin: new Blob([JSON.stringify(files)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return rootFromArtifacts(
    "claude",
    JSON.parse(new TextDecoder().decode(result.stdout)) as readonly {
      readonly path: string;
      readonly content: string;
    }[],
  );
}

describe("assets.nix prompt-catalog authority", () => {
  test("the generated projection has the same ordered catalog and metadata hash as Nix", () => {
    assertProjectionParity(
      evaluateProjection(),
      PROMPT_CATALOG_PROJECTION as unknown as CatalogProjection,
    );
  });

  test("parity rejects insertion, removal, reorder, metadata drift, and hash drift", () => {
    const authority = evaluateProjection();

    const insertion = cloneProjection(authority);
    insertion.catalog.splice(1, 0, structuredClone(insertion.catalog[0]!));
    expect(() => assertProjectionParity(authority, insertion)).toThrow(
      "different ordered role catalog",
    );

    const removal = cloneProjection(authority);
    removal.catalog.splice(1, 1);
    expect(() => assertProjectionParity(authority, removal)).toThrow(
      "different ordered role catalog",
    );

    const reorder = cloneProjection(authority);
    [reorder.catalog[0], reorder.catalog[1]] = [reorder.catalog[1]!, reorder.catalog[0]!];
    expect(() => assertProjectionParity(authority, reorder)).toThrow(
      "different ordered role catalog",
    );

    const metadataDrift = cloneProjection(authority);
    metadataDrift.catalog[0] = {
      ...metadataDrift.catalog[0]!,
      canonicalSource: "agents/drifted.md",
    };
    expect(() => assertProjectionParity(authority, metadataDrift)).toThrow(
      "catalog metadata drift",
    );

    const hashDrift = cloneProjection(authority);
    hashDrift.catalogMetadataHash = "0".repeat(64);
    expect(() => assertProjectionParity(authority, hashDrift)).toThrow(
      "different catalog metadata hash",
    );
  });

  test("the checked-in TypeScript projection is byte-identical to Nix generation", () => {
    const committed = readFileSync(GENERATED_CATALOG, "utf8");
    const result = Bun.spawnSync(["bun", "run", "gen-prompt-catalog"], {
      cwd: WORKSPACE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const fresh = readFileSync(GENERATED_CATALOG, "utf8");
    writeFileSync(GENERATED_CATALOG, committed, "utf8");

    expect(result.exitCode).toBe(0);
    expect(fresh).toBe(committed);
  });

  test(
    "the centralized verifier accepts real packaged and atomically published roots",
    async () => {
      const catalogJson = evaluateRaw("catalogJson");
      const projection = evaluateProjection();
      const roles = projection.catalog as readonly (CatalogEntry & {
        readonly fragmentBindings: readonly FragmentBinding[];
      })[];
      const fragmentSources = JSON.parse(
        evaluateRaw("promptFragmentSourcesJson"),
      ) as readonly FragmentSource[];
      const canonicalSources = Object.fromEntries(
        roles.map((role) => [
          role.canonicalSource,
          readFileSync(path.join(ASSETS_ROOT, role.canonicalSource), "utf8"),
        ]),
      );
      const expectedRoots = Object.fromEntries(
        SURFACES.map((surface) => [
          surface,
          independentlyRenderRoot(
            surface,
            catalogJson,
            roles,
            canonicalSources,
            fragmentSources,
          ),
        ]),
      ) as Record<PromptSurface, PromptVerificationRoot>;
      const packagedRoots = {} as Record<PromptSurface, PromptVerificationRoot>;
      for (const surface of SURFACES) {
        packagedRoots[surface] = rootFromFilesystem(
          surface,
          buildPromptRoot(surface),
        );
      }

      const fragmentObservations = await Promise.all(
        roles.flatMap((role) =>
          role.fragmentBindings.map(async (binding) => ({
            roleId: role.roleId,
            fragment: binding.fragment,
            contents: Object.fromEntries(
              await Promise.all(
                SURFACES.map(async (surface) => {
                  const source = fragmentSources.find(
                    (candidate) =>
                      candidate.surface === surface &&
                      candidate.roleId === role.roleId &&
                      candidate.fragment === binding.fragment,
                  );
                  if (source === undefined) {
                    throw new Error(
                      `missing fragment source ${surface}:${role.roleId}:${binding.fragment}`,
                    );
                  }
                  return [
                    surface,
                    await Bun.file(path.join(ASSETS_ROOT, source.source)).text(),
                  ];
                }),
              ),
            ) as Record<PromptSurface, string>,
          })),
        ),
      );
      verifyPromptCatalog({
        authoritativeCatalogJson: catalogJson,
        authoritativeProjection:
          projection as unknown as Readonly<Record<string, unknown>>,
        generatedProjection:
          PROMPT_CATALOG_PROJECTION as unknown as Readonly<Record<string, unknown>>,
        expectedRoots,
        packagedRoots,
        localClaudeRoot: publishClaudeRoot(expectedRoots.claude.artifacts),
        canonicalSources,
        fragmentObservations,
        sidecarRoleIds: Object.keys(DISPATCHED_ROLE_SIDECARS),
      });
    },
    120_000,
  );

  test("no independent authored full prompt roster exists elsewhere in the repository", async () => {
    const catalog = evaluateCatalog();
    const duplicateAuthorities: string[] = [];
    const sourceGlob = new Bun.Glob("**/*.{nix,ts,tsx,js,mjs,cjs}");

    for await (const file of sourceGlob.scan({ cwd: NIX_ROOT, absolute: true, onlyFiles: true })) {
      if (
        file === AUTHORITY ||
        file.endsWith(".gen.ts") ||
        file.includes("/dist/") ||
        file.includes("/node_modules/")
      ) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      const carriesEveryRoleId = catalog.every(({ roleId }) =>
        source.includes(JSON.stringify(roleId)),
      );
      const carriesEveryCanonicalSource = catalog.every(({ canonicalSource }) =>
        source.includes(canonicalSource),
      );
      if (carriesEveryRoleId || carriesEveryCanonicalSource) {
        duplicateAuthorities.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(duplicateAuthorities).toEqual([]);
  });

  test("ledger-mcp never imports the generated projection as a runtime prompt store", async () => {
    const ledgerMcpSource = path.join(
      WORKSPACE_ROOT,
      "packages",
      "ledger-mcp",
      "src",
    );
    const prohibitedConsumers: string[] = [];
    const sourceGlob = new Bun.Glob("**/*.ts");

    for await (const file of sourceGlob.scan({
      cwd: ledgerMcpSource,
      absolute: true,
      onlyFiles: true,
    })) {
      const source = readFileSync(file, "utf8");
      if (
        source.includes("promptCatalog.gen") ||
        source.includes("PROMPT_CATALOG_PROJECTION") ||
        source.includes("PROMPT_ROLE_SOURCE_INVENTORY")
      ) {
        prohibitedConsumers.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(prohibitedConsumers).toEqual([]);
  });
});
