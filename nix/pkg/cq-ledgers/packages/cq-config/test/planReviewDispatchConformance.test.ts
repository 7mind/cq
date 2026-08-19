/**
 * T696 / G94 — plan/review dispatch edges use the surface-owned ref-first
 * prepare/store/confirm/fetch lifecycle. Independent of T714/T715.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  planReviewDispatchEdges,
  recursionEdges,
} from "@cq/config";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const COMMANDS_ROOT = path.join(ASSETS_ROOT, "commands", "cq");
const SURFACES = ["claude", "codex", "pi"] as const;

const PLAN_REVIEW_COMMANDS = ["plan.md", "plan/advance.md", "plan/follow-up.md"] as const;

const FORBIDDEN = [
  "complete prompt",
  "validate_input",
  "validate_output",
  "prompt-catalog fetch (",
  "promptTemplate",
] as const;

function fragment(surface: (typeof SURFACES)[number]): string {
  return readFileSync(path.join(ASSETS_ROOT, "fragments", surface, "subagent-dispatch.md"), "utf8");
}

function commandBody(rel: string): string {
  return readFileSync(path.join(COMMANDS_ROOT, rel), "utf8");
}

function composed(rel: string, surface: (typeof SURFACES)[number]): string {
  return `${commandBody(rel)}\n${fragment(surface)}`;
}

describe("T696: plan/review dispatch edges are ref-first on every surface", () => {
  test("the T721 plan/review subset is the four catalog dispatch edges", () => {
    expect(planReviewDispatchEdges().map((edge) => edge.id).sort()).toEqual([
      "plan/advance::dispatch::plan-advance",
      "plan/advance::dispatch::plan-reviewer",
      "plan/follow-up::dispatch::plan-advance",
      "plan::dispatch::plan-advance",
    ]);
  });

  for (const surface of SURFACES) {
    test(`${surface} subagent-dispatch names prepare_dispatch, handle-only launch, and fetch_dispatch_result`, () => {
      const body = fragment(surface);
      expect(body).toContain("prepare_dispatch");
      expect(body).toContain("fetch_dispatch_result");
      expect(body).toContain("CQ_SUBAGENT");
      expect(body).not.toMatch(/task: "<complete prompt>"/);
      expect(body).not.toContain("validate_input");
      expect(body).not.toContain("validate_output");
    });

    for (const rel of PLAN_REVIEW_COMMANDS) {
      test(`${surface} ${rel} has no parent materialization and keeps the fragment hook`, () => {
        const source = commandBody(rel);
        expect(source).toContain("{{cq:fragment:subagent-dispatch}}");
        for (const token of FORBIDDEN) {
          expect(source).not.toContain(token);
        }
        const body = composed(rel, surface);
        expect(body).toContain("prepare_dispatch");
        expect(body).toContain("fetch_dispatch_result");
      });
    }
  }

  test("every plan/review dispatch target is named by its source command", () => {
    for (const edge of planReviewDispatchEdges()) {
      const rel = `${edge.sourceRoleId}.md`;
      expect(commandBody(rel)).toContain(edge.roleId);
    }
  });

  test("Pi command recursion from plan-family sources matches the inventory", () => {
    const expected = recursionEdges()
      .filter((edge) => edge.sourceRoleId === "plan" || edge.sourceRoleId.startsWith("plan/"))
      .map((edge) => edge.roleId)
      .sort();
    expect(expected).toEqual(["investigate/advance", "investigate/advance", "investigate/advance"]);
    for (const rel of PLAN_REVIEW_COMMANDS) {
      const body = `${commandBody(rel)}\n${readFileSync(
        path.join(ASSETS_ROOT, "fragments", "pi", "inline-command-recursion.md"),
        "utf8",
      )}`;
      expect(body).toContain("{{cq:fragment:inline-command-recursion}}");
      expect(body).toContain('fetch_prompt("<path>")');
      expect(commandBody(rel)).toContain("investigate/advance");
    }
  });
});
