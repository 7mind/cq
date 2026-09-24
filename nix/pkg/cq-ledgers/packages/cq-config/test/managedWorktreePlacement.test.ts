/**
 * defects:D404 — one definition of CQ-managed worktree placement.
 *
 * The managed-worktree parent and its registry root were spelled out
 * independently at eight production sites across three packages. Six of those
 * were the same `join(root, ".claude", "worktrees", ".cq-managed-registry")`
 * expression reached by callers that never see each other, so the location of
 * live recovery seals and task bindings depended on six copies agreeing.
 *
 * This suite pins the single definition and the absence of a ninth copy. It is
 * the prerequisite for moving the placement off an external harness's
 * namespace: a cutover is only safe once there is one thing to cut over.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CQ_MANAGED_WORKTREES_SEGMENTS,
  HARNESS_NATIVE_WORKTREES_SEGMENTS,
  MANAGED_REGISTRY_DIRNAME,
  cqManagedWorktreesParent,
  managedWorktreeRegistryRoot,
} from "../src/managedWorktreePlacement.js";

const PACKAGES_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const REPO = "/repo";

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

describe("D404 managed worktree placement", () => {
  test("derives the parent and the registry root from one definition", () => {
    expect(cqManagedWorktreesParent(REPO)).toBe(
      path.join(REPO, ...CQ_MANAGED_WORKTREES_SEGMENTS),
    );
    expect(managedWorktreeRegistryRoot(REPO)).toBe(
      path.join(cqManagedWorktreesParent(REPO), MANAGED_REGISTRY_DIRNAME),
    );
  });

  test("an explicit stateDir overrides the derived root verbatim", () => {
    // Every caller that accepts a stateDir threads a host or test override
    // through this one function; it must not be re-derived or normalized.
    expect(managedWorktreeRegistryRoot(REPO, "/elsewhere/state")).toBe("/elsewhere/state");
    expect(managedWorktreeRegistryRoot(REPO, "")).toBe("");
  });

  test("keeps harness-native isolation a separate name from CQ placement", () => {
    // They hold the same value today. The point is that they are two DECISIONS:
    // the cutover moves CQ placement while native confinement and the D170
    // store-safety guard must keep recognizing Claude's own namespace.
    expect([...HARNESS_NATIVE_WORKTREES_SEGMENTS]).toEqual([".claude", "worktrees"]);
    expect([...CQ_MANAGED_WORKTREES_SEGMENTS]).toEqual([...HARNESS_NATIVE_WORKTREES_SEGMENTS]);
  });

  test("no production source names the registry directory a second time", () => {
    // Six independent copies of this join decided where live recovery seals and
    // per-task bindings are read from. A seventh must fail rather than drift.
    //
    // Matched WITHOUT surrounding quotes on purpose: a first attempt looked for
    // the quoted constant and a mutant that inlined the same path in a template
    // literal walked straight through it.
    const offenders = productionSources().filter(
      (file) =>
        readFileSync(file, "utf8").includes(MANAGED_REGISTRY_DIRNAME) &&
        path.basename(file) !== "managedWorktreePlacement.ts",
    );
    expect(offenders.map((file) => path.relative(PACKAGES_ROOT, file))).toEqual([]);
  });

  test("no production source outside the recognizers derives the managed parent", () => {
    // The parent is the other half: a call site that rebuilds
    // `<root>/.claude/worktrees` itself would silently keep the old placement
    // through a cutover. The files listed here RECOGNIZE a harness-native path
    // rather than choosing CQ's, which is the distinction this module exists to
    // keep — each is named so that adding a seventh is a deliberate act.
    const recognizers = new Set([
      "managedWorktreePlacement.ts",
      // D170 store safety: refuses to open a ledger inside an agent worktree.
      "projectKey.ts",
      // Native-dispatch confinement: recognizes a managed cwd.
      "nativeDispatchQualification.ts",
      // Handle integrity: validates a STORED absolutePath, including legacy.
      "managedWorktreeHandle.ts",
      // Prompt/schema prose describing Claude's own preferred placement.
      "claudeDispatchProtocol.ts",
      "implement-worker.ts",
      "worktreeManageTools.ts",
    ]);
    // Both spellings: the path form `.claude/worktrees` AND the argument form
    // `join(root, ".claude", "worktrees")`. A first attempt matched only the
    // path form, and a mutant that rebuilt the parent from segments survived it.
    const [first, second] = CQ_MANAGED_WORKTREES_SEGMENTS;
    const parentSpelling = new RegExp(
      `${first!.replace(".", "\\.")}["']?\\s*[,/]\\s*["']?${second!}`,
    );
    const offenders = productionSources().filter(
      (file) =>
        parentSpelling.test(readFileSync(file, "utf8")) && !recognizers.has(path.basename(file)),
    );
    expect(offenders.map((file) => path.relative(PACKAGES_ROOT, file))).toEqual([]);
  });
});
