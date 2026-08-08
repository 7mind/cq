/**
 * T1952 — workset projections delegate to G139 projectItemDto.
 *
 * Byte equality for compact/complement/full and compact∪complement = full.
 */

import { describe, expect, it } from "bun:test";
import {
  buildWorksetActiveState,
  closeWorkset,
  projectCompactItemDto,
  projectComplementItemDto,
  projectFullItemDto,
  projectItemDto,
  projectWorkset,
  serializeWireDto,
  type Item,
  type WorksetActiveState,
} from "../src/index.js";

const NOW = "2026-08-08T12:00:00.000Z";

function makeItem(id: string, fields: Item["fields"]): Item {
  return {
    id,
    milestoneId: "M1",
    status: "wip",
    fields,
    createdAt: NOW,
    updatedAt: NOW,
    author: "test",
    session: "sess-1",
  };
}

function oneTaskState(): { state: WorksetActiveState; item: Item } {
  const item = makeItem("T1", {
    headline: "Project me",
    description: "Narrative body",
    acceptance: "Done when green",
    severity: "major",
    dependsOn: ["tasks:T2"],
    blockedBy: ["questions:Q1"],
    ledgerRefs: ["goals:G1"],
    tags: ["workset"],
    customField: "outside-compact",
  });
  const state = buildWorksetActiveState([{ ledger: "tasks", items: [item] }]);
  return { state, item };
}

describe("workset-projection — id", () => {
  it("emits refs only", () => {
    const { state } = oneTaskState();
    const graph = closeWorkset(["tasks:T1"], state);
    const projected = projectWorkset(graph, "id");
    expect(projected.projection).toBe("id");
    expect(projected.nodes).toEqual([{ ref: "tasks:T1" }]);
    expect(projected.nodes[0]).not.toHaveProperty("item");
  });
});

describe("workset-projection — G139 byte equality", () => {
  for (const projection of ["compact", "full", "complement"] as const) {
    it(`delegates ${projection} to projectItemDto byte-for-byte`, () => {
      const { state, item } = oneTaskState();
      const graph = closeWorkset(["tasks:T1"], state);
      const projected = projectWorkset(graph, projection);
      const node = projected.nodes[0];
      expect(node).toBeDefined();
      if (node === undefined || !("item" in node)) {
        throw new Error("expected item projection");
      }
      const viaWorkset = serializeWireDto(node.item as never);
      const viaG139 = serializeWireDto(projectItemDto(item, projection));
      expect(viaWorkset).toBe(viaG139);
    });
  }

  it("compact ∪ complement reconstructs full fields (merge invariant)", () => {
    const { state, item } = oneTaskState();
    const graph = closeWorkset(["tasks:T1"], state);
    const compactNode = projectWorkset(graph, "compact").nodes[0];
    const complementNode = projectWorkset(graph, "complement").nodes[0];
    const fullNode = projectWorkset(graph, "full").nodes[0];
    if (
      compactNode === undefined ||
      complementNode === undefined ||
      fullNode === undefined ||
      !("item" in compactNode) ||
      !("item" in complementNode) ||
      !("item" in fullNode)
    ) {
      throw new Error("expected projected items");
    }

    const compact = compactNode.item as ReturnType<typeof projectCompactItemDto>;
    const complement = complementNode.item as ReturnType<typeof projectComplementItemDto>;
    const full = fullNode.item as ReturnType<typeof projectFullItemDto>;

    // Field-key merge invariant from G139.
    const compactKeys = new Set(Object.keys(compact.fields));
    const complementKeys = new Set(Object.keys(complement.fields));
    for (const k of compactKeys) {
      expect(complementKeys.has(k)).toBe(false);
    }
    const merged = { ...compact.fields, ...complement.fields };
    expect(merged).toEqual(full.fields);

    // Direct G139 projectors agree with workset-projected DTOs.
    expect(serializeWireDto(compact)).toBe(serializeWireDto(projectCompactItemDto(item)));
    expect(serializeWireDto(complement)).toBe(
      serializeWireDto(projectComplementItemDto(item)),
    );
    expect(serializeWireDto(full)).toBe(serializeWireDto(projectFullItemDto(item)));
  });
});
