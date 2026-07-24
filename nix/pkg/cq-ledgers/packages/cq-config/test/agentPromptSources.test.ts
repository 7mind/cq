import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DISPATCHED_ROLE_IDS, getRoleSidecar } from "@cq/config";
import {
  PromptRendererError,
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "@cq/config/prompt-renderer";

const PROMPT_SURFACES = ["claude", "codex", "pi"] as const;
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");

interface CatalogRole {
  readonly roleId: string;
  readonly roleKind: "dispatched-subagent" | "orchestrator-command";
  readonly canonicalSource: string;
  readonly sidecar: { readonly schemaRoleId: string } | null;
  readonly fragmentBindings: readonly {
    readonly fragment: string;
    readonly forbiddenVocabulary: Readonly<
      Record<(typeof PROMPT_SURFACES)[number], readonly string[]>
    >;
  }[];
  readonly dispatchRelations: readonly {
    readonly kind: "dispatch" | "recursion";
    readonly targetRoleId: string;
  }[];
}

interface FragmentSource {
  readonly surface: (typeof PROMPT_SURFACES)[number];
  readonly roleId: string;
  readonly fragment: string;
  readonly source: string;
}

function evaluateNixJson(attribute: string): string {
  const result = Bun.spawnSync(["nix", "eval", "--raw", `.#llmAssets.${attribute}`], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout);
}

function captureRendererError(run: () => unknown): PromptRendererError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PromptRendererError);
    return error as PromptRendererError;
  }
  throw new Error("expected PromptRendererError");
}

describe("dispatched-role prompt sources", () => {
  test("renders the complete typed-sidecar roster on every surface", () => {
    const catalogJson = evaluateNixJson("agentCatalogJson");
    const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
    const completeCatalog = JSON.parse(
      evaluateNixJson("catalogJson"),
    ) as readonly CatalogRole[];
    const fragmentSources = JSON.parse(
      evaluateNixJson("promptFragmentSourcesJson"),
    ) as readonly FragmentSource[];
    const sourcePaths: PromptCatalogFileInput[] = catalog.map((role) => ({
      canonicalSource: role.canonicalSource,
      path: path.join(ASSETS_ROOT, role.canonicalSource),
    }));
    const completeRoleIds = new Set(completeCatalog.map(({ roleId }) => roleId));

    expect(catalog.map(({ roleId }) => roleId)).toEqual([...DISPATCHED_ROLE_IDS]);
    expect(catalog).toHaveLength(9);
    expect(fragmentSources.filter(({ roleId }) => DISPATCHED_ROLE_IDS.includes(roleId))).toHaveLength(
      catalog.reduce((count, role) => count + role.fragmentBindings.length, 0) *
        PROMPT_SURFACES.length,
    );
    for (const role of catalog) {
      expect(role.roleKind).toBe("dispatched-subagent");
      expect(role.sidecar).toEqual({ schemaRoleId: role.roleId });
      expect(getRoleSidecar(role.roleId)).toBeDefined();
      expect(role.dispatchRelations).toEqual([]);
      expect(
        completeCatalog.some((parent) =>
          parent.dispatchRelations.some(
            (relation) =>
              relation.kind === "dispatch" && relation.targetRoleId === role.roleId,
          ),
        ),
      ).toBe(true);

      const source = readFileSync(path.join(ASSETS_ROOT, role.canonicalSource), "utf8");
      expect(source).toStartWith("---\n");
      expect(source).not.toContain("CQ_HARNESS");
      for (const { fragment } of role.fragmentBindings) {
        expect(source.match(new RegExp(`\\{\\{cq:fragment:${fragment}\\}\\}`, "g"))).toHaveLength(
          1,
        );
      }
      for (const target of source.matchAll(/\bCQ::([a-z0-9-]+(?:\/[a-z0-9-]+)*)/g)) {
        expect(completeRoleIds).toContain(target[1]!);
      }
    }

    for (const surface of PROMPT_SURFACES) {
      const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
        .filter(
          (entry) => entry.surface === surface && DISPATCHED_ROLE_IDS.includes(entry.roleId),
        )
        .map((entry) => ({
          roleId: entry.roleId,
          fragment: entry.fragment,
          path: path.join(ASSETS_ROOT, entry.source),
        }));
      const tree = renderPromptSurfaceTree({
        surface,
        catalogJson,
        sourcePaths,
        fragmentPaths,
      });
      expect(
        renderPromptSurfaceTree({ surface, catalogJson, sourcePaths, fragmentPaths }),
      ).toEqual(tree);
      expect(tree.artifacts).toHaveLength(catalog.length + 1);

      for (const [index, role] of catalog.entries()) {
        const content = tree.artifacts[index + 1]!.content;
        expect(tree.artifacts[index + 1]!.path).toBe(`roles/${role.roleId}.md`);
        expect(content).toStartWith("---\n");
        expect(content).toContain(`name: ${role.roleId}`);
        expect(content).not.toContain("{{cq:fragment:");
        expect(content).not.toContain("CQ_HARNESS");
        if (surface === "claude") {
          expect(content).toMatch(/^(?:isolation|disallowedTools):/m);
        } else {
          expect(content).not.toMatch(/^(?:isolation|disallowedTools):/m);
        }
        for (const binding of role.fragmentBindings) {
          for (const token of binding.forbiddenVocabulary[surface]) {
            expect(content).not.toContain(token);
          }
        }
      }
    }
  });

  test("rejects missing and unconsumed slots against the real dispatched roster", () => {
    const catalogJson = evaluateNixJson("agentCatalogJson");
    const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
    const fragmentSources = JSON.parse(
      evaluateNixJson("promptFragmentSourcesJson"),
    ) as readonly FragmentSource[];
    const sourcePaths: PromptCatalogFileInput[] = catalog.map((role) => ({
      canonicalSource: role.canonicalSource,
      path: path.join(ASSETS_ROOT, role.canonicalSource),
    }));
    const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
      .filter(
        (entry) => entry.surface === "codex" && DISPATCHED_ROLE_IDS.includes(entry.roleId),
      )
      .map((entry) => ({
        roleId: entry.roleId,
        fragment: entry.fragment,
        path: path.join(ASSETS_ROOT, entry.source),
      }));
    const first = fragmentPaths[0]!;
    const missing = captureRendererError(() =>
      renderPromptSurfaceTree({
        surface: "codex",
        catalogJson,
        sourcePaths,
        fragmentPaths: fragmentPaths.slice(1),
      }),
    );
    expect(missing.message).toBe(
      `fragments.${first.roleId}.${first.fragment}: missing slot input for surface "codex"`,
    );

    const root = mkdtempSync(path.join(tmpdir(), "cq-agent-source-"));
    try {
      const role = catalog.find(({ roleId }) => roleId === first.roleId)!;
      const copiedSource = path.join(root, `${role.roleId}.md`);
      writeFileSync(
        copiedSource,
        readFileSync(path.join(ASSETS_ROOT, role.canonicalSource), "utf8").replace(
          `{{cq:fragment:${first.fragment}}}`,
          "",
        ),
      );
      const copiedPaths = sourcePaths.map((entry) =>
        entry.canonicalSource === role.canonicalSource
          ? { ...entry, path: copiedSource }
          : entry,
      );
      const unconsumed = captureRendererError(() =>
        renderPromptSurfaceTree({
          surface: "codex",
          catalogJson,
          sourcePaths: copiedPaths,
          fragmentPaths,
        }),
      );
      expect(unconsumed.message).toBe(
        `fragments.${first.roleId}.${first.fragment}: unconsumed slot input`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
