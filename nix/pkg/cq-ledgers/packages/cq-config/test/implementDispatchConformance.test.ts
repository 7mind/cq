/**
 * T715 / G94 — implement dispatch edges use the ref-first lifecycle, which
 * since G224 CQ drives on every surface (start_dispatch + waiting fetch). Independent of T696/T714. Claude/Codex already prepared; this
 * file pins the T721 implement subset after the Pi parent fragment cutover.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { implementDispatchEdges, recursionEdges } from "@cq/config";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const COMMANDS_ROOT = path.join(ASSETS_ROOT, "commands", "cq");
const SURFACES = ["claude", "codex", "pi"] as const;
const WORKFLOW = "implement-dispatch-workflow.md";
const NARRATIVE_COURIER =
  "{ taskId, headline, description, acceptance, worktreePath, branch, baseCommit, round, startingCommit, priorCriticism? }";
// G224: CQ resolves the worker's model from configuration, so refs carry no resolvedModel.
const WORKER_REFS =
  '{ roleId, surface, projectKey, taskId, coordinates, round, startingCommit, validationIntent: "final", priorReviewId?, guidance? }';
const FORBIDDEN = [
  'task: "<complete prompt>"',
  "validate_input",
  "validate_output",
  "prompt-catalog fetch (",
  "held freeform",
] as const;

function fragment(surface: (typeof SURFACES)[number]): string {
  return readFileSync(path.join(ASSETS_ROOT, "fragments", surface, WORKFLOW), "utf8");
}

function commandBody(rel: string): string {
  return readFileSync(path.join(COMMANDS_ROOT, rel), "utf8");
}

describe("T715: implement dispatch edges are ref-first on every surface", () => {
  test("the T721 implement subset is the four catalog dispatch edges", () => {
    expect(implementDispatchEdges().map((edge) => edge.id).sort()).toEqual([
      "implement/advance::dispatch::implement-conflict-resolver",
      "implement/advance::dispatch::implement-reviewer",
      "implement/advance::dispatch::implement-worker",
      "implement/advance::dispatch::implementation-auditor",
    ]);
  });

  for (const surface of SURFACES) {
    test(`${surface} implement-dispatch-workflow starts through CQ and fetches`, () => {
      const body = fragment(surface);
      expect(body).toContain("start_dispatch");
      expect(body).not.toContain("prepare_dispatch");
      expect(body).toContain("fetch_dispatch_result");
      expect(body).toContain("CQ_SUBAGENT");
      expect(body).toContain(WORKER_REFS);
      expect(body).not.toContain(NARRATIVE_COURIER);
      for (const token of FORBIDDEN) {
        expect(body).not.toContain(token);
      }
    });
  }

  test("implement/advance composes the workflow fragment and names every implement target", () => {
    const source = commandBody("implement/advance.md");
    expect(source).toContain("{{cq:fragment:subagent-dispatch}}");
    expect(source).toContain("{{cq:fragment:implement-dispatch-workflow}}");
    for (const edge of implementDispatchEdges()) {
      expect(source).toContain(edge.roleId);
    }
    for (const token of FORBIDDEN) {
      expect(source).not.toContain(token);
    }
  });

  test("Pi command recursion from implement sources matches the inventory", () => {
    const expected = recursionEdges()
      .filter(
        (edge) =>
          edge.sourceRoleId === "implement/start" || edge.sourceRoleId === "implement/advance",
      )
      .map((edge) => `${edge.sourceRoleId}->${edge.roleId}`)
      .sort();
    expect(expected).toEqual(["implement/start->implement/advance"]);
    const start = commandBody("implement/start.md");
    expect(start).toContain("{{cq:fragment:inline-command-recursion}}");
    expect(start).toContain("CQ::implement/advance");
  });
});
