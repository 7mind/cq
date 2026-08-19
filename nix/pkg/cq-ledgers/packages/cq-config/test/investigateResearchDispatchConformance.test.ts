/**
 * T714 / G94 — investigate/research dispatch edges use the surface-owned
 * ref-first lifecycle. Independent of T696/T715. The shared subagent-dispatch
 * fragment already carries prepare/handle/fetch; this file pins the T721 subset.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  investigateResearchDispatchEdges,
  recursionEdges,
} from "@cq/config";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const COMMANDS_ROOT = path.join(ASSETS_ROOT, "commands", "cq");
const SURFACES = ["claude", "codex", "pi"] as const;
const DISPATCH_COMMANDS = ["investigate/advance.md", "research/advance.md"] as const;
const FORBIDDEN = [
  'task: "<complete prompt>"',
  "validate_input",
  "validate_output",
  "prompt-catalog fetch (",
] as const;

function fragment(surface: (typeof SURFACES)[number]): string {
  return readFileSync(path.join(ASSETS_ROOT, "fragments", surface, "subagent-dispatch.md"), "utf8");
}

function commandBody(rel: string): string {
  return readFileSync(path.join(COMMANDS_ROOT, rel), "utf8");
}

describe("T714: investigate/research dispatch edges are ref-first on every surface", () => {
  test("the T721 investigate/research subset is the four catalog dispatch edges", () => {
    expect(investigateResearchDispatchEdges().map((edge) => edge.id).sort()).toEqual([
      "investigate/advance::dispatch::investigate-explorer",
      "investigate/advance::dispatch::investigate-prober",
      "research/advance::dispatch::research-experimenter",
      "research/advance::dispatch::research-explorer",
    ]);
  });

  for (const surface of SURFACES) {
    for (const rel of DISPATCH_COMMANDS) {
      test(`${surface} ${rel} composes prepare/handle/fetch and has no legacy parent request`, () => {
        const source = commandBody(rel);
        expect(source).toContain("{{cq:fragment:subagent-dispatch}}");
        for (const token of FORBIDDEN) {
          expect(source).not.toContain(token);
        }
        const body = `${source}\n${fragment(surface)}`;
        expect(body).toContain("prepare_dispatch");
        expect(body).toContain("fetch_dispatch_result");
        expect(body).not.toMatch(/task: "<complete prompt>"/);
      });
    }
  }

  test("every investigate/research dispatch target is named by its source command", () => {
    for (const edge of investigateResearchDispatchEdges()) {
      expect(commandBody(`${edge.sourceRoleId}.md`)).toContain(edge.roleId);
    }
  });

  test("Pi command recursion from investigate/research sources matches the inventory", () => {
    const expected = recursionEdges()
      .filter(
        (edge) =>
          edge.sourceRoleId === "investigate" ||
          edge.sourceRoleId === "research" ||
          edge.sourceRoleId === "investigate/advance" ||
          edge.sourceRoleId === "research/advance",
      )
      .map((edge) => `${edge.sourceRoleId}->${edge.roleId}`)
      .sort();
    expect(expected).toEqual([
      "investigate->investigate/advance",
      "research->research/advance",
    ]);
    for (const rel of ["investigate.md", "research.md"] as const) {
      const source = commandBody(rel);
      expect(source).toContain("{{cq:fragment:inline-command-recursion}}");
      expect(source).toMatch(/CQ::(?:investigate|research)\/advance/);
    }
  });
});
