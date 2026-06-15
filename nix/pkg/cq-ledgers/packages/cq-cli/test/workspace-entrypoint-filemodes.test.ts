// D72 recurrence guard: asserts the three workspace entrypoints are tracked
// as 100755 (executable) in the git index.
//
// Uses `git ls-files -s` against the COMMITTED index — NOT on-disk stat —
// because D72 was a committed-mode defect (serve.ts lost +x in the index).
// Reverting any of these files to 100644 in the index will make this test fail.

import { describe, it, expect } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Resolve repo root from this test file's location:
// test/ -> cq-cli/ -> packages/ -> cq-ledgers/ -> pkg/ -> nix/ -> repo root
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../../..");

// The three workspace-package entrypoints that must be executable.
// Paths are relative to the repo root (as git tracks them).
const ENTRYPOINTS = [
  "nix/pkg/cq-ledgers/packages/ledger-mcp/src/main.ts",
  "nix/pkg/cq-ledgers/packages/ledger-web/src/serve.ts",
  "nix/pkg/cq-ledgers/packages/cq-cli/src/main.ts",
];

const EXPECTED_MODE = "100755";

describe("D72 recurrence guard: workspace entrypoints are tracked 100755", () => {
  it("all three entrypoints have mode 100755 in the git index", async () => {
    // `git ls-files -s` output format per entry:
    //   <mode> <sha> <stage>\t<path>
    // We pass all three paths in a single invocation for efficiency.
    const { stdout } = await exec("git", ["ls-files", "-s", "--", ...ENTRYPOINTS], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);

    // Build a map of path -> mode from the output.
    const modeByPath = new Map<string, string>();
    for (const line of lines) {
      // Line: "100755 <sha> <stage>\t<path>"
      const tabIdx = line.indexOf("\t");
      if (tabIdx === -1) continue;
      const fields = line.slice(0, tabIdx).trim().split(/\s+/);
      const mode = fields[0];
      const filePath = line.slice(tabIdx + 1);
      if (mode !== undefined && filePath !== undefined) {
        modeByPath.set(filePath, mode);
      }
    }

    for (const entrypoint of ENTRYPOINTS) {
      const actualMode = modeByPath.get(entrypoint);
      // If the file is absent from the index entirely, treat it as a failure.
      expect(
        actualMode,
        `${entrypoint}: not found in git index (expected mode ${EXPECTED_MODE})`,
      ).toBeDefined();
      expect(
        actualMode,
        `${entrypoint}: git index mode is ${actualMode}, expected ${EXPECTED_MODE}`,
      ).toBe(EXPECTED_MODE);
    }
  });
});
