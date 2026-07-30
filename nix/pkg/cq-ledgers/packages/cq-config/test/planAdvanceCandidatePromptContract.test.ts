import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import * as path from "node:path";
import { DISPATCHED_ROLE_VERSIONS, planAdvanceSidecar } from "@cq/config";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "@cq/config/prompt-renderer";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const PROMPT_SURFACES = ["claude", "codex", "pi"] as const;
type PromptSurface = (typeof PROMPT_SURFACES)[number];

interface CatalogRole {
  readonly roleId: string;
  readonly canonicalSource: string;
}

interface FragmentSource {
  readonly surface: PromptSurface;
  readonly roleId: string;
  readonly fragment: string;
  readonly source: string;
}

function evaluateNixRaw(attribute: string): string {
  const result = Bun.spawnSync(["nix", "eval", "--raw", `.#llmAssets.${attribute}`], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`nix eval ${attribute}: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trimEnd();
}

const catalogJson = evaluateNixRaw("catalogJson");
const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
const fragmentSources = JSON.parse(
  evaluateNixRaw("promptFragmentSourcesJson"),
) as readonly FragmentSource[];
const sourcePaths: PromptCatalogFileInput[] = catalog.map((role) => ({
  canonicalSource: role.canonicalSource,
  path: path.join(ASSETS_ROOT, role.canonicalSource),
}));

function candidateExample(surface: PromptSurface): unknown {
  const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
    .filter((entry) => entry.surface === surface)
    .map(({ roleId, fragment, source }) => ({
      roleId,
      fragment,
      path: path.join(ASSETS_ROOT, source),
    }));
  const tree = renderPromptSurfaceTree({
    surface,
    catalogJson,
    sourcePaths,
    fragmentPaths,
    roleVersions: DISPATCHED_ROLE_VERSIONS,
  });
  const prompt = tree.artifacts.find(
    (artifact) => artifact.path === "roles/plan-advance.md",
  )?.content;
  if (prompt === undefined) throw new Error(`surface ${surface} did not render plan-advance`);
  const match = /## Candidate mode[\s\S]*?```json\n([\s\S]*?)\n```/.exec(prompt);
  if (match?.[1] === undefined) throw new Error(`surface ${surface} has no candidate JSON example`);
  return JSON.parse(match[1]) as unknown;
}

describe("plan-advance candidate prompt contract", () => {
  test("every generated surface emits a schema-valid candidate example", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
      planAdvanceSidecar.outputSchema,
    );
    const validationFailures: string[] = [];
    const modes: unknown[] = [];
    for (const surface of PROMPT_SURFACES) {
      const example = candidateExample(surface);
      if (!validate(example)) {
        validationFailures.push(
          `${surface}: ${validate.errors?.map((error) => error.message).join("; ")}`,
        );
      }
      modes.push(
        typeof example === "object" && example !== null && "mode" in example
          ? example.mode
          : undefined,
      );
    }
    expect(validationFailures).toEqual([]);
    expect(modes).toEqual(["candidate", "candidate", "candidate"]);
  });
});
