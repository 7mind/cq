import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "../src/promptRenderer.js";

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
