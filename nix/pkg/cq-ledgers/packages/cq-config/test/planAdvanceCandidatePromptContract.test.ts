import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import * as path from "node:path";
import { DISPATCHED_ROLE_VERSIONS, planAdvanceSidecar, DISPATCHED_ROLE_SIDECARS } from "@cq/config";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput, serializeRoleSchemaArtifact} from "@cq/config/prompt-renderer";


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

function renderedPrompt(surface: PromptSurface): string {
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
    roleSchemas: DISPATCHED_ROLE_SCHEMAS });
  const prompt = tree.artifacts.find(
    (artifact) => artifact.path === "roles/plan-advance.md",
  )?.content;
  if (prompt === undefined) throw new Error(`surface ${surface} did not render plan-advance`);
  return prompt;
}

function candidateExample(surface: PromptSurface): unknown {
  const prompt = renderedPrompt(surface);
  const match = /## Candidate mode[\s\S]*?```json\n([\s\S]*?)\n```/.exec(prompt);
  if (match?.[1] === undefined) throw new Error(`surface ${surface} has no candidate JSON example`);
  return JSON.parse(match[1]) as unknown;
}

describe("plan-advance candidate prompt contract", () => {
  test("accepts default defect-fix ownership only through task ledgerRefs", () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
      planAdvanceSidecar.outputSchema,
    );
    const result = {
      mode: "default",
      action: "draft",
      manifest: {
        milestones: [{ key: "correction", title: "Correct guarded planning" }],
        tasks: [
          {
            key: "preserve_refs",
            milestoneKey: "correction",
            headline: "Preserve authoritative task ledger references",
            sourceRefs: ["packages/ledger/src/planLifecycle.ts"],
            ledgerRefs: ["goals:G1", "defects:D264"],
          },
        ],
      },
    };

    expect(validate(result)).toBe(true);
    expect(result.manifest.tasks[0]!.ledgerRefs).toEqual(["goals:G1", "defects:D264"]);
    expect(result.manifest.tasks[0]!.sourceRefs).not.toContain("defects:D264");

    const sourceRefsOnly = structuredClone(result);
    delete (sourceRefsOnly.manifest.tasks[0] as { ledgerRefs?: string[] }).ledgerRefs;
    sourceRefsOnly.manifest.tasks[0]!.sourceRefs.push("defects:D264");
    expect(validate(sourceRefsOnly)).toBe(false);
  });

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
      expect((example as { tasks: Array<{ ledgerRefs: string[] }> }).tasks[0]!.ledgerRefs).toEqual([
        "goals:<G>",
        "defects:<D>",
      ]);
      expect(renderedPrompt(surface)).toMatch(
        /Defect-fix tasks\s+carry their defect ownership in `ledgerRefs`; `sourceRefs` records provenance only\./,
      );
    }
    expect(validationFailures).toEqual([]);
    expect(modes).toEqual(["candidate", "candidate", "candidate"]);
  });
});
