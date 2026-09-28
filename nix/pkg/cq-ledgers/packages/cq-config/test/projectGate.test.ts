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
import { parseConfig } from "../src/config.js";
import {
  CANONICAL_PROJECT_GATE,
  GATE_COUNT_PATTERN_FLAGS,
  PROJECT_GATE_ROOT_CWD,
  projectGateAuthorizationForm,
  requireProjectGate,
  resolveProjectGate,
} from "../src/projectGate.js";

const PACKAGES_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/** The main worktree of this checkout: a linked worktree's `.git` file names a gitdir whose `commondir` is the shared `.git`. */
function mainWorktreeRoot(): string {
  const checkoutRoot = path.resolve(PACKAGES_ROOT, "..", "..", "..", "..");
  const dotGit = path.join(checkoutRoot, ".git");
  if (statSync(dotGit).isDirectory()) return checkoutRoot;
  const gitDir = /^gitdir: (.+)$/mu.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
  if (gitDir === undefined) throw new Error(`${dotGit} names no gitdir`);
  const commonDir = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
  return path.dirname(commonDir);
}

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
    const form = projectGateAuthorizationForm(CANONICAL_PROJECT_GATE);
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
    const consumer = requireProjectGate(resolveProjectGate({ argv: ["npm", "test"], cwd: "", passCountPattern: null, failCountPattern: null }));
    expect(consumer.argv).toEqual(["npm", "test"]);
    // Canonicalized: the supervised runner refuses an empty cwd, so the
    // worktree root is spelled `"."` and a root-level gate is runnable.
    expect(consumer.cwd).toBe(PROJECT_GATE_ROOT_CWD);
    expect(consumer.cwd).not.toBe(CANONICAL_PROJECT_GATE.cwd);
    // It flows through to the authorization form the cohort checks digest.
    expect(projectGateAuthorizationForm(consumer)).toEqual({
      argv: ["npm", "test"],
      cwd: ".",
      environment: [],
    });
  });

  test("this repository declares its own gate rather than leaning on the fallback", () => {
    // D595: cq.toml is untracked local configuration, so a managed worktree
    // never has one. CQ resolves the gate from the checkout that owns the
    // configuration, the main worktree, so read it from there.
    const toml = readFileSync(path.join(mainWorktreeRoot(), "cq.toml"), "utf8");
    expect(toml).toContain("[gate]");
    // The configured path is the exercised one, so the fallback is not the
    // thing under test in this repository's own runs.
    expect(toml).toContain('cwd  = "nix/pkg/cq-ledgers"');
  });

  // D573: an undeclared gate is a named refusal, never CQ's own gate.
  test("a project that declares no gate resolves to none and refuses by name", () => {
    expect(resolveProjectGate(null)).toBeNull();
    expect(resolveProjectGate(undefined)).toBeNull();
    expect(() => requireProjectGate(null)).toThrow("declare [gate] in cq.toml");
    expect(requireProjectGate(CANONICAL_PROJECT_GATE)).toBe(CANONICAL_PROJECT_GATE);
  });
});

// D568: the "tests really ran" rule is project-declared, validated at load.
describe("D568 [gate] count patterns", () => {
  const gateOf = (body: string) => parseConfig(`[gate]\n  argv = ["pytest"]\n${body}`).gate;

  test("parses declared count patterns and leaves undeclared ones null", () => {
    expect(gateOf(`  passCountPattern = '([0-9]+) passed'\n`)).toEqual({
      argv: ["pytest"], cwd: "", passCountPattern: "([0-9]+) passed", failCountPattern: null,
    });
  });

  test("rejects a pattern without a count group and an invalid regex", () => {
    expect(() => gateOf(`  passCountPattern = 'passed'\n`)).toThrow("must capture the count in its first group");
    expect(() => gateOf(`  failCountPattern = '([0-9]+'\n`)).toThrow("is not a valid regular expression");
  });

  test("CQ's own patterns read Bun's summary lines", () => {
    const pass = new RegExp(CANONICAL_PROJECT_GATE.passCountPattern!, GATE_COUNT_PATTERN_FLAGS);
    expect([..." 42 pass\n 0 fail\n".matchAll(pass)].map((match) => match[1])).toEqual(["42"]);
  });
});
