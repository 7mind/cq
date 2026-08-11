import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const WORKSPACE_PACKAGE_JSON = path.join(REPO_ROOT, "nix", "pkg", "cq-ledgers", "package.json");

interface WorkspacePackage {
  readonly scripts: {
    readonly check: string;
    readonly "check:codex-installed-gate": string;
    readonly "check:flake-enumeration": string;
    readonly lint: string;
  };
}

const workspacePackage = JSON.parse(
  readFileSync(WORKSPACE_PACKAGE_JSON, "utf8"),
) as WorkspacePackage;

// Behavioral-Active Blackbox-Atomic; specified by the documented workspace gate.
describe("workspace script contract", () => {
  test("lints the whole workspace", () => {
    expect(workspacePackage.scripts.lint).toBe("eslint .");
  });

  test("composes the aggregate check from named scripts", () => {
    expect(workspacePackage.scripts.check).toBe(
      "tsc -b && bun run lint && bun test && bun run check:codex-installed-gate && bun run check:flake-enumeration",
    );
    expect(workspacePackage.scripts["check:codex-installed-gate"]).toBe(
      "cd ../../.. && nix build --no-link .#cq",
    );
    expect(workspacePackage.scripts["check:flake-enumeration"]).toBe(
      "cd ../../.. && nix flake show --all-systems --json",
    );
  });
});
