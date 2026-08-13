/**
 * T1977 — pure contextual imported-ownership reconciliation.
 *
 * Constructive taxonomy: Behavioral / Active / Blackbox. Adapter migration
 * tests consume the same pure boundary before opening their destination.
 */

import { describe, expect, it } from "bun:test";
import {
  CANONICAL_LEDGERS,
  GOALS_LEDGER,
  MILESTONES_LEDGER,
  PLAN_CURRENT_DRAFT_FIELD,
  TASKS_LEDGER,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
  parseBackupDump,
  readCanonicalOwnership,
  reconcileImportedOwnershipDump,
  serializeLedger,
  serializeRegistry,
  type BackupDumpFile,
  type Item,
  type Ledger,
} from "../src/index.js";
import {
  PLAN_LIFECYCLE_DUMP_PATH,
  serializePlanLifecycleDump,
} from "../src/store/planLifecycleDump.js";

const NOW = "2026-08-13T19:00:00.000Z";

function item(id: string, milestoneId: string, status: string, fields: Item["fields"]): Item {
  return { id, milestoneId, status, fields, createdAt: NOW, updatedAt: NOW };
}

function ledger(name: string, groups: Ledger["milestones"]): Ledger {
  const canonical = CANONICAL_LEDGERS.find((entry) => entry.name === name);
  if (canonical === undefined) throw new Error(`missing canonical ${name}`);
  return {
    id: name,
    schema: canonical.schema,
    counters: { milestone: 2, item: 4 },
    milestones: groups,
    archivePointers: [],
  };
}

function dump(options: {
  readonly secondGoalEvidence?: boolean;
  readonly sealedConflict?: boolean;
  readonly invalidPolicy?: boolean;
  readonly missingOwner?: boolean;
  readonly partialSealed?: boolean;
  readonly operationEvidence?: boolean;
  readonly operationAckMismatch?: boolean;
} = {}): BackupDumpFile[] {
  const manifest = {
    revision: 1,
    milestones: [{ key: "delivery", id: "M1" }],
    tasks: [{ key: "task", id: "T1" }],
  };
  const goals = [
    item("G1", "M-AMBIENT", "planning", {
      title: "Goal",
      description: "Goal",
      [PLAN_CURRENT_DRAFT_FIELD]: JSON.stringify({
        identity: { goalId: "G1", claimId: "claim-1", generation: 1, revision: 1 },
        manifest,
      }),
    }),
  ];
  if (options.secondGoalEvidence === true) {
    goals.push(
      item("G2", "M-AMBIENT", "planning", {
        title: "Other goal",
        description: "Other goal",
        [PLAN_CURRENT_DRAFT_FIELD]: JSON.stringify({
          identity: { goalId: "G2", claimId: "claim-2", generation: 1, revision: 1 },
          manifest,
        }),
      }),
    );
  }
  const taskFields: Item["fields"] = { headline: "Implement" };
  if (options.sealedConflict === true) {
    taskFields[WORKSET_OWNER_REF_FIELD] = "goals:G2";
    taskFields[WORKSET_OWNER_EDGE_KIND_FIELD] = "active-current-draft";
  }
  const ledgers = [
    ledger(GOALS_LEDGER, [{ id: "M-AMBIENT", title: "ambient", description: "", items: goals }]),
    ledger(MILESTONES_LEDGER, [
      {
        id: "active",
        title: "active",
        description: "",
        items: [item("M1", "active", "open", { title: "Delivery" })],
      },
    ]),
    ledger(TASKS_LEDGER, [
      {
        id: "M1",
        title: "Delivery",
        description: "",
        items: [
          item("T1", "M1", "planned", taskFields),
          item("T2", "M1", "planned", {
            headline: "Advisory",
            ledgerRefs: ["goals:G1"],
            ...(options.invalidPolicy === true
              ? {
                  [WORKSET_OWNER_REF_FIELD]: "goals:G1",
                  [WORKSET_OWNER_EDGE_KIND_FIELD]: "review",
                }
              : options.missingOwner === true
                ? {
                    [WORKSET_OWNER_REF_FIELD]: "goals:G999",
                    [WORKSET_OWNER_EDGE_KIND_FIELD]: "review",
                  }
                : options.partialSealed === true
                  ? { [WORKSET_OWNER_REF_FIELD]: "goals:G1" }
                  : {}),
          }),
          item("T3", "M1", "planned", { headline: "Acknowledged" }),
        ],
      },
    ]),
  ];
  const files: BackupDumpFile[] = [
    {
      path: "ledgers.yaml",
      content: serializeRegistry({
        version: 1,
        ledgers: ledgers.map(({ id: name, schema }) => ({ name, schema })),
      }),
    },
    ...ledgers.map((value) => ({ path: `${value.id}.md`, content: serializeLedger(value) })),
  ];
  if (options.operationEvidence === true) {
    const replay = {
      goalId: "G1",
      claimId: "claim-1",
      generation: 1,
      operation: "publish-draft" as const,
      operationId: "publish-2",
      requestPayloadVerifier: "a".repeat(64),
    };
    files.push({
      path: PLAN_LIFECYCLE_DUMP_PATH,
      content: serializePlanLifecycleDump({
        claims: new Map(),
        operations: new Map([
          [
            "operation",
            {
              replay,
              acknowledgement: {
                goalId: "G1",
                claimId: "claim-1",
                generation: 1,
                operationId: options.operationAckMismatch === true ? "publish-other" : "publish-2",
                manifest: {
                  revision: 2,
                  milestones: [],
                  tasks: [{ key: "ack", id: "T3" }],
                },
                replacedManifest: null,
                reviewDefects: [],
              },
            },
          ],
        ]),
      }),
    });
  }
  return files;
}

function restoredItem(files: readonly BackupDumpFile[], ledgerId: string, id: string): Item {
  const found = parseBackupDump(files)
    .ledgers.get(ledgerId)
    ?.milestones.flatMap(({ items }) => items)
    .find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing ${ledgerId}:${id}`);
  return found;
}

describe("imported workset ownership reconciliation [T1977]", () => {
  it("preserve mode retains sealed metadata but never derives legacy ownership", () => {
    const files = reconcileImportedOwnershipDump(dump(), "preserve");
    expect(readCanonicalOwnership(restoredItem(files, TASKS_LEDGER, "T1"))).toBeNull();
  });

  it("infer mode uses exact manifests and operation acknowledgements, never ledgerRefs", () => {
    const files = reconcileImportedOwnershipDump(
      dump({ operationEvidence: true }),
      "infer-unambiguous-legacy",
    );
    for (const [ledgerId, id] of [
      [MILESTONES_LEDGER, "M1"],
      [TASKS_LEDGER, "T1"],
    ] as const) {
      expect(readCanonicalOwnership(restoredItem(files, ledgerId, id))).toEqual({
        ownerRef: "goals:G1",
        edgeKind: "active-current-draft",
      });
    }
    expect(readCanonicalOwnership(restoredItem(files, TASKS_LEDGER, "T3"))).toEqual({
      ownerRef: "goals:G1",
      edgeKind: "active-current-draft",
    });
    expect(readCanonicalOwnership(restoredItem(files, TASKS_LEDGER, "T2"))).toBeNull();
  });

  it("leaves ambiguous evidence unowned", () => {
    const files = reconcileImportedOwnershipDump(
      dump({ secondGoalEvidence: true }),
      "infer-unambiguous-legacy",
    );
    expect(readCanonicalOwnership(restoredItem(files, TASKS_LEDGER, "T1"))).toBeNull();
  });

  it("rejects an acknowledgement outside its exact durable operation scope", () => {
    expect(() =>
      reconcileImportedOwnershipDump(
        dump({ operationEvidence: true, operationAckMismatch: true }),
        "infer-unambiguous-legacy",
      ),
    ).toThrow(/plan operation acknowledgement mismatch/);
  });

  it("rejects conflicting sealed and exact evidence", () => {
    expect(() =>
      reconcileImportedOwnershipDump(
        dump({ secondGoalEvidence: true, sealedConflict: true }),
        "infer-unambiguous-legacy",
      ),
    ).toThrow(/conflicting sealed ownership and imported evidence/);
  });

  it("rejects missing owners and t1 child-ledger policy violations", () => {
    expect(() => reconcileImportedOwnershipDump(dump({ missingOwner: true }), "preserve")).toThrow(
      /owner does not exist/,
    );
    expect(() => reconcileImportedOwnershipDump(dump({ invalidPolicy: true }), "preserve")).toThrow(
      /violates owner-edge policy/,
    );
  });

  it("keeps partial sealed metadata ambiguous and unowned", () => {
    const files = reconcileImportedOwnershipDump(
      dump({ partialSealed: true }),
      "infer-unambiguous-legacy",
    );
    expect(readCanonicalOwnership(restoredItem(files, TASKS_LEDGER, "T2"))).toBeNull();
  });
});
