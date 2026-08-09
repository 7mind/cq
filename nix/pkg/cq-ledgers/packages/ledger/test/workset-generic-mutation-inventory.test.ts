/**
 * T1961 — exhaustive inventory of LedgerStore mutations and closure-forming
 * fields covered by the guarded generic-mutation gateway.
 *
 * Every ordinary graph/eligibility mutation has exactly one allow-or-deny
 * clause; sealed ownership and dependency fields are classified; raw write
 * method names match the LedgerStore surface the gateway seals.
 */

import { describe, expect, it } from "bun:test";
import {
  WORKSET_GENERIC_MUTATION_OPERATION_KINDS,
  WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES,
  WORKSET_GENERIC_MUTATION_FIELD_CLAUSES,
  WORKSET_GENERIC_MUTATION_CLOSURE_FIELDS,
  WORKSET_GENERIC_MUTATION_RAW_WRITE_METHODS,
  WORKSET_OWNER_REF_FIELD,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNED_FIELD_NAMES,
  DEPENDENCY_REF_FIELDS,
  clauseForGenericMutationOperation,
  clauseForGenericMutationField,
  inventoriedLedgerStoreMutationMethods,
  inventoriedSealedOwnershipFields,
} from "../src/index.js";

/** LedgerStore write methods that change graph or eligibility (not telemetry). */
const LEDGER_STORE_ORDINARY_MUTATIONS = [
  "updateMilestone",
  "updateItem",
  "createItem",
  "createMilestone",
  "createLedger",
  "reopenItem",
  "unarchiveItem",
  "archiveMilestone",
] as const;

describe("workset generic-mutation inventory [T1961]", () => {
  it("enumerates every ordinary LedgerStore mutation operation kind", () => {
    expect([...WORKSET_GENERIC_MUTATION_OPERATION_KINDS]).toEqual([
      "create-ledger",
      "create-milestone",
      "create-item",
      "update-milestone",
      "update-item",
      "reopen-item",
      "unarchive-item",
      "archive-milestone",
    ]);
    expect(new Set(WORKSET_GENERIC_MUTATION_OPERATION_KINDS).size).toBe(
      WORKSET_GENERIC_MUTATION_OPERATION_KINDS.length,
    );
  });

  it("has exactly one allow-or-deny clause per operation kind", () => {
    expect(WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES).toHaveLength(
      WORKSET_GENERIC_MUTATION_OPERATION_KINDS.length,
    );
    const kinds = WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES.map((c) => c.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const kind of WORKSET_GENERIC_MUTATION_OPERATION_KINDS) {
      const clause = clauseForGenericMutationOperation(kind);
      expect(clause.kind).toBe(kind);
      expect(clause.unrestricted).toBe("allow");
      expect(
        ["deny", "require-target-in-graph", "require-exact-inactive-root", "require-sweep-in-graph"],
      ).toContain(clause.restrictive);
    }
  });

  it("maps every ordinary LedgerStore mutation method into the inventory", () => {
    const methods = inventoriedLedgerStoreMutationMethods();
    expect([...methods].sort()).toEqual([...LEDGER_STORE_ORDINARY_MUTATIONS].sort());
    expect([...WORKSET_GENERIC_MUTATION_RAW_WRITE_METHODS].sort()).toEqual(
      [...LEDGER_STORE_ORDINARY_MUTATIONS].sort(),
    );
  });

  it("denies generic creation and createLedger under restrictive roots", () => {
    expect(clauseForGenericMutationOperation("create-item").restrictive).toBe("deny");
    expect(clauseForGenericMutationOperation("create-milestone").restrictive).toBe(
      "deny",
    );
    expect(clauseForGenericMutationOperation("create-ledger").restrictive).toBe("deny");
  });

  it("requires graph membership for update and reopen", () => {
    expect(clauseForGenericMutationOperation("update-item").restrictive).toBe(
      "require-target-in-graph",
    );
    expect(clauseForGenericMutationOperation("update-milestone").restrictive).toBe(
      "require-target-in-graph",
    );
    expect(clauseForGenericMutationOperation("reopen-item").restrictive).toBe(
      "require-target-in-graph",
    );
  });

  it("limits unarchive to exact inactive roots and archive to full sweep", () => {
    expect(clauseForGenericMutationOperation("unarchive-item").restrictive).toBe(
      "require-exact-inactive-root",
    );
    expect(clauseForGenericMutationOperation("archive-milestone").restrictive).toBe(
      "require-sweep-in-graph",
    );
  });

  it("classifies status, closure-forming, advisory, and sealed-ownership fields", () => {
    const byField = new Map(
      WORKSET_GENERIC_MUTATION_FIELD_CLAUSES.map((c) => [c.field, c]),
    );
    expect(byField.get("status")).toEqual({
      field: "status",
      kind: "eligibility",
      restrictive: "require-target-in-graph",
    });
    expect(byField.get("dependsOn")?.kind).toBe("closure-forming");
    expect(byField.get("blockedBy")?.kind).toBe("closure-forming");
    expect(byField.get("dependsOn")?.restrictive).toBe(
      "require-introduced-refs-in-graph",
    );
    expect(byField.get("ledgerRefs")?.kind).toBe("advisory");
    expect(byField.get("sourceRefs")?.kind).toBe("advisory");
    expect(byField.get(WORKSET_OWNER_REF_FIELD)?.kind).toBe("sealed-ownership");
    expect(byField.get(WORKSET_OWNER_EDGE_KIND_FIELD)?.kind).toBe("sealed-ownership");
    expect(byField.get(WORKSET_OWNER_REF_FIELD)?.restrictive).toBe("reject");
    expect(byField.get(WORKSET_OWNER_EDGE_KIND_FIELD)?.restrictive).toBe("reject");
  });

  it("aligns closure-forming fields with DEPENDENCY_REF_FIELDS", () => {
    expect([...WORKSET_GENERIC_MUTATION_CLOSURE_FIELDS]).toEqual([
      ...DEPENDENCY_REF_FIELDS,
    ]);
    expect(clauseForGenericMutationField("dependsOn")).toBeDefined();
    expect(clauseForGenericMutationField("blockedBy")).toBeDefined();
  });

  it("covers every sealed ownership field name", () => {
    expect([...inventoriedSealedOwnershipFields()].sort()).toEqual(
      [...WORKSET_OWNED_FIELD_NAMES].sort(),
    );
    for (const name of WORKSET_OWNED_FIELD_NAMES) {
      expect(clauseForGenericMutationField(name)?.restrictive).toBe("reject");
    }
  });
});
