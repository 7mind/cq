import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
  DISPATCHED_ROLE_VERSIONS,
  planReviewerSidecar,
  validateAgainstSchema,
} from "@cq/config";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "@cq/config/prompt-renderer";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const PROMPT_SURFACES = ["claude", "codex", "pi"] as const;
type PromptSurface = (typeof PROMPT_SURFACES)[number];
const EXPECTED_OUTPUT_FIELDS: string[] = [
  "summary",
  "verdict",
  "new_questions",
  "criticism",
  "defects",
];

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

function renderedPlanReviewer(surface: PromptSurface): string {
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
  const artifact = tree.artifacts.find(({ path: artifactPath }) =>
    artifactPath.endsWith("roles/plan-reviewer.md"),
  );
  if (artifact === undefined) throw new Error(`${surface} rendered no plan-reviewer prompt`);
  return artifact.content;
}

const RENDERED_PROMPTS = new Map(
  PROMPT_SURFACES.map((surface) => [surface, renderedPlanReviewer(surface)] as const),
);

function extractVerdictExample(prompt: string): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(prompt);
  if (match?.[1] === undefined) {
    throw new Error("plan-reviewer prompt has no fenced verdict example");
  }
  const parsed: unknown = JSON.parse(match[1]);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("plan-reviewer verdict example must be an object");
  }
  return parsed as Record<string, unknown>;
}

function contradictoryOutputRequirements(prompt: string): readonly string[] {
  const normalized = prompt.replace(/\s+/g, " ").toLowerCase();
  const contradictions: string[] = [];
  if (normalized.includes("result object must include the mode")) {
    contradictions.push("mode");
  }
  if (normalized.includes("finding counts")) {
    contradictions.push("finding counts");
  }
  return contradictions;
}

describe("D253 plan-reviewer prompt/schema contract", () => {
  it("keeps every rendered example on the unchanged v1 five-field schema", () => {
    expect(planReviewerSidecar.version).toBe(1);
    const properties = planReviewerSidecar.outputSchema.properties;
    if (properties === undefined) throw new Error("plan-reviewer output properties are absent");
    expect(Object.keys(properties)).toEqual(EXPECTED_OUTPUT_FIELDS);
    expect(planReviewerSidecar.outputSchema.required).toEqual(EXPECTED_OUTPUT_FIELDS);
    for (const surface of PROMPT_SURFACES) {
      const prompt = RENDERED_PROMPTS.get(surface)!;
      const example = extractVerdictExample(prompt);
      expect(Object.keys(example), surface).toEqual(EXPECTED_OUTPUT_FIELDS);
      expect(validateAgainstSchema(planReviewerSidecar.outputSchema, example).ok, surface).toBe(
        true,
      );
      expect(contradictoryOutputRequirements(prompt), surface).toEqual([]);
    }
  });

  it("rejects contradictory prose and fields on every rendered surface", () => {
    for (const surface of PROMPT_SURFACES) {
      const prompt = RENDERED_PROMPTS.get(surface)!;
      const mutatedPrompt = `${prompt}\nThe result object must include the mode and finding counts.\n`;
      expect(contradictoryOutputRequirements(mutatedPrompt), surface).toEqual([
        "mode",
        "finding counts",
      ]);
      expect(
        validateAgainstSchema(planReviewerSidecar.outputSchema, {
          ...extractVerdictExample(prompt),
          mode: "panel",
          findingCounts: { defects: 0 },
        }).ok,
        surface,
      ).toBe(false);
    }
  });
});
