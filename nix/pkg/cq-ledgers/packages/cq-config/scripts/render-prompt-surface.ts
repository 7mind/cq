import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "../src/promptRenderer.js";
import { serializePiRoleToolProfileManifest } from "../src/roleToolProfiles.js";
// The per-role schema sidecars supply the contract versions stamped into the
// attested surface manifest. This list MIRRORS
// `promptCatalogStore.DISPATCHED_ROLE_SIDECARS`: the Nix renderer derivation
// must not import promptCatalogStore/agentRoster because those pull in the
// generated promptCatalog.gen.ts mirror, which is never an input to a Nix
// prompt renderer derivation. The renderer fails the build closed when this
// closure drifts from the catalog's dispatched roles.
import { implementConflictResolverSidecar } from "../src/schemas/implement-conflict-resolver.js";
import { implementReviewerSidecar } from "../src/schemas/implement-reviewer.js";
import { implementWorkerSidecar } from "../src/schemas/implement-worker.js";
import { investigateExplorerSidecar } from "../src/schemas/investigate-explorer.js";
import { investigateProberSidecar } from "../src/schemas/investigate-prober.js";
import { planAdvanceSidecar } from "../src/schemas/plan-advance.js";
import { planReviewerSidecar } from "../src/schemas/plan-reviewer.js";
import { researchExperimenterSidecar } from "../src/schemas/research-experimenter.js";
import { researchExplorerSidecar } from "../src/schemas/research-explorer.js";

const DISPATCHED_ROLE_VERSIONS: Readonly<Record<string, number>> = Object.fromEntries(
  [
    planAdvanceSidecar,
    planReviewerSidecar,
    implementWorkerSidecar,
    implementReviewerSidecar,
    implementConflictResolverSidecar,
    investigateExplorerSidecar,
    investigateProberSidecar,
    researchExplorerSidecar,
    researchExperimenterSidecar,
  ].map((sidecar) => [sidecar.id, sidecar.version]),
);

const argumentsAfterScript = process.argv.slice(2);
if (argumentsAfterScript.length !== 5) {
  throw new Error(
    "usage: render-prompt-surface <surface> <catalog-json> <source-paths-json> <fragment-paths-json> <output-root>",
  );
}

const [surface, catalogPath, sourcePathsPath, fragmentPathsPath, outputRoot] =
  argumentsAfterScript as [string, string, string, string, string];
for (const [label, inputPath] of [
  ["catalog-json", catalogPath],
  ["source-paths-json", sourcePathsPath],
  ["fragment-paths-json", fragmentPathsPath],
  ["output-root", outputRoot],
] as const) {
  if (!path.isAbsolute(inputPath)) {
    throw new Error(`${label}: expected an absolute path`);
  }
}

function parseFileInputs<T>(inputPath: string, label: string): readonly T[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected an array`);
  }
  return value as readonly T[];
}

const tree = renderPromptSurfaceTree({
  surface,
  catalogJson: readFileSync(catalogPath, "utf8"),
  sourcePaths: parseFileInputs<PromptCatalogFileInput>(sourcePathsPath, "source-paths-json"),
  fragmentPaths: parseFileInputs<PromptFragmentFileInput>(
    fragmentPathsPath,
    "fragment-paths-json",
  ),
  roleVersions: DISPATCHED_ROLE_VERSIONS,
  ...(surface === "pi" ? { roleToolProfilesJson: serializePiRoleToolProfileManifest() } : {}),
});
const writtenPaths = new Set<string>();
for (const artifact of tree.artifacts) {
  if (
    path.posix.isAbsolute(artifact.path) ||
    artifact.path.split("/").includes("..") ||
    writtenPaths.has(artifact.path)
  ) {
    throw new Error(`artifact path is not a unique safe relative path: "${artifact.path}"`);
  }
  writtenPaths.add(artifact.path);
  const destination = path.join(outputRoot, artifact.path);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, artifact.content, "utf8");
}
