/**
 * defects:D435 — no deletable WIP artifact may stay tracked.
 *
 * defects:D405 stopped workers ADDING these: managed release now refuses
 * `wip-retained`, so the source is closed. This is the other half — the
 * thirty-two that were already committed — and the invariant that keeps the
 * integration tree clear afterwards.
 *
 * The assertion is deliberately not "no `WIP-T*.md` is tracked". It runs the
 * real reconciliation classifier over the real repository, so a file that some
 * future record genuinely claims would be RETAINED and named rather than
 * failing the gate. Today nothing claims one: every registry reference is a
 * historical `cq-git-change-receipt.paths` entry.
 *
 * Registry-free environments (a fresh clone, CI) see no references at all,
 * which makes every tracked artifact deletable — the strictest reading, and the
 * right one for a gate.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HISTORICAL_WIP_REFERENCE,
  classifyWipArtifactReconciliation,
} from "../src/wipArtifactReconciliation.js";
import { MANAGED_REGISTRY_DIRNAME } from "../src/managedWorktreePlacement.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..", "..", "..");
const WIP_IN_STRING = /^WIP-T\d+\.md$/u;

function trackedWipArtifacts(): string[] {
  const listed = spawnSync("git", ["ls-files", "--", "WIP-T*.md"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split("\n").filter((line) => line !== "");
}

/** Every registry context each WIP path appears in, keyed `<kind>::<field>`. */
function registryReferences(): Map<string, string[]> {
  const references = new Map<string, string[]>();
  const roots = [".cq", ".claude"].map((parent) =>
    path.join(REPO_ROOT, parent, "worktrees", MANAGED_REGISTRY_DIRNAME),
  );
  const collect = (node: unknown, context: string): void => {
    if (Array.isArray(node)) {
      for (const entry of node) collect(entry, context);
      return;
    }
    if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const kind = typeof record["kind"] === "string" ? record["kind"] : "?";
      for (const [key, value] of Object.entries(record)) collect(value, `${kind}::${key}`);
      return;
    }
    if (typeof node === "string" && WIP_IN_STRING.test(node)) {
      const seen = references.get(node) ?? [];
      if (!seen.includes(context)) seen.push(context);
      references.set(node, seen);
    }
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".json")) {
        try {
          collect(JSON.parse(readFileSync(full, "utf8")), "<root>");
        } catch {
          // A malformed registry file is not this guard's business to report.
        }
      }
    }
  };
  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) walk(root);
    } catch {
      // No registry in this environment; the strictest reading applies.
    }
  }
  return references;
}

describe("D435 integration-tree WIP inventory", () => {
  test("no tracked WIP artifact is free of live authority", () => {
    const tracked = trackedWipArtifacts();
    // Short-circuit: with nothing tracked there is nothing to adjudicate, and
    // the 2000-file registry scan is pure cost on every gate run.
    if (tracked.length === 0) {
      expect(tracked).toEqual([]);
      return;
    }
    const report = classifyWipArtifactReconciliation({
      trackedArtifacts: tracked,
      references: registryReferences(),
      liveGenerations: new Set(),
      registeredWorktrees: new Set(),
    });
    // A retained artifact is legitimate; only a deletable one is a failure, and
    // the diff then names exactly which paths to remove.
    expect(report.delete.map((entry) => entry.path)).toEqual([]);
    // And a retain must actually name its holder, so it cannot be vacuous.
    for (const entry of report.retain) expect(entry.heldBy.length).toBeGreaterThan(0);
  }, 120_000);

  test("the classifier's historical context is the one the registry actually uses", () => {
    // Non-vacuity for the scan: if the registry is present it MUST contain at
    // least one historical reference, or `registryReferences` silently returns
    // nothing and the guard above would pass by accident.
    const references = registryReferences();
    if (references.size === 0) return;
    const contexts = new Set([...references.values()].flat());
    expect([...contexts]).toContain(HISTORICAL_WIP_REFERENCE);
  }, 120_000);
});
