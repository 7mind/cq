/**
 * Regression test for D3: asserts that every file referenced by
 * packages/ledger/package.json (main, types, and all exports entries)
 * actually exists on disk after a tsc build.
 *
 * This test would FAIL against the pre-fix package.json that referenced
 * ./dist/index.js etc. (flat layout) once tsc writes to ./dist/src/* (nested
 * layout).
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const PKG_DIR = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(PKG_DIR, "../..");
const TSC_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsc");

beforeAll(
  () => {
    const result = spawnSync(TSC_BIN, ["-b"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0) {
      throw new Error(
        `tsc -b failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`,
      );
    }
  },
  // tsc can take up to 60 s on a cold build
  60_000,
);

describe("@cq/ledger package.json export targets", () => {
  it("all referenced files exist on disk after build", async () => {
    const raw = await readFile(path.join(PKG_DIR, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      main?: string;
      types?: string;
      exports?: Record<
        string,
        { import?: string; types?: string } | string
      >;
    };

    const targets: string[] = [];

    if (pkg.main) targets.push(pkg.main);
    if (pkg.types) targets.push(pkg.types);

    if (pkg.exports) {
      for (const entry of Object.values(pkg.exports)) {
        if (typeof entry === "string") {
          targets.push(entry);
        } else {
          if (entry.import) targets.push(entry.import);
          if (entry.types) targets.push(entry.types);
        }
      }
    }

    expect(targets.length).toBeGreaterThan(0);

    for (const rel of targets) {
      const abs = path.join(PKG_DIR, rel);
      expect(
        existsSync(abs),
        `Missing declared export target: ${rel} (resolved: ${abs})`,
      ).toBe(true);
    }
  });
});
