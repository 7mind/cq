import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { PROMPT_CATALOG_PROJECTION } from "../src/promptCatalog.gen.js";

interface CatalogEntry {
  readonly roleId: string;
  readonly canonicalSource: string;
  readonly [key: string]: unknown;
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

function evaluateProjection(): CatalogProjection {
  const result = Bun.spawnSync(
    ["nix", "eval", "--json", ".#llmAssets.promptCatalogProjection"],
    {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as CatalogProjection;
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
  const result = Bun.spawnSync(["nix", "eval", "--json", ".#llmAssets.catalog"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as readonly CatalogEntry[];
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
