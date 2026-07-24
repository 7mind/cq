import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
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
  readonly fragmentBindings: readonly { readonly fragment: string }[];
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

describe("orchestrator command prompt sources", () => {
  test("renders cq:begin from the canonical source and explicit typed fragments", () => {
    const catalog = JSON.parse(evaluateNixJson("catalogJson")) as readonly CatalogRole[];
    const fragmentSources = JSON.parse(
      evaluateNixJson("promptFragmentSourcesJson"),
    ) as readonly FragmentSource[];
    const begin = catalog.find(({ roleId }) => roleId === "begin");
    expect(begin).toBeDefined();

    const sourcePaths: PromptCatalogFileInput[] = [
      {
        canonicalSource: begin!.canonicalSource,
        path: path.join(ASSETS_ROOT, begin!.canonicalSource),
      },
    ];

    for (const surface of PROMPT_SURFACES) {
      const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
        .filter((entry) => entry.surface === surface && entry.roleId === "begin")
        .map((entry) => ({
          roleId: entry.roleId,
          fragment: entry.fragment,
          path: path.join(ASSETS_ROOT, entry.source),
        }));
      const tree = renderPromptSurfaceTree({
        surface,
        catalogJson: JSON.stringify([begin]),
        sourcePaths,
        fragmentPaths,
      });

      expect(tree.artifacts[1]!.path).toBe("roles/begin.md");
      expect(tree.artifacts[1]!.content).toStartWith("---\n");
      expect(tree.artifacts[1]!.content).toContain("$ARGUMENTS");
      expect(tree.artifacts[1]!.content).not.toContain("{{cq:fragment:");
      expect(tree.artifacts[1]!.content).not.toContain("CQ_HARNESS");
      expect(fragmentPaths).toHaveLength(begin!.fragmentBindings.length);
      expect(readFileSync(sourcePaths[0]!.path, "utf8")).toContain(
        "{{cq:fragment:inline-command-recursion}}",
      );
    }
  });

  test("renders the complete command roster with frontmatter and dispatch closure", () => {
    const catalogJson = evaluateNixJson("orchestratorCatalogJson");
    const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
    const fragmentSources = JSON.parse(
      evaluateNixJson("promptFragmentSourcesJson"),
    ) as readonly FragmentSource[];
    const sourcePaths: PromptCatalogFileInput[] = catalog.map((role) => ({
      canonicalSource: role.canonicalSource,
      path: path.join(ASSETS_ROOT, role.canonicalSource),
    }));

    expect(catalog.some(({ roleId }) => roleId === "begin")).toBe(true);
    expect(fragmentSources).toHaveLength(
      catalog.reduce((count, role) => count + role.fragmentBindings.length, 0) *
        PROMPT_SURFACES.length,
    );

    for (const role of catalog) {
      const source = readFileSync(path.join(ASSETS_ROOT, role.canonicalSource), "utf8");
      expect(source).toStartWith("---\n");
      for (const { fragment } of role.fragmentBindings) {
        expect(source.match(new RegExp(`\\{\\{cq:fragment:${fragment}\\}\\}`, "g"))).toHaveLength(
          1,
        );
      }
      for (const relation of role.dispatchRelations) {
        expect(source).toContain(relation.targetRoleId);
      }
    }

    for (const surface of PROMPT_SURFACES) {
      const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
        .filter((entry) => entry.surface === surface)
        .map((entry) => ({
          roleId: entry.roleId,
          fragment: entry.fragment,
          path: path.join(ASSETS_ROOT, entry.source),
        }));
      const input = { surface, catalogJson, sourcePaths, fragmentPaths };
      const first = renderPromptSurfaceTree(input);
      const second = renderPromptSurfaceTree(input);

      expect(second).toEqual(first);
      expect(first.artifacts).toHaveLength(catalog.length + 1);
      for (const [index, role] of catalog.entries()) {
        const content = first.artifacts[index + 1]!.content;
        const source = readFileSync(path.join(ASSETS_ROOT, role.canonicalSource), "utf8");
        const description = source.split("\n").find((line) => line.startsWith("description:"));
        expect(first.artifacts[index + 1]!.path).toBe(`roles/${role.roleId}.md`);
        expect(content).toStartWith("---\n");
        expect(content).toContain("\n---\n");
        expect(content).toContain(description!);
        expect(content).not.toContain("{{cq:fragment:");
        expect(content).not.toContain("CQ_HARNESS");
        if (role.fragmentBindings.some(({ fragment }) => fragment === "host-tool-vocabulary")) {
          if (surface === "claude") {
            expect(content).toMatch(/^allowed-tools:/m);
          } else {
            expect(content).not.toMatch(/^allowed-tools:/m);
          }
        }
        for (const relation of role.dispatchRelations) {
          expect(content).toContain(relation.targetRoleId);
        }
      }
    }
  });

  test("rejects missing and unconsumed fragments against the real command roster", () => {
    const catalogJson = evaluateNixJson("orchestratorCatalogJson");
    const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
    const fragmentSources = JSON.parse(
      evaluateNixJson("promptFragmentSourcesJson"),
    ) as readonly FragmentSource[];
    const sourcePaths: PromptCatalogFileInput[] = catalog.map((role) => ({
      canonicalSource: role.canonicalSource,
      path: path.join(ASSETS_ROOT, role.canonicalSource),
    }));
    const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
      .filter((entry) => entry.surface === "codex")
      .map((entry) => ({
        roleId: entry.roleId,
        fragment: entry.fragment,
        path: path.join(ASSETS_ROOT, entry.source),
      }));
    const missing = fragmentPaths.slice(1);
    expect(() =>
      renderPromptSurfaceTree({
        surface: "codex",
        catalogJson,
        sourcePaths,
        fragmentPaths: missing,
      }),
    ).toThrow(
      'fragments.begin.cq-command-invocation: missing slot input for surface "codex"',
    );

    const root = mkdtempSync(path.join(tmpdir(), "cq-command-source-"));
    try {
      const begin = catalog.find(({ roleId }) => roleId === "begin");
      expect(begin).toBeDefined();
      const copiedSource = path.join(root, "begin.md");
      writeFileSync(
        copiedSource,
        readFileSync(path.join(ASSETS_ROOT, begin!.canonicalSource), "utf8").replace(
          "{{cq:fragment:inline-command-recursion}}\n",
          "",
        ),
      );
      const copiedPaths = sourcePaths.map((entry) =>
        entry.canonicalSource === begin!.canonicalSource
          ? { ...entry, path: copiedSource }
          : entry,
      );
      expect(() =>
        renderPromptSurfaceTree({
          surface: "codex",
          catalogJson,
          sourcePaths: copiedPaths,
          fragmentPaths,
        }),
      ).toThrow("fragments.begin.inline-command-recursion: unconsumed slot input");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
