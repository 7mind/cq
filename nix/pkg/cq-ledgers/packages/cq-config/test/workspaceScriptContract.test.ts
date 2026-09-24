import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const WORKSPACE_PACKAGE_JSON = path.join(REPO_ROOT, "nix", "pkg", "cq-ledgers", "package.json");

interface WorkspacePackage {
  readonly scripts: {
    readonly check: string;
    readonly "check:codex-installed-gate": string;
    readonly "check:flake-enumeration": string;
    readonly "check:pi-extensions": string;
    readonly lint: string;
  };
}

const workspacePackage = JSON.parse(
  readFileSync(WORKSPACE_PACKAGE_JSON, "utf8"),
) as WorkspacePackage;

// Behavioral-Active Blackbox-Atomic; regression: D373 bounded gate diagnostics.
describe("workspace script contract", () => {
  test("lints the whole workspace", () => {
    expect(workspacePackage.scripts.lint).toBe("eslint .");
  });

  // regression: defects:D533 — `nix/pkg/pi-extensions` is a separate module
  // tree, so the workspace `bun test` never enumerated it and four suites
  // covering the Pi dispatch runtime were invisible to the gate for months.
  test("runs the sibling pi-extensions suite", () => {
    expect(workspacePackage.scripts["check:pi-extensions"]).toBe(
      "cd ../pi-extensions && bun test",
    );
    expect(workspacePackage.scripts.check).toContain("bun run check:pi-extensions");
  });

  test("the sibling tree it runs actually holds tests", () => {
    // Non-vacuity: a script pointing at an empty directory would satisfy the
    // assertion above while restoring exactly the gap D533 is about.
    const root = path.join(REPO_ROOT, "nix", "pkg", "pi-extensions");
    const suites = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      (entry) => entry.endsWith(".test.ts") && !entry.includes("node_modules"),
    );
    expect(suites.length).toBeGreaterThan(3);
  });

  test("composes the aggregate check from named scripts", () => {
    expect(workspacePackage.scripts.check).toBe(
      'tsc -b && bun run lint && bun test --only-failures --reporter=junit --reporter-outfile="${CQ_TEST_JUNIT_PATH:-/dev/null}" && bun run check:pi-extensions && bun run check:codex-installed-gate && bun run check:flake-enumeration',
    );
    expect(workspacePackage.scripts["check:codex-installed-gate"]).toBe(
      'nix build --no-link "$(scripts/working-tree-flake-ref.sh)#cq"',
    );
    expect(workspacePackage.scripts["check:flake-enumeration"]).toBe(
      'nix flake show --all-systems --json "$(scripts/working-tree-flake-ref.sh)"',
    );
  });
});
