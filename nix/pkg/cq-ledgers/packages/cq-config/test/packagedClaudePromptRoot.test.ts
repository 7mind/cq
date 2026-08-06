import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  DISPATCHED_ROLE_SIDECARS,
  DISPATCHED_ROLE_VERSIONS } from "@cq/config";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
  serializeRoleSchemaArtifact,
} from "@cq/config/prompt-renderer";


const DISPATCHED_ROLE_SCHEMAS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.values(DISPATCHED_ROLE_SIDECARS).map((sidecar) => [
      sidecar.id,
      serializeRoleSchemaArtifact(sidecar),
    ]),
  ),
);

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");

interface CatalogRole {
  readonly roleId: string;
  readonly canonicalSource: string;
}

interface FragmentSource {
  readonly surface: "claude" | "codex" | "pi";
  readonly roleId: string;
  readonly fragment: string;
  readonly source: string;
}

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

function evaluateRaw(attribute: string): string {
  return run(["nix", "eval", "--raw", `.#llmAssets.${attribute}`]);
}

function buildClaudePromptRoot(): string {
  return run([
    "nix",
    "build",
    "--no-link",
    "--print-out-paths",
    ".#claude-prompt-root",
  ]);
}

describe("packaged Claude prompt root", () => {
  test(
    "builds the exact catalog and all 24 directly rendered role artifacts",
    () => {
      const output = buildClaudePromptRoot();
      const catalogJson = evaluateRaw("catalogJson");
      const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
      const fragmentSources = JSON.parse(
        evaluateRaw("promptFragmentSourcesJson"),
      ) as readonly FragmentSource[];
      const sourcePaths: PromptCatalogFileInput[] = catalog.map((role) => ({
        canonicalSource: role.canonicalSource,
        path: path.join(ASSETS_ROOT, role.canonicalSource),
      }));
      const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
        .filter(({ surface }) => surface === "claude")
        .map(({ roleId, fragment, source }) => ({
          roleId,
          fragment,
          path: path.join(ASSETS_ROOT, source),
        }));
      const direct = renderPromptSurfaceTree({
        surface: "claude",
        catalogJson,
        sourcePaths,
        fragmentPaths,
        roleVersions: DISPATCHED_ROLE_VERSIONS,
    roleSchemas: DISPATCHED_ROLE_SCHEMAS,
      });

      expect(catalog).toHaveLength(24);
      expect(catalog.some(({ roleId }) => roleId === "begin")).toBe(true);
      expect(readdirSync(output).sort()).toEqual(["catalog.json", "roles", "schemas", "surface.json"]);
      expect(readFileSync(path.join(output, "catalog.json"), "utf8")).toBe(catalogJson);
      const manifest = JSON.parse(
        readFileSync(path.join(output, "surface.json"), "utf8"),
      ) as {
        readonly surface: string;
        readonly roles: readonly { readonly version: number | null }[];
      };
      expect(manifest.surface).toBe("claude");
      expect(manifest.roles).toHaveLength(catalog.length);
      expect(
        [...new Bun.Glob("**/*.md").scanSync({ cwd: path.join(output, "roles") })].sort(),
      ).toEqual(catalog.map(({ roleId }) => `${roleId}.md`).sort());
      for (const artifact of direct.artifacts.slice(1)) {
        expect(readFileSync(path.join(output, artifact.path), "utf8")).toBe(artifact.content);
      }

      const rendered = direct.artifacts.map(({ content }) => content).join("\n");
      expect(rendered).toContain("$ARGUMENTS");
      expect(rendered).toContain("$CLAUDE_CODE_SESSION_ID");
      expect(rendered).not.toContain("{{cq:fragment:");
      expect(rendered).not.toContain("CQ_HARNESS");
    },
    30_000,
  );

  test(
    "has a reproducible output path and no generated-catalog dependency",
    () => {
      expect(buildClaudePromptRoot()).toBe(buildClaudePromptRoot());

      const derivation = run(["nix", "derivation", "show", ".#claude-prompt-root"]);
      expect(derivation).not.toContain("promptCatalog.gen.ts");
      expect(derivation).not.toContain("PROMPT_CATALOG_PROJECTION");
    },
    30_000,
  );
});
