/**
 * T1951 — exhaustive lifecycle-owner edge matrix.
 *
 * Enumerates CANONICAL_LEDGERS × planning/implementation creation inventories
 * with no missing policy cell; rejects sealed ownership metadata through
 * generic mutations; proves a positive plus reverse/sibling/unrelated negative
 * fixture for every allowed row.
 */

import { describe, it, expect, afterAll } from "bun:test";
import {
  CANONICAL_LEDGERS,
  InMemoryLedgerStore,
  IDEAS_LEDGER,
  GOALS_LEDGER,
  TASKS_LEDGER,
  DEFECTS_LEDGER,
  MILESTONES_AMBIENT_ID,
  PLANNING_LIFECYCLE_CREATION_KINDS,
  IMPLEMENTATION_LIFECYCLE_CREATION_KINDS,
  WORKSET_OWNER_EDGE_KINDS,
  WORKSET_OWNER_REF_FIELD,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNED_FIELD_NAMES,
  WORKSET_OWNERSHIP_SCHEMA_FIELDS,
  ALLOWED_OWNER_EDGE_ROWS,
  DENIED_OWNER_EDGE_ROWS,
  resolveOwnerEdgePolicy,
  ownerEdgeCoverageCells,
  fixturesForAllowedRow,
  fixtureIncludedInOwnerClosure,
  assertWorksetOwnershipFieldsAbsent,
  WorksetOwnershipFieldError,
  deriveCanonicalOwnership,
  ownershipFieldsFrom,
  ownershipFromLedgerRefs,
  PREREQUISITE_EDGE,
  type LifecycleCreationKind,
  type AllowedOwnerEdgeRow,
} from "../src/index.js";

describe("workset owner-edge table — exhaustiveness", () => {
  it("covers every CANONICAL_LEDGERS × planning creation kind cell", () => {
    const cells = ownerEdgeCoverageCells().filter((c) => c.inventory === "planning");
    const expected =
      CANONICAL_LEDGERS.length * PLANNING_LIFECYCLE_CREATION_KINDS.length;
    expect(cells.length).toBe(expected);
    for (const { name } of CANONICAL_LEDGERS) {
      for (const creationKind of PLANNING_LIFECYCLE_CREATION_KINDS) {
        const cell = cells.find(
          (c) => c.ownerLedger === name && c.creationKind === creationKind,
        );
        expect(cell).toBeDefined();
        // Resolution is total for any status string.
        const resolved = resolveOwnerEdgePolicy({
          ownerLedger: name,
          ownerStatus: "__any__",
          creationKind,
        });
        expect(resolved.decision === "allow" || resolved.decision === "deny").toBe(
          true,
        );
      }
    }
  });

  it("covers every CANONICAL_LEDGERS × implementation creation kind cell", () => {
    const cells = ownerEdgeCoverageCells().filter(
      (c) => c.inventory === "implementation",
    );
    const expected =
      CANONICAL_LEDGERS.length * IMPLEMENTATION_LIFECYCLE_CREATION_KINDS.length;
    expect(cells.length).toBe(expected);
    for (const { name } of CANONICAL_LEDGERS) {
      for (const creationKind of IMPLEMENTATION_LIFECYCLE_CREATION_KINDS) {
        const cell = cells.find(
          (c) => c.ownerLedger === name && c.creationKind === creationKind,
        );
        expect(cell).toBeDefined();
        const resolved = resolveOwnerEdgePolicy({
          ownerLedger: name,
          ownerStatus: "__any__",
          creationKind,
        });
        expect(resolved.decision === "allow" || resolved.decision === "deny").toBe(
          true,
        );
      }
    }
  });

  it("has an allow or explicit-deny row for every coverage cell", () => {
    for (const cell of ownerEdgeCoverageCells()) {
      const allowKey = `${cell.ownerLedger}\0${cell.creationKind}`;
      const hasAllow = ALLOWED_OWNER_EDGE_ROWS.some(
        (r) => `${r.ownerLedger}\0${r.creationKind}` === allowKey,
      );
      const hasDeny = DENIED_OWNER_EDGE_ROWS.some(
        (r) => `${r.ownerLedger}\0${r.creationKind}` === allowKey,
      );
      expect(hasAllow || hasDeny).toBe(true);
      expect(hasAllow).toBe(cell.hasAllowRow);
      if (hasAllow) expect(hasDeny).toBe(false);
    }
  });

  it("every allow row points owner-to-child with a known edge kind and child ledger", () => {
    const ledgerNames = new Set(CANONICAL_LEDGERS.map((c) => c.name));
    for (const row of ALLOWED_OWNER_EDGE_ROWS) {
      expect(row.direction).toBe("owner-to-child");
      expect(row.preservesLiveOwnedBranch).toBe(true);
      expect(WORKSET_OWNER_EDGE_KINDS).toContain(row.edgeKind);
      expect(row.edgeKind).toBe(row.creationKind);
      expect(ledgerNames.has(row.ownerLedger)).toBe(true);
      expect(row.childLedgers.length).toBeGreaterThan(0);
      for (const child of row.childLedgers) {
        expect(ledgerNames.has(child)).toBe(true);
      }
      expect(row.ownerStatuses.length).toBeGreaterThan(0);
      expect(row.exclusions).toContain("reverse-edge");
      expect(row.exclusions).toContain("sibling");
      expect(row.exclusions).toContain("unrelated-reference");
      expect(row.exclusions).toContain("stale-draft");
      expect(row.exclusions).toContain("superseded-review");
      expect(row.exclusions).toContain("ambiguous-legacy-ownership");
      expect(row.exclusions).toContain("archived-or-inactive-owner");
      expect(row.exclusions).toContain("ledger-refs-only");
    }
  });

  it("resolves allow only for declared owner statuses", () => {
    for (const row of ALLOWED_OWNER_EDGE_ROWS) {
      for (const status of row.ownerStatuses) {
        const resolved = resolveOwnerEdgePolicy({
          ownerLedger: row.ownerLedger,
          ownerStatus: status,
          creationKind: row.creationKind,
        });
        expect(resolved.decision).toBe("allow");
        if (resolved.decision === "allow") {
          expect([...resolved.childLedgers]).toEqual([...row.childLedgers]);
        }
      }
      const denied = resolveOwnerEdgePolicy({
        ownerLedger: row.ownerLedger,
        ownerStatus: "__not-a-live-status__",
        creationKind: row.creationKind,
      });
      expect(denied.decision).toBe("deny");
    }
  });

  it("names phase-aware goal draft vs finalized edges", () => {
    expect(
      resolveOwnerEdgePolicy({
        ownerLedger: GOALS_LEDGER,
        ownerStatus: "clarifying",
        creationKind: "active-current-draft",
      }).decision,
    ).toBe("allow");
    expect(
      resolveOwnerEdgePolicy({
        ownerLedger: GOALS_LEDGER,
        ownerStatus: "building",
        creationKind: "active-current-draft",
      }).decision,
    ).toBe("deny");
    expect(
      resolveOwnerEdgePolicy({
        ownerLedger: GOALS_LEDGER,
        ownerStatus: "planned",
        creationKind: "finalized-manifest",
      }).decision,
    ).toBe("allow");
    expect(
      resolveOwnerEdgePolicy({
        ownerLedger: GOALS_LEDGER,
        ownerStatus: "planning",
        creationKind: "finalized-manifest",
      }).decision,
    ).toBe("deny");
  });

  it("documents prerequisite edges as node-to-prerequisite only", () => {
    expect(PREREQUISITE_EDGE.edgeKind).toBe("prerequisite");
    expect(PREREQUISITE_EDGE.direction).toBe("node-to-prerequisite");
    expect(PREREQUISITE_EDGE.excludesDependants).toBe(true);
    expect(
      (PLANNING_LIFECYCLE_CREATION_KINDS as readonly string[]).includes(
        "prerequisite",
      ),
    ).toBe(false);
    expect(
      (IMPLEMENTATION_LIFECYCLE_CREATION_KINDS as readonly string[]).includes(
        "prerequisite",
      ),
    ).toBe(false);
  });
});

describe("workset owner-edge table — fixtures per allowed row", () => {
  it("provides positive + reverse/sibling/unrelated negatives for every allow row", () => {
    expect(ALLOWED_OWNER_EDGE_ROWS.length).toBeGreaterThan(0);
    for (const row of ALLOWED_OWNER_EDGE_ROWS) {
      const fixtures = fixturesForAllowedRow(row);
      // One quartet per child ledger.
      expect(fixtures.length).toBe(row.childLedgers.length * 4);
      for (const childLedger of row.childLedgers) {
        const childFixtures = fixtures.filter((f) =>
          f.relation === "positive" || f.relation === "sibling" || f.relation === "unrelated"
            ? f.childRef.startsWith(`${childLedger}:`)
            : f.ownerRef.startsWith(`${childLedger}:`),
        );
        expect(childFixtures.map((f) => f.relation).sort()).toEqual(
          ["positive", "reverse", "sibling", "unrelated"].sort(),
        );
        const positive = childFixtures.find((f) => f.relation === "positive")!;
        const reverse = childFixtures.find((f) => f.relation === "reverse")!;
        const sibling = childFixtures.find((f) => f.relation === "sibling")!;
        const unrelated = childFixtures.find((f) => f.relation === "unrelated")!;

        expect(fixtureIncludedInOwnerClosure(positive)).toBe(true);
        expect(positive.included).toBe(true);
        expect(positive.ownerRef.startsWith(`${row.ownerLedger}:`)).toBe(true);
        expect(positive.childRef.startsWith(`${childLedger}:`)).toBe(true);

        expect(fixtureIncludedInOwnerClosure(reverse)).toBe(false);
        expect(reverse.included).toBe(false);
        // Reverse swaps endpoints.
        expect(reverse.ownerRef).toBe(positive.childRef);
        expect(reverse.childRef).toBe(positive.ownerRef);

        expect(fixtureIncludedInOwnerClosure(sibling)).toBe(false);
        expect(sibling.otherRef).toBeDefined();
        expect(sibling.otherRef).not.toBe(sibling.childRef);

        expect(fixtureIncludedInOwnerClosure(unrelated)).toBe(false);
        expect(unrelated.otherRef).toBeDefined();
        expect(unrelated.otherRef).not.toBe(unrelated.childRef);
        expect(unrelated.otherRef).not.toBe(unrelated.ownerRef);
      }
    }
  });

  it("derives sealed ownership only from an allow row and selected owner", () => {
    const row = ALLOWED_OWNER_EDGE_ROWS.find(
      (r) =>
        r.ownerLedger === IDEAS_LEDGER && r.creationKind === "idea-to-goal",
    );
    expect(row).toBeDefined();
    const ownership = deriveCanonicalOwnership(IDEAS_LEDGER, "I1", row!);
    expect(ownership).toEqual({
      ownerRef: "ideas:I1",
      edgeKind: "idea-to-goal",
    });
    expect(ownershipFieldsFrom(ownership)).toEqual({
      [WORKSET_OWNER_REF_FIELD]: "ideas:I1",
      [WORKSET_OWNER_EDGE_KIND_FIELD]: "idea-to-goal",
    });
    expect(ownershipFromLedgerRefs(["ideas:I1", "goals:G1"])).toBeNull();
  });
});

describe("workset owner-edge table — sealed ownership schema + generic mutation fence", () => {
  it("declares ownership fields on every canonical schema", () => {
    for (const { name, schema } of CANONICAL_LEDGERS) {
      for (const field of WORKSET_OWNED_FIELD_NAMES) {
        const spec = schema.fields[field];
        expect(spec).toBeDefined();
        expect(spec?.required).toBe(false);
        expect(spec?.type).toBe(
          WORKSET_OWNERSHIP_SCHEMA_FIELDS[field].type,
        );
      }
      // silence unused in some runners
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("assertWorksetOwnershipFieldsAbsent rejects create-time presence", () => {
    expect(() =>
      assertWorksetOwnershipFieldsAbsent({
        [WORKSET_OWNER_REF_FIELD]: "goals:G1",
      }),
    ).toThrow(WorksetOwnershipFieldError);
    expect(() =>
      assertWorksetOwnershipFieldsAbsent({
        [WORKSET_OWNER_EDGE_KIND_FIELD]: "review",
      }),
    ).toThrow(WorksetOwnershipFieldError);
    expect(() => assertWorksetOwnershipFieldsAbsent({ headline: "ok" })).not.toThrow();
  });

  it("assertWorksetOwnershipFieldsAbsent rejects update-time change", () => {
    const existing = {
      id: "T1",
      milestoneId: "M1",
      status: "planned",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      fields: {
        [WORKSET_OWNER_REF_FIELD]: "goals:G1",
        [WORKSET_OWNER_EDGE_KIND_FIELD]: "finalized-manifest",
      },
    };
    expect(() =>
      assertWorksetOwnershipFieldsAbsent(
        { [WORKSET_OWNER_REF_FIELD]: "goals:G2" },
        existing,
      ),
    ).toThrow(WorksetOwnershipFieldError);
    expect(() =>
      assertWorksetOwnershipFieldsAbsent(
        { [WORKSET_OWNER_REF_FIELD]: undefined as unknown as string },
        existing,
      ),
    ).toThrow(WorksetOwnershipFieldError);
    // identical re-statement is a no-op (not a change)
    expect(() =>
      assertWorksetOwnershipFieldsAbsent(
        {
          [WORKSET_OWNER_REF_FIELD]: "goals:G1",
          [WORKSET_OWNER_EDGE_KIND_FIELD]: "finalized-manifest",
        },
        existing,
      ),
    ).not.toThrow();
  });

  it("generic createItem rejects ownership metadata", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    await store.createItem(IDEAS_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "open",
      fields: { title: "seed idea" },
    });
    await expect(
      store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
        status: "clarifying",
        fields: {
          title: "owned goal",
          description: "should fail",
          [WORKSET_OWNER_REF_FIELD]: "ideas:I1",
          [WORKSET_OWNER_EDGE_KIND_FIELD]: "idea-to-goal",
        },
      }),
    ).rejects.toBeInstanceOf(WorksetOwnershipFieldError);
  });

  it("generic updateItem rejects ownership metadata", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const task = await store.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "planned",
      fields: { headline: "plain task" },
    });
    await expect(
      store.updateItem(TASKS_LEDGER, task.id, {
        fields: {
          [WORKSET_OWNER_REF_FIELD]: "goals:G1",
          [WORKSET_OWNER_EDGE_KIND_FIELD]: "finalized-manifest",
        },
      }),
    ).rejects.toBeInstanceOf(WorksetOwnershipFieldError);
  });

  it("generic createItem still succeeds without ownership fields", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const defect = await store.createItem(DEFECTS_LEDGER, MILESTONES_AMBIENT_ID, {
      status: "open",
      fields: {
        headline: "plain defect",
        severity: "low",
        ledgerRefs: ["goals:G99"],
      },
    });
    expect(defect.fields[WORKSET_OWNER_REF_FIELD]).toBeUndefined();
    expect(defect.fields[WORKSET_OWNER_EDGE_KIND_FIELD]).toBeUndefined();
    // ledgerRefs remain advisory and do not seal ownership
    expect(ownershipFromLedgerRefs(defect.fields["ledgerRefs"] as string[])).toBeNull();
  });
});

// Keep afterAll import used if harness expects cleanup hooks present.
afterAll(() => undefined);

// Type-level smoke: inventories are assignable to the union.
const _planning: LifecycleCreationKind = PLANNING_LIFECYCLE_CREATION_KINDS[0];
const _impl: LifecycleCreationKind = IMPLEMENTATION_LIFECYCLE_CREATION_KINDS[0];
const _row: AllowedOwnerEdgeRow = ALLOWED_OWNER_EDGE_ROWS[0]!;
void _planning;
void _impl;
void _row;
