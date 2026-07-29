import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { PROMPT_CATALOG_PROJECTION } from "../src/promptCatalog.gen.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");

const CONCRETE_LEDGER_ID = /\b(?:D|G|H|I|K|M|Q|R|RS|T)\d+(?:[-/][A-Za-z0-9]+)*\b/g;

const HARNESS_VOCABULARY = [
  /\bCodegraph\b/gi,
  /CLAUDE_CODE_SESSION_ID/g,
  /~\/\.(?:claude|codex|pi)\b/g,
  /\/cq:[a-z0-9/-]+/g,
  /\$cq-[a-z0-9-]+/g,
  /\bmcp__ledger__[a-z0-9_]+\b/g,
  /\bsubagent_type\b/g,
  /\brun_in_background\b/g,
  /\b(?:claude|codex|pi):[a-z0-9]/gi,
  /`(?:Agent|Task|Read|Grep|Glob|Bash|WebFetch|WebSearch)`/g,
] as const;

interface PromptSource {
  readonly roleId: string;
  readonly canonicalSource: string;
}

function promptSources(): readonly PromptSource[] {
  const fragmentsRoot = path.join(ASSETS_ROOT, "fragments");
  const fragments = readdirSync(fragmentsRoot, {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const absolutePath = path.join(entry.parentPath, entry.name);
      return {
        roleId: path.relative(ASSETS_ROOT, absolutePath),
        canonicalSource: path.relative(ASSETS_ROOT, absolutePath),
      };
    });
  return [...PROMPT_CATALOG_PROJECTION.catalog, ...fragments];
}

function violations(
  roles: readonly PromptSource[],
  patterns: readonly RegExp[],
): readonly string[] {
  return roles.flatMap((role) => {
    const source = readFileSync(path.join(ASSETS_ROOT, role.canonicalSource), "utf8");
    return patterns.flatMap((pattern) =>
      [...source.matchAll(pattern)].map(
        (match) => `${role.roleId}: ${JSON.stringify(match[0])}`,
      ),
    );
  });
}

test("canonical prompts contain no CQ-development provenance identifiers", () => {
  expect(
    violations(promptSources(), [CONCRETE_LEDGER_ID]),
  ).toEqual([]);
});

test("canonical prompts delegate harness mechanics to typed fragments", () => {
  expect(
    violations(PROMPT_CATALOG_PROJECTION.catalog, HARNESS_VOCABULARY),
  ).toEqual([]);
});
