import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

interface CatalogIdentity {
  readonly roleId: string;
  readonly canonicalSource: string;
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

function evaluateCatalog(): readonly CatalogIdentity[] {
  const result = Bun.spawnSync(["nix", "eval", "--json", ".#llmAssets.catalog"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as readonly CatalogIdentity[];
}

describe("assets.nix prompt-catalog authority", () => {
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
});
