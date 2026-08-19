/**
 * T698 / G94 — close the generated dispatch graph after T696/T714/T715/T697.
 * One inventory-wide check so a new edge cannot slip past a family pin.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  DISPATCH_EDGE_INVENTORY,
  buildDispatchEdgeInventory,
  implementDispatchEdges,
  inspectionSites,
  investigateResearchDispatchEdges,
  planReviewDispatchEdges,
  recursionEdges,
} from "@cq/config";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const COMMANDS_ROOT = path.join(ASSETS_ROOT, "commands", "cq");
const SURFACES = ["claude", "codex", "pi"] as const;

const CLOSED_DISPATCH = [
  "plan::dispatch::plan-advance",
  "plan/advance::dispatch::plan-advance",
  "plan/advance::dispatch::plan-reviewer",
  "plan/follow-up::dispatch::plan-advance",
  "investigate/advance::dispatch::investigate-explorer",
  "investigate/advance::dispatch::investigate-prober",
  "research/advance::dispatch::research-explorer",
  "research/advance::dispatch::research-experimenter",
  "implement/advance::dispatch::implement-worker",
  "implement/advance::dispatch::implement-reviewer",
  "implement/advance::dispatch::implement-conflict-resolver",
] as const;

const FORBIDDEN = [
  'task: "<complete prompt>"',
  "validate_input",
  "validate_output",
  "prompt-catalog fetch (",
  "held freeform",
  "structured JSON result block as final reply content",
] as const;

function commandBody(roleId: string): string {
  return readFileSync(path.join(COMMANDS_ROOT, `${roleId}.md`), "utf8");
}

function fragment(surface: (typeof SURFACES)[number], name: string): string {
  return readFileSync(path.join(ASSETS_ROOT, "fragments", surface, name), "utf8");
}

function composed(surface: (typeof SURFACES)[number], sourceRoleId: string): string {
  const extra =
    sourceRoleId === "implement/advance" || sourceRoleId.startsWith("implement/")
      ? `\n${fragment(surface, "implement-dispatch-workflow.md")}`
      : "";
  return `${commandBody(sourceRoleId)}\n${fragment(surface, "subagent-dispatch.md")}${extra}`;
}

describe("T698: generated dispatch graph is closed on every surface", () => {
  test("T721 dispatch edges are exactly the closed set", () => {
    const ids = DISPATCH_EDGE_INVENTORY.edges
      .filter((edge) => edge.kind === "dispatch")
      .map((edge) => edge.id)
      .sort();
    expect(ids).toEqual([...CLOSED_DISPATCH].sort());
    const family = [
      ...planReviewDispatchEdges(),
      ...investigateResearchDispatchEdges(),
      ...implementDispatchEdges(),
    ].map((edge) => edge.id);
    expect(family.sort()).toEqual(ids);
  });

  test("inventory generation is byte-identical across two runs", () => {
    expect(JSON.stringify(buildDispatchEdgeInventory())).toBe(
      JSON.stringify(buildDispatchEdgeInventory()),
    );
  });

  for (const surface of SURFACES) {
    test(`${surface} every dispatched edge is prepare/handle/fetch with no legacy production call`, () => {
      for (const edge of DISPATCH_EDGE_INVENTORY.edges.filter((item) => item.kind === "dispatch")) {
        const body = composed(surface, edge.sourceRoleId);
        expect(body).toContain(edge.roleId);
        expect(body).toContain("prepare_dispatch");
        expect(body).toContain("fetch_dispatch_result");
        expect(body).toContain("CQ_SUBAGENT");
        expect(body).toMatch(/confirm/i);
        for (const token of FORBIDDEN) {
          expect(body).not.toContain(token);
        }
      }
    });
  }

  test("Pi command recursion is only the inventory allowlist", () => {
    const recursion = recursionEdges();
    expect(recursion.every((edge) => edge.piInline && edge.mechanism === "inline-command-recursion")).toBe(
      true,
    );
    expect(recursion.map((edge) => edge.id).sort()).toEqual(
      [
        "begin::recursion::plan",
        "begin::recursion::plan/follow-up",
        "begin::recursion::investigate",
        "begin::recursion::research",
        "begin::recursion::advance",
        "advance::recursion::investigate/advance",
        "advance::recursion::plan/advance",
        "advance::recursion::research/advance",
        "advance::recursion::implement/advance",
        "plan::recursion::investigate/advance",
        "plan/advance::recursion::investigate/advance",
        "plan/follow-up::recursion::investigate/advance",
        "investigate::recursion::investigate/advance",
        "research::recursion::research/advance",
        "implement/start::recursion::implement/advance",
      ].sort(),
    );
  });

  test("remaining fetch_prompt and store_result sites stay classified and non-production", () => {
    expect(inspectionSites().every((site) => site.kind === "fetch_prompt")).toBe(true);
    expect(
      DISPATCH_EDGE_INVENTORY.sites.some(
        (site) => site.kind === "validate_output" || site.kind === "validate_input",
      ),
    ).toBe(false);
    expect(
      DISPATCH_EDGE_INVENTORY.sites
        .filter((site) => site.kind === "store_result")
        .every((site) => site.classification === "capability-scoped-store"),
    ).toBe(true);
  });
});
