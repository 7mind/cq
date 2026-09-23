/**
 * D403 / H310 — one definition of the project gate.
 *
 * The canonical full gate used to be written out at five production sites in
 * two packages. Two of them DIGEST it and compare, to authorize a cohort's
 * full gate, so the copies had to stay byte-identical or a legitimate gate
 * would have been refused. This suite pins the value and the uniqueness.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_PROJECT_GATE,
  projectGateAuthorizationForm,
  resolveProjectGate,
} from "../src/projectGate.js";

const PACKAGES_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function productionSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".gen.ts")) found.push(full);
    }
  };
  for (const pkg of readdirSync(PACKAGES_ROOT)) {
    const src = path.join(PACKAGES_ROOT, pkg, "src");
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // package without a src/ directory
    }
  }
  return found;
}

describe("D403 project gate definition", () => {
  test("keeps the exact value every previous literal spelled out", () => {
    // Byte-identical on purpose: changing it would change stored receipts,
    // cohort admission digests and supervised gate evidence.
    expect(CANONICAL_PROJECT_GATE.argv).toEqual(["bun", "run", "check"]);
    expect(CANONICAL_PROJECT_GATE.cwd).toBe("nix/pkg/cq-ledgers");
  });

  test("the authorization form preserves the digested shape and key order", () => {
    const form = projectGateAuthorizationForm();
    expect(form).toEqual({
      argv: ["bun", "run", "check"],
      cwd: "nix/pkg/cq-ledgers",
      environment: [],
    });
    // The cohort comparisons digest this object. `environment` is a LIST here
    // and a map in the supervised runner, which is why the shared definition
    // deliberately excludes it.
    expect(Object.keys(form)).toEqual(["argv", "cwd", "environment"]);
    expect(Array.isArray(form.environment)).toBe(true);
  });

  test("no production source spells the gate cwd out a second time", () => {
    const offenders = productionSources().filter(
      (file) =>
        readFileSync(file, "utf8").includes(`"${CANONICAL_PROJECT_GATE.cwd}"`) &&
        path.basename(file) !== "projectGate.ts",
    );
    // Five copies of a value that two authorization checks compare by digest
    // is the hazard this replaces; a sixth must fail rather than drift.
    expect(offenders.map((file) => path.relative(PACKAGES_ROOT, file))).toEqual([]);
  });

  test("a non-CQ project's declared gate replaces CQ's layout entirely", () => {
    // The consumer shape from GitHub issue #6: no `nix/pkg/cq-ledgers`, a
    // different runner, and the gate at the repository root.
    const consumer = resolveProjectGate({ argv: ["npm", "test"], cwd: "" });
    expect(consumer.argv).toEqual(["npm", "test"]);
    expect(consumer.cwd).toBe("");
    expect(consumer.cwd).not.toBe(CANONICAL_PROJECT_GATE.cwd);
    // It flows through to the authorization form the cohort checks digest.
    expect(projectGateAuthorizationForm(consumer)).toEqual({
      argv: ["npm", "test"],
      cwd: "",
      environment: [],
    });
  });

  test("an undeclared gate falls back, and the fallback is the COMPATIBILITY arm", () => {
    // Recorded as a deliberate compatibility decision, not a correct default:
    // a consumer that declares nothing still inherits CQ's layout, and the fix
    // for that is to declare `[gate]`.
    expect(resolveProjectGate(null)).toEqual(CANONICAL_PROJECT_GATE);
    expect(resolveProjectGate(undefined)).toEqual(CANONICAL_PROJECT_GATE);
  });

  test("this repository declares its own gate rather than leaning on the fallback", () => {
    const toml = readFileSync(path.resolve(PACKAGES_ROOT, "..", "..", "..", "..", "cq.toml"), "utf8");
    expect(toml).toContain("[gate]");
    // The configured path is the exercised one, so the fallback is not the
    // thing under test in this repository's own runs.
    expect(toml).toContain('cwd  = "nix/pkg/cq-ledgers"');
  });
});
