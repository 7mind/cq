/** Pure ownership reconciliation for restore and backend migration imports. */

import {
  GOALS_LEDGER,
  MILESTONES_LEDGER,
  TASKS_LEDGER,
  WORKSET_OWNER_EDGE_KIND_FIELD,
  WORKSET_OWNER_REF_FIELD,
} from "./constants.js";
import {
  PLAN_CURRENT_DRAFT_FIELD,
  PLAN_FINALIZED_MANIFEST_FIELD,
  PlanDraftIdentitySchema,
  PlanFinalizeAcknowledgementSchema,
  PlanPublishDraftAcknowledgementSchema,
  PlanPublishedManifestSchema,
  PlanReleaseAcknowledgementSchema,
  type PlanOperationReplayRecord,
  type PlanPublishedManifest,
} from "./planLifecycle.js";
import {
  ALLOWED_OWNER_EDGE_ROWS,
  LIFECYCLE_CREATION_KIND_SET,
  readCanonicalOwnership,
  resolveOwnerEdgePolicy,
  type CanonicalOwnership,
  type LifecycleCreationKind,
} from "./worksetOwnerEdges.js";
import { LedgerError, type Item } from "./types.js";
import {
  serializeArchive,
  serializeLedger,
  serializeMilestoneItemArchive,
} from "./parser/serialize.js";
import type { BackupDumpFile } from "./store/backupExporter.js";
import type { ParsedDump } from "./store/restoreImporter.js";

export type ImportedOwnershipMode = "preserve" | "infer-unambiguous-legacy";

interface LocatedItem {
  readonly ledgerId: string;
  readonly item: Item;
}

function ref(ledgerId: string, itemId: string): string {
  return `${ledgerId}:${itemId}`;
}

function splitOwnerRef(ownerRef: string): { ledgerId: string; itemId: string } | null {
  const match = /^([a-z][A-Za-z0-9_-]*):([A-Za-z][A-Za-z0-9_-]*)$/.exec(ownerRef);
  if (match === null) return null;
  return { ledgerId: match[1]!, itemId: match[2]! };
}

function allItems(parsed: ParsedDump): LocatedItem[] {
  const items: LocatedItem[] = [];
  for (const [ledgerId, ledger] of parsed.ledgers) {
    for (const group of ledger.milestones) {
      for (const item of group.items) items.push({ ledgerId, item });
    }
    for (const content of parsed.archives.get(ledgerId)?.values() ?? []) {
      if (content.kind === "item") items.push({ ledgerId, item: content.item });
      else {
        for (const item of content.milestone.items) items.push({ ledgerId, item });
      }
    }
  }
  return items;
}

function evidenceKey(ownership: CanonicalOwnership): string {
  return `${ownership.ownerRef}\0${ownership.edgeKind}`;
}

function addEvidence(
  evidence: Map<string, Map<string, CanonicalOwnership>>,
  childRef: string,
  ownership: CanonicalOwnership,
): void {
  let candidates = evidence.get(childRef);
  if (candidates === undefined) {
    candidates = new Map();
    evidence.set(childRef, candidates);
  }
  // Finalization supersedes the same goal's current-draft evidence. Both the
  // goal fields and durable operation history legitimately retain the earlier
  // publish acknowledgement after the final ownership seal.
  const activeKey = evidenceKey({
    ownerRef: ownership.ownerRef,
    edgeKind: "active-current-draft",
  });
  const finalizedKey = evidenceKey({
    ownerRef: ownership.ownerRef,
    edgeKind: "finalized-manifest",
  });
  if (ownership.edgeKind === "finalized-manifest") candidates.delete(activeKey);
  if (ownership.edgeKind === "active-current-draft" && candidates.has(finalizedKey)) return;
  candidates.set(evidenceKey(ownership), ownership);
}

function addManifestEvidence(
  evidence: Map<string, Map<string, CanonicalOwnership>>,
  goalId: string,
  edgeKind: "active-current-draft" | "finalized-manifest",
  manifest: PlanPublishedManifest,
): void {
  const ownership = { ownerRef: ref(GOALS_LEDGER, goalId), edgeKind } as const;
  for (const { id } of manifest.milestones) {
    addEvidence(evidence, ref(MILESTONES_LEDGER, id), ownership);
  }
  for (const { id } of manifest.tasks) {
    addEvidence(evidence, ref(TASKS_LEDGER, id), ownership);
  }
}

function parseGoalEvidence(
  goal: Item,
  evidence: Map<string, Map<string, CanonicalOwnership>>,
): void {
  const currentRaw = goal.fields[PLAN_CURRENT_DRAFT_FIELD];
  if (currentRaw !== undefined) {
    if (typeof currentRaw !== "string") {
      throw new LedgerError(`goal ${goal.id} has invalid ${PLAN_CURRENT_DRAFT_FIELD}`);
    }
    try {
      const value = JSON.parse(currentRaw) as Record<string, unknown>;
      const identity = PlanDraftIdentitySchema.parse(value["identity"]);
      if (identity.goalId !== goal.id) throw new Error("draft goalId mismatch");
      addManifestEvidence(
        evidence,
        goal.id,
        "active-current-draft",
        PlanPublishedManifestSchema.parse(value["manifest"]),
      );
    } catch (error) {
      throw new LedgerError(
        `goal ${goal.id} has invalid ${PLAN_CURRENT_DRAFT_FIELD}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const finalizedRaw = goal.fields[PLAN_FINALIZED_MANIFEST_FIELD];
  if (finalizedRaw !== undefined) {
    if (typeof finalizedRaw !== "string") {
      throw new LedgerError(`goal ${goal.id} has invalid ${PLAN_FINALIZED_MANIFEST_FIELD}`);
    }
    try {
      addManifestEvidence(
        evidence,
        goal.id,
        "finalized-manifest",
        PlanPublishedManifestSchema.parse(JSON.parse(finalizedRaw)),
      );
    } catch (error) {
      throw new LedgerError(
        `goal ${goal.id} has invalid ${PLAN_FINALIZED_MANIFEST_FIELD}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function addOperationEvidence(
  parsed: ParsedDump,
  evidence: Map<string, Map<string, CanonicalOwnership>>,
): void {
  function assertAcknowledgementScope(
    replay: PlanOperationReplayRecord,
    acknowledgement: {
      readonly goalId: string;
      readonly claimId: string;
      readonly generation: number;
      readonly operationId: string;
    },
  ): void {
    if (
      acknowledgement.goalId !== replay.goalId ||
      acknowledgement.claimId !== replay.claimId ||
      acknowledgement.generation !== replay.generation ||
      acknowledgement.operationId !== replay.operationId
    ) {
      throw new LedgerError("plan operation acknowledgement mismatch");
    }
  }

  for (const { replay, acknowledgement } of parsed.planLifecycle?.operations.values() ?? []) {
    if (replay.operation === "publish-draft") {
      const ack = PlanPublishDraftAcknowledgementSchema.parse(acknowledgement);
      assertAcknowledgementScope(replay, ack);
      addManifestEvidence(evidence, ack.goalId, "active-current-draft", ack.manifest);
      for (const { id } of ack.reviewDefects) {
        addEvidence(evidence, ref("defects", id), {
          ownerRef: ref(GOALS_LEDGER, ack.goalId),
          edgeKind: "review-filed-defect",
        });
      }
      continue;
    }
    if (replay.operation === "finalize") {
      const ack = PlanFinalizeAcknowledgementSchema.parse(acknowledgement);
      assertAcknowledgementScope(replay, ack);
      addManifestEvidence(evidence, ack.goalId, "finalized-manifest", ack.manifest);
      addEvidence(evidence, ref("decisions", ack.decisionId), {
        ownerRef: ref(GOALS_LEDGER, ack.goalId),
        edgeKind: "decision",
      });
      for (const { id } of ack.reviewDefects) {
        addEvidence(evidence, ref("defects", id), {
          ownerRef: ref(GOALS_LEDGER, ack.goalId),
          edgeKind: "review-filed-defect",
        });
      }
      continue;
    }
    const ack = PlanReleaseAcknowledgementSchema.parse(acknowledgement);
    assertAcknowledgementScope(replay, ack);
    for (const { id } of ack.questions) {
      addEvidence(evidence, ref("questions", id), {
        ownerRef: ref(GOALS_LEDGER, ack.goalId),
        edgeKind: "exact-gate-question",
      });
    }
    for (const { id } of ack.researches) {
      addEvidence(evidence, ref("researches", id), {
        ownerRef: ref(GOALS_LEDGER, ack.goalId),
        edgeKind: "research",
      });
    }
    for (const { id } of ack.reviewDefects) {
      addEvidence(evidence, ref("defects", id), {
        ownerRef: ref(GOALS_LEDGER, ack.goalId),
        edgeKind: "review-filed-defect",
      });
    }
  }
}

function validatePreservedOwnership(
  childLedger: string,
  ownership: CanonicalOwnership,
  owners: ReadonlyMap<string, LocatedItem>,
): void {
  const parsedRef = splitOwnerRef(ownership.ownerRef);
  if (parsedRef === null || !owners.has(ownership.ownerRef)) {
    throw new LedgerError(`imported ownership owner does not exist: ${ownership.ownerRef}`);
  }
  if (!LIFECYCLE_CREATION_KIND_SET.has(ownership.edgeKind)) {
    throw new LedgerError(`imported ownership edge is not a lifecycle creation: ${ownership.edgeKind}`);
  }
  const allowed = ALLOWED_OWNER_EDGE_ROWS.find(
    (row) =>
      row.ownerLedger === parsedRef.ledgerId &&
      row.creationKind === ownership.edgeKind &&
      row.childLedgers.includes(childLedger),
  );
  if (allowed === undefined) {
    throw new LedgerError(
      `imported ownership violates owner-edge policy: ${ownership.ownerRef}/${ownership.edgeKind} -> ${childLedger}`,
    );
  }
}

function validateInferredOwnership(
  childLedger: string,
  ownership: CanonicalOwnership,
  owners: ReadonlyMap<string, LocatedItem>,
): boolean {
  const parsedRef = splitOwnerRef(ownership.ownerRef);
  const owner = owners.get(ownership.ownerRef);
  if (
    parsedRef === null ||
    owner === undefined ||
    !LIFECYCLE_CREATION_KIND_SET.has(ownership.edgeKind)
  ) {
    return false;
  }
  const row = resolveOwnerEdgePolicy({
    ownerLedger: parsedRef.ledgerId,
    ownerStatus: owner.item.status,
    creationKind: ownership.edgeKind as LifecycleCreationKind,
  });
  return row.decision === "allow" && row.childLedgers.includes(childLedger);
}

/** Reconcile one already-parsed dump without performing any I/O. */
export function reconcileImportedOwnership(
  input: ParsedDump,
  mode: ImportedOwnershipMode,
): ParsedDump {
  const parsed = structuredClone(input) as ParsedDump;
  const located = allItems(parsed);
  const owners = new Map<string, LocatedItem>();
  for (const entry of located) {
    const itemRef = ref(entry.ledgerId, entry.item.id);
    if (owners.has(itemRef)) throw new LedgerError(`duplicate imported item ref ${itemRef}`);
    owners.set(itemRef, entry);
  }

  const evidence = new Map<string, Map<string, CanonicalOwnership>>();
  for (const { ledgerId, item } of located) {
    if (ledgerId === GOALS_LEDGER) parseGoalEvidence(item, evidence);
  }
  addOperationEvidence(parsed, evidence);

  for (const { ledgerId, item } of located) {
    const ownerRefField = item.fields[WORKSET_OWNER_REF_FIELD];
    const edgeKindField = item.fields[WORKSET_OWNER_EDGE_KIND_FIELD];
    const hasAnySealedField = ownerRefField !== undefined || edgeKindField !== undefined;
    const sealed = readCanonicalOwnership(item);
    const candidates = evidence.get(ref(ledgerId, item.id));
    if (hasAnySealedField && sealed === null) {
      delete item.fields[WORKSET_OWNER_REF_FIELD];
      delete item.fields[WORKSET_OWNER_EDGE_KIND_FIELD];
      continue;
    }
    if (sealed !== null) {
      validatePreservedOwnership(ledgerId, sealed, owners);
      if (
        candidates !== undefined &&
        [...candidates.keys()].some((candidate) => candidate !== evidenceKey(sealed))
      ) {
        throw new LedgerError(
          `conflicting sealed ownership and imported evidence for ${ledgerId}:${item.id}`,
        );
      }
      continue;
    }
    if (mode === "preserve" || candidates === undefined || candidates.size !== 1) continue;
    const inferred = candidates.values().next().value as CanonicalOwnership | undefined;
    if (inferred === undefined || !validateInferredOwnership(ledgerId, inferred, owners)) continue;
    item.fields[WORKSET_OWNER_REF_FIELD] = inferred.ownerRef;
    item.fields[WORKSET_OWNER_EDGE_KIND_FIELD] = inferred.edgeKind;
  }
  return parsed;
}

/** Parse, reconcile, and re-serialize only the dump files that contain items. */
export function serializeReconciledOwnershipDump(
  parsed: ParsedDump,
  dump: readonly BackupDumpFile[],
): BackupDumpFile[] {
  const replacements = new Map<string, string>();
  for (const [ledgerId, ledger] of parsed.ledgers) {
    replacements.set(`${ledgerId}.md`, serializeLedger(ledger));
    const archive = parsed.archives.get(ledgerId);
    for (const pointer of ledger.archivePointers) {
      const content = archive?.get(pointer.id);
      if (content === undefined) {
        throw new LedgerError(`restore: dump is missing archive content ${ledgerId}:${pointer.id}`);
      }
      replacements.set(
        pointer.path.replace(/^\.\//, ""),
        content.kind === "item"
          ? serializeMilestoneItemArchive(content.item)
          : serializeArchive(content.milestone),
      );
    }
  }
  return dump.map((file) => ({
    path: file.path,
    content: replacements.get(file.path) ?? file.content,
  }));
}
