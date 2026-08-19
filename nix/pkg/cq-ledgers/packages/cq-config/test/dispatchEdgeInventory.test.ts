import { describe, expect, test } from "bun:test";
import {
  DISPATCH_EDGE_INVENTORY,
  RefFirstInventoryError,
  buildDispatchEdgeInventory,
  implementDispatchEdges,
  inspectionSites,
  investigateResearchDispatchEdges,
  planReviewDispatchEdges,
  recursionEdges,
  type CatalogInventoryRole,
} from "@cq/config";
import { PROMPT_CATALOG_PROJECTION } from "../src/promptCatalog.gen.js";

const EXPECTED_DISPATCH = [
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

const EXPECTED_RECURSION = [
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
] as const;

type MutableCatalogRole = {
  roleId: string;
  roleKind: CatalogInventoryRole["roleKind"];
  canonicalSource: string;
  dispatchRelations: Array<{ kind: "dispatch" | "recursion"; targetRoleId: string }>;
  sidecar: { schemaRoleId: string } | null;
};

function catalogRoles(): MutableCatalogRole[] {
  const cloned = structuredClone(PROMPT_CATALOG_PROJECTION.catalog) as unknown as MutableCatalogRole[];
  return cloned.map((role) => ({
    roleId: role.roleId,
    roleKind: role.roleKind,
    canonicalSource: role.canonicalSource,
    dispatchRelations: role.dispatchRelations.map((relation) => ({ ...relation })),
    sidecar: role.sidecar === null ? null : { schemaRoleId: role.sidecar.schemaRoleId },
  }));
}

describe("T721 ref-first dispatch edge inventory", () => {
  test("classifies every catalog edge exactly once", () => {
    const ids = DISPATCH_EDGE_INVENTORY.edges.map((edge) => edge.id).sort();
    expect(ids).toEqual([...EXPECTED_DISPATCH, ...EXPECTED_RECURSION].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("plan/review, investigate/research, and implement subsets are independently addressable", () => {
    expect(planReviewDispatchEdges().map((edge) => edge.roleId).sort()).toEqual([
      "plan-advance",
      "plan-advance",
      "plan-advance",
      "plan-reviewer",
    ].sort());
    expect(investigateResearchDispatchEdges().map((edge) => edge.roleId).sort()).toEqual([
      "investigate-explorer",
      "investigate-prober",
      "research-experimenter",
      "research-explorer",
    ]);
    expect(implementDispatchEdges().map((edge) => edge.roleId).sort()).toEqual([
      "implement-conflict-resolver",
      "implement-reviewer",
      "implement-worker",
    ]);
    expect(recursionEdges().every((edge) => edge.piInline && edge.mechanism === "inline-command-recursion")).toBe(
      true,
    );
  });

  test("dispatch edges carry typed sidecars, owned lifecycle, and handle-only visibility", () => {
    for (const edge of DISPATCH_EDGE_INVENTORY.edges.filter((item) => item.kind === "dispatch")) {
      expect(edge.inputSidecar).toBe(`schemas/${edge.roleId}.ts#inputSchema`);
      expect(edge.outputSidecar).toBe(`schemas/${edge.roleId}.ts#outputSchema`);
      expect(edge.lifecycle).toHaveLength(3);
      for (const surface of edge.lifecycle) {
        expect(surface.prepare).toBe("parent-prepare_dispatch");
        expect(surface.resultCapabilityOwner).toBe("child");
        expect(surface.nativeCompletionConfirmer).toBe("parent");
        expect(surface.aborter).toBe("parent");
        expect(surface.fetcher).toBe("parent-fetch_dispatch_result");
        expect(surface.handleVisibility).toBe("handle-only");
      }
    }
  });

  test("inspection fetch_prompt sites are classified and validate_output is absent", () => {
    expect(inspectionSites().length).toBeGreaterThan(0);
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

  test("generation is deterministic and changes when a catalog edge is added", () => {
    const first = JSON.stringify(buildDispatchEdgeInventory());
    const second = JSON.stringify(buildDispatchEdgeInventory());
    expect(first).toBe(second);
    const mutated = catalogRoles();
    const begin = mutated.find((role) => role.roleId === "begin");
    expect(begin).toBeDefined();
    begin!.dispatchRelations = [
      ...begin!.dispatchRelations,
      { kind: "recursion", targetRoleId: "reviewers" },
    ];
    const changed = JSON.stringify(buildDispatchEdgeInventory(mutated));
    expect(changed).not.toBe(first);
    expect(changed).toContain("begin::recursion::reviewers");
  });

  test("unknown, wrong-kind, duplicate, and sidecar-mismatch edges fail closed", () => {
    const unknown = catalogRoles();
    unknown[0]!.dispatchRelations = [{ kind: "dispatch", targetRoleId: "no-such-role" }];
    expect(() => buildDispatchEdgeInventory(unknown)).toThrow(RefFirstInventoryError);

    const wrongKind = catalogRoles();
    const plan = wrongKind.find((role) => role.roleId === "plan");
    plan!.dispatchRelations = [{ kind: "dispatch", targetRoleId: "advance" }];
    expect(() => buildDispatchEdgeInventory(wrongKind)).toThrow(/dispatch target "advance"/);

    const duplicate = catalogRoles();
    const implement = duplicate.find((role) => role.roleId === "implement/advance");
    implement!.dispatchRelations = [
      ...implement!.dispatchRelations,
      { kind: "dispatch", targetRoleId: "implement-worker" },
    ];
    expect(() => buildDispatchEdgeInventory(duplicate)).toThrow(/duplicate edge/);

    const sidecar = catalogRoles();
    const worker = sidecar.find((role) => role.roleId === "implement-worker");
    worker!.sidecar = { schemaRoleId: "wrong" };
    expect(() => buildDispatchEdgeInventory(sidecar)).toThrow(/sidecar mismatch/);
  });
});
