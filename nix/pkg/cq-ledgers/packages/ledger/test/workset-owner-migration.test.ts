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
import { serializeArchive } from "../src/parser/serialize.js";

const NOW = "2026-08-13T19:00:00.000Z";

function item(id: string, milestoneId: string, status: string, fields: Item["fields"]): Item {
  return { id, milestoneId, status, fields, createdAt: NOW, updatedAt: NOW };
}

function ledger(
  name: string,
  groups: Ledger["milestones"],
  archivePointers: Ledger["archivePointers"] = [],
): Ledger {
  const canonical = CANONICAL_LEDGERS.find((entry) => entry.name === name);
  if (canonical === undefined) throw new Error(`missing canonical ${name}`);
  return {
    id: name,
    schema: canonical.schema,
    counters: { milestone: 2, item: 4 },
    milestones: groups,
    archivePointers,
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
  readonly archivedGoal?: boolean;
} = {}): BackupDumpFile[] {
  const manifest = {
    revision: 1,
    milestones: [{ key: "delivery", id: "M1" }],
    tasks: [{ key: "task", id: "T1" }],
  };
  const goal = item("G1", options.archivedGoal === true ? "M-OLD" : "M-AMBIENT", "planning", {
    title: "Goal",
    description: "Goal",
    [PLAN_CURRENT_DRAFT_FIELD]: JSON.stringify({
      identity: { goalId: "G1", claimId: "claim-1", generation: 1, revision: 1 },
      manifest,
    }),
  });
  const goals = [goal];
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
    ledger(
      GOALS_LEDGER,
      options.archivedGoal === true
        ? []
        : [{ id: "M-AMBIENT", title: "ambient", description: "", items: goals }],
      options.archivedGoal === true
        ? [
            {
              id: "M-OLD",
              path: "./archive/goals/M-OLD.md",
              summary: "archived goal",
              title: "Archived goal",
              status: "done",
            },
          ]
        : [],
    ),
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
  if (options.archivedGoal === true) {
    files.push({
      path: "archive/goals/M-OLD.md",
      content: serializeArchive({
        id: "M-OLD",
        title: "Archived goal",
        description: "",
        items: goals,
      }),
    });
  }
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

  it("never infers a new edge to an archived owner", () => {
    const files = reconcileImportedOwnershipDump(
      dump({ archivedGoal: true }),
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

  it("rejects duplicate durable operation scopes before either acknowledgement can win", () => {
    for (const conflicting of [false, true]) {
      const files = dump({ operationEvidence: true });
      const lifecycleIndex = files.findIndex(({ path }) => path === PLAN_LIFECYCLE_DUMP_PATH);
      const lifecycle = files[lifecycleIndex];
      if (lifecycle === undefined) throw new Error("plan lifecycle fixture missing");
      const raw = JSON.parse(lifecycle.content) as {
        version: number;
        claims: unknown[];
        operations: Array<{ acknowledgement: Record<string, unknown> }>;
      };
      const first = raw.operations[0];
      if (first === undefined) throw new Error("plan operation fixture missing");
      const duplicate = structuredClone(first);
      if (conflicting) {
        duplicate.acknowledgement["manifest"] = {
          revision: 2,
          milestones: [],
          tasks: [{ key: "other", id: "T2" }],
        };
      }
      files[lifecycleIndex] = {
        ...lifecycle,
        content: JSON.stringify({ ...raw, operations: [first, duplicate] }),
      };
      expect(() =>
        reconcileImportedOwnershipDump(files, "infer-unambiguous-legacy"),
      ).toThrow(/duplicate persisted plan lifecycle operation scope/);
    }
  });

  it("rejects duplicate durable claim scopes before either claim can win", () => {
    const files = dump();
    const claim = {
      goalId: "G1",
      claimId: "claim-1",
      generation: 1,
      purpose: "initial",
      claimRequestId: "request-1",
      ownerFenceTokenVerifier: "a".repeat(64),
      expectedGeneration: null,
      priorGeneration: null,
      previousGoalPhase: "clarifying",
      goalPhase: "planning",
      legacyAdopted: false,
      adoptedManifest: { milestoneIds: [], taskIds: [] },
      waitingResearches: [],
      waitingTasks: [],
      author: "T1977",
      state: "active",
    };
    files.push({
      path: PLAN_LIFECYCLE_DUMP_PATH,
      content: JSON.stringify({ version: 1, claims: [claim, claim], operations: [] }),
    });
    expect(() =>
      reconcileImportedOwnershipDump(files, "infer-unambiguous-legacy"),
    ).toThrow(/duplicate persisted plan lifecycle claim scope/);
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
