import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "@cq/config/prompt-renderer";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");

interface CatalogRelation {
  readonly kind: "dispatch" | "recursion";
  readonly targetRoleId: string;
}

interface CatalogRole {
  readonly roleId: string;
  readonly roleKind: "dispatched-subagent" | "orchestrator-command";
  readonly canonicalSource: string;
  readonly dispatchRelations: readonly CatalogRelation[];
  readonly sidecar: null | { readonly schemaRoleId: string };
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

function build(attribute: string): string {
  return run(["nix", "build", "--no-link", "--print-out-paths", attribute]);
}

function skillName(roleId: string): string {
  return `cq-${roleId.replaceAll("/", "-")}`;
}

function referenceName(role: CatalogRole): string {
  return role.roleKind === "orchestrator-command"
    ? `${skillName(role.roleId)}.md`
    : `role-${role.roleId}.md`;
}

function declaredClosure(
  rootRoleId: string,
  catalog: readonly CatalogRole[],
): readonly CatalogRole[] {
  const byId = new Map(catalog.map((role) => [role.roleId, role]));
  const visited = new Set<string>();
  const pending = [rootRoleId];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const role = byId.get(current);
    if (role === undefined) {
      throw new Error(`unknown role in test fixture: ${current}`);
    }
    pending.push(...role.dispatchRelations.map(({ targetRoleId }) => targetRoleId));
  }
  return catalog.filter(({ roleId }) => visited.has(roleId));
}

describe("packaged Codex prompt root and command skills", () => {
  test(
    "renders the direct Nix catalog and projects every manifest closure",
    () => {
      const promptRoot = build(".#codex-prompt-root");
      const skillsRoot = build(".#checks.x86_64-linux.codex-cq-skills");
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
        .filter(({ surface }) => surface === "codex")
        .map(({ roleId, fragment, source }) => ({
          roleId,
          fragment,
          path: path.join(ASSETS_ROOT, source),
        }));
      const direct = renderPromptSurfaceTree({
        surface: "codex",
        catalogJson,
        sourcePaths,
        fragmentPaths,
      });
      const commands = catalog.filter(
        ({ roleKind }) => roleKind === "orchestrator-command",
      );
      const dispatched = catalog.filter(
        ({ roleKind }) => roleKind === "dispatched-subagent",
      );

      expect(commands).toHaveLength(15);
      expect(dispatched).toHaveLength(9);
      expect(dispatched.map(({ sidecar }) => sidecar?.schemaRoleId)).toEqual(
        dispatched.map(({ roleId }) => roleId),
      );
      expect(readFileSync(path.join(promptRoot, "catalog.json"), "utf8")).toBe(
        catalogJson,
      );
      expect(readFileSync(path.join(promptRoot, "surface.json"), "utf8")).toBe(
        '{"surface":"codex"}',
      );
      for (const artifact of direct.artifacts.slice(1)) {
        expect(readFileSync(path.join(promptRoot, artifact.path), "utf8")).toBe(
          artifact.content,
        );
      }

      expect(readdirSync(skillsRoot).sort()).toEqual(
        commands.map(({ roleId }) => skillName(roleId)).sort(),
      );
      for (const command of commands) {
        const name = skillName(command.roleId);
        const skillRoot = path.join(skillsRoot, name);
        const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
        const references = readdirSync(path.join(skillRoot, "references")).sort();
        const closure = declaredClosure(command.roleId, catalog);
        expect(references).toEqual(closure.map(referenceName).sort());
        expect(skill).toStartWith(`---\nname: ${name}\ndescription: `);
        expect(skill).toContain(`Treat text accompanying \`$${name}\``);
      }

      const representative = readFileSync(
        path.join(promptRoot, "roles", "plan", "advance.md"),
        "utf8",
      );
      expect(representative).toContain("`spawn_agent` transport");
      expect(representative).toContain("$cq-<path>");
      expect(representative).toContain("$ARGUMENTS");
      const rendered = direct.artifacts
        .slice(1)
        .map(({ content }) => content)
        .join("\n");
      expect(rendered).not.toMatch(
        /Agent\(|Task\(|dispatch_agent\(|\/cq:|\{\{cq:fragment:/,
      );
    },
    30_000,
  );

  test(
    "has repeatable outputs without a generated TypeScript catalog input",
    () => {
      expect(build(".#codex-prompt-root")).toBe(build(".#codex-prompt-root"));
      expect(build(".#checks.x86_64-linux.codex-cq-skills")).toBe(
        build(".#checks.x86_64-linux.codex-cq-skills"),
      );
      const derivation = run(["nix", "derivation", "show", ".#codex-prompt-root"]);
      expect(derivation).not.toContain("promptCatalog.gen.ts");
      expect(derivation).not.toContain("PROMPT_CATALOG_PROJECTION");
    },
    30_000,
  );
});
