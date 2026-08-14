import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DISPATCHED_ROLE_SIDECARS,
  DISPATCHED_ROLE_VERSIONS,
} from "@cq/config";
import {
  renderPromptSurfaceTree,
  serializeRoleSchemaArtifact,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "@cq/config/prompt-renderer";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = join(REPOSITORY_ROOT, "nix", "pkg", "cq-assets");
const SURFACES = ["claude", "codex", "pi"] as const;
const RAW_MUTATING_GIT = /\bgit\s+(?:worktree\s+(?:add|remove|prune)|branch\s+(?:-D|-d)|rebase(?:\s|$)|merge(?:\s|$)|update-ref(?:\s|$))/u;

interface CatalogRole {
  readonly roleId: string;
  readonly canonicalSource: string;
}

interface FragmentSource {
  readonly surface: string;
  readonly roleId: string;
  readonly fragment: string;
  readonly source: string;
}

function nixJson(attribute: string): string {
  const result = Bun.spawnSync(["nix", "eval", "--raw", `.#llmAssets.${attribute}`], {
    cwd: REPOSITORY_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trimEnd();
}

const catalogJson = nixJson("catalogJson");
const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
const fragmentSources = JSON.parse(nixJson("promptFragmentSourcesJson")) as readonly FragmentSource[];
const sourcePaths: PromptCatalogFileInput[] = catalog.map((role) => ({
  canonicalSource: role.canonicalSource,
  path: join(ASSETS_ROOT, role.canonicalSource),
}));
const roleSchemas = Object.fromEntries(
  Object.values(DISPATCHED_ROLE_SIDECARS).map((sidecar) => [
    sidecar.id,
    serializeRoleSchemaArtifact(sidecar),
  ]),
);

function implementAdvance(surface: (typeof SURFACES)[number]): string {
  const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
    .filter((entry) => entry.surface === surface)
    .map((entry) => ({
      roleId: entry.roleId,
      fragment: entry.fragment,
      path: join(ASSETS_ROOT, entry.source),
    }));
  const tree = renderPromptSurfaceTree({
    surface,
    catalogJson,
    sourcePaths,
    fragmentPaths,
    roleVersions: DISPATCHED_ROLE_VERSIONS,
    roleSchemas,
  });
  const artifact = tree.artifacts.find((entry) => entry.path === "roles/implement/advance.md");
  if (artifact === undefined) throw new Error(`missing ${surface} implement/advance artifact`);
  return artifact.content;
}

describe("T1984 generated Git effect command surfaces", () => {
  test("Claude, Codex, and Pi use only the task-bound broker for rebase and merge [Behavioral-Active Blackbox-Group]", () => {
    for (const surface of SURFACES) {
      const body = implementAdvance(surface);
      expect(body).toContain(
        "cq gate git-effect --operation rebase --cwd <repositoryRoot> --task-id <taskId> --commit <currentMainCommit>",
      );
      expect(body).toContain(
        "cq gate git-effect --operation merge --cwd <repositoryRoot> --task-id <taskId> --commit <resultCommit>",
      );
      expect(body.match(RAW_MUTATING_GIT), surface).toBeNull();
    }
  });

  test("the tracked generated catalogues contain the same brokered command and no raw merge", () => {
    const body = readFileSync(
      join(import.meta.dir, "..", "..", "ledger-web", "src", "agentsCatalogue.gen.ts"),
      "utf8",
    );
    expect(body).toContain("cq gate git-effect --operation merge");
    expect(body).not.toContain("git merge --ff-only <resultCommit>");
  });
});
