#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..", "..", "..", "..");
const OUT_FILE = path.resolve(SCRIPT_DIR, "..", "src", "promptCatalog.gen.ts");

interface PromptCatalogProjection {
  readonly schemaVersion: number;
  readonly catalog: readonly unknown[];
  readonly catalogMetadataHash: string;
  readonly fragmentContracts: readonly unknown[];
}

function evaluateProjection(): PromptCatalogProjection {
  const result = Bun.spawnSync(
    ["nix", "eval", "--json", ".#llmAssets.promptCatalogProjection"],
    {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`prompt catalog Nix evaluation failed:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const value = JSON.parse(new TextDecoder().decode(result.stdout)) as PromptCatalogProjection;
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.catalog) ||
    typeof value.catalogMetadataHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.catalogMetadataHash) ||
    !Array.isArray(value.fragmentContracts)
  ) {
    throw new Error("prompt catalog Nix projection has an unsupported shape");
  }
  return value;
}

function emitModule(projection: PromptCatalogProjection): string {
  return `/**
 * GENERATED from nix/pkg/cq-assets/assets.nix — DO NOT EDIT.
 *
 * Regenerate with \`bun run gen-prompt-catalog\`. This compile-time mirror is
 * never an input to Nix prompt renderer derivations.
 */

export const PROMPT_CATALOG_PROJECTION = ${JSON.stringify(projection, null, 2)} as const;
`;
}

function main(): void {
  const projection = evaluateProjection();
  writeFileSync(OUT_FILE, emitModule(projection), "utf8");
  console.log(
    `gen-prompt-catalog: wrote ${path.relative(REPO_ROOT, OUT_FILE)} — ${projection.catalog.length} roles`,
  );
}

main();
