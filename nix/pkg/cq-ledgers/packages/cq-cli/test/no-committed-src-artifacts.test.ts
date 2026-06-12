// D68 recurrence guard: asserts NO compiled artifacts (.js, .d.ts, .d.ts.map)
// exist under any packages/<pkg>/src/ directory (excluding dist/ and node_modules).
//
// Reproduces the root cause confirmed by H48: cqTomlTemplate.{js,d.ts,d.ts.map}
// were misplaced dist-style artifacts committed under cq-cli/src/. This test
// prevents them (or any similar file) from being re-committed.

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";

// Resolve the packages root from this test file's location:
// test/ -> cq-cli/ -> packages/
const PACKAGES_ROOT = path.resolve(import.meta.dir, "../../");

const ARTIFACT_EXTENSIONS = [".js", ".d.ts", ".d.ts.map"];

/** Returns all files under `dir` that match `predicate`, skipping `skipDirs`. */
function findFiles(
  dir: string,
  predicate: (filePath: string) => boolean,
  skipDirs: Set<string>,
): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        results.push(...findFiles(fullPath, predicate, skipDirs));
      }
    } else if (entry.isFile() && predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function hasArtifactExtension(filePath: string): boolean {
  const name = path.basename(filePath);
  return ARTIFACT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

describe("D68 recurrence guard: no compiled artifacts under packages/*/src/", () => {
  it("no .js, .d.ts, or .d.ts.map file exists under any package src/ directory", () => {
    const skipDirs = new Set(["dist", "node_modules"]);

    // Enumerate top-level package directories
    const packageDirs = fs
      .readdirSync(PACKAGES_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(PACKAGES_ROOT, e.name));

    const artifacts: string[] = [];
    for (const pkgDir of packageDirs) {
      const srcDir = path.join(pkgDir, "src");
      if (fs.existsSync(srcDir)) {
        artifacts.push(...findFiles(srcDir, hasArtifactExtension, skipDirs));
      }
    }

    if (artifacts.length > 0) {
      // Surface the offending files in the failure message for easy diagnosis.
      const relative = artifacts.map((f) =>
        path.relative(PACKAGES_ROOT, f),
      );
      expect(relative).toEqual([]);
    }
  });
});
