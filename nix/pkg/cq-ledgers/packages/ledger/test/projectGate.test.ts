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
});
