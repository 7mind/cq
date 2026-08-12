import {
  HANDOFFS_LEDGER,
  OPERATOR_ACTION_ACKNOWLEDGEMENT_EPOCH_FIELD,
  OPERATOR_ACTIONS_LEDGER,
  TASKS_LEDGER,
} from "../constants.js";
import type { Item, Ledger } from "../types.js";
import { ItemNotFoundError, LedgerError, SchemaValidationError } from "../types.js";

export interface OperatorActionLifecycleProvenance {
  readonly author: string;
  readonly session?: string;
}

export interface OperatorActionLifecycleEvidence {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly outputIdentity: string;
  readonly observedAt: string;
}

interface StoredOperatorActionEvidence extends OperatorActionLifecycleEvidence {
  readonly acknowledgementEpoch: string;
  readonly revision: number;
}

export type OperatorActionLifecycleMutation =
  | {
      readonly kind: "acknowledge";
      readonly actionId: string;
      readonly expectedRevision: number;
      readonly outputIdentity: string;
      readonly acknowledgedAt: string;
      readonly session?: string;
    }
  | {
      readonly kind: "record-evidence";
      readonly actionId: string;
      readonly expectedRevision: number;
      readonly evidence: OperatorActionLifecycleEvidence;
      readonly provenance: OperatorActionLifecycleProvenance;
    }
  | {
      readonly kind: "revise";
      readonly actionId: string;
      readonly expectedRevision: number;
      readonly expectedOutputIdentity: string;
      readonly expectedEvidence: readonly string[];
      readonly revisedAt: string;
      readonly provenance: OperatorActionLifecycleProvenance;
    }
  | {
      readonly kind: "complete";
      readonly actionId: string;
      readonly expectedRevision: number;
      readonly completion: string;
      readonly provenance: OperatorActionLifecycleProvenance;
    };

export type OperatorActionLifecycleMutationResult =
  | {
      readonly kind: "acknowledge";
      readonly state: "acknowledged" | "verified" | "pending";
      readonly reason?: "identity-mismatch";
      readonly action: Item;
    }
  | {
      readonly kind: "record-evidence";
      readonly state: "acknowledged" | "verified" | "pending";
      readonly reason?: "probe-failed";
      readonly action: Item;
    }
  | {
      readonly kind: "revise";
      readonly action: Item;
      readonly task: Item;
      readonly handoff: Item;
    }
  | { readonly kind: "complete"; readonly action: Item; readonly task: Item };

export interface OperatorActionLifecycleMutationOutcome {
  readonly result: OperatorActionLifecycleMutationResult;
  readonly dirtyLedgers: readonly string[];
}

export function applyOperatorActionLifecycleMutation(
  ledgers: Map<string, Ledger>,
  mutation: OperatorActionLifecycleMutation,
  now: () => string,
): OperatorActionLifecycleMutationOutcome {
  assertRevision(mutation.expectedRevision);
  const action = findMutableItem(ledgers, OPERATOR_ACTIONS_LEDGER, mutation.actionId);
  const revision = operatorActionRevision(action);
  if (revision !== mutation.expectedRevision) {
    throw new LedgerError(
      `Operator action ${action.id} revision conflict: expected ${String(mutation.expectedRevision)}, current ${String(revision)}`,
    );
  }
  switch (mutation.kind) {
    case "acknowledge":
      return acknowledge(action, revision, mutation, now);
    case "record-evidence":
      return recordEvidence(action, revision, mutation, now);
    case "revise":
      return revise(ledgers, action, revision, mutation, now);
    case "complete":
      return complete(ledgers, action, revision, mutation, now);
  }
}

export function operatorActionRevision(action: Item): number {
  const value = action.fields["revision"];
  if (value === undefined) return 1;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new SchemaValidationError("stored operator-action revision is malformed");
  }
  const revision = Number(value);
  assertRevision(revision);
  return revision;
}

function acknowledge(
  action: Item,
  revision: number,
  mutation: Extract<OperatorActionLifecycleMutation, { kind: "acknowledge" }>,
  now: () => string,
): OperatorActionLifecycleMutationOutcome {
  if (action.status === "verified") {
    return {
      result: { kind: "acknowledge", state: "verified", action: cloneItem(action) },
      dirtyLedgers: [],
    };
  }
  if (mutation.outputIdentity !== stringField(action, "expectedOutputIdentity")) {
    return {
      result: {
        kind: "acknowledge",
        state: "pending",
        reason: "identity-mismatch",
        action: cloneItem(action),
      },
      dirtyLedgers: [],
    };
  }
  if (action.status !== "pending" && action.status !== "acknowledged") {
    throw new LedgerError(`Operator action ${action.id} cannot be acknowledged from ${action.status}`);
  }
  const acknowledgementEpoch = acknowledgementEpochForExactReplay(action);
  action.status = "acknowledged";
  action.fields["revision"] = String(revision);
  action.fields["acknowledgedOutputIdentity"] = mutation.outputIdentity;
  action.fields["acknowledgedAt"] = mutation.acknowledgedAt;
  action.fields[OPERATOR_ACTION_ACKNOWLEDGEMENT_EPOCH_FIELD] = acknowledgementEpoch;
  applyProvenance(
    action,
    {
      author: "user",
      ...(mutation.session === undefined ? {} : { session: mutation.session }),
    },
    now(),
  );
  return {
    result: { kind: "acknowledge", state: "acknowledged", action: cloneItem(action) },
    dirtyLedgers: [OPERATOR_ACTIONS_LEDGER],
  };
}

function recordEvidence(
  action: Item,
  revision: number,
  mutation: Extract<OperatorActionLifecycleMutation, { kind: "record-evidence" }>,
  now: () => string,
): OperatorActionLifecycleMutationOutcome {
  if (action.status !== "acknowledged") {
    throw new LedgerError(`Operator action ${action.id} is not acknowledged`);
  }
  const acknowledgementEpoch = stringField(
    action,
    OPERATOR_ACTION_ACKNOWLEDGEMENT_EPOCH_FIELD,
  );
  if (acknowledgementEpoch.length === 0) {
    throw new LedgerError(`Operator action ${action.id} has no acknowledgement epoch`);
  }
  const expectedCommands = stringArray(action.fields["expectedEvidence"]);
  if (!expectedCommands.includes(mutation.evidence.command)) {
    throw new LedgerError(
      `Operator action ${action.id} did not declare command ${mutation.evidence.command}`,
    );
  }
  const prior = stringArray(action.fields["evidence"]);
  const stored: StoredOperatorActionEvidence = {
    ...mutation.evidence,
    acknowledgementEpoch,
    revision,
  };
  const encoded = JSON.stringify(stored);
  const identityMatches =
    mutation.evidence.outputIdentity === stringField(action, "expectedOutputIdentity") &&
    mutation.evidence.outputIdentity === stringField(action, "acknowledgedOutputIdentity");
  if (mutation.evidence.exitCode !== 0 || !identityMatches) {
    action.status = "pending";
    action.fields["evidence"] = [...prior, encoded];
    action.fields["lastFailure"] = encoded;
    applyProvenance(action, mutation.provenance, now());
    return {
      result: {
        kind: "record-evidence",
        state: "pending",
        reason: "probe-failed",
        action: cloneItem(action),
      },
      dirtyLedgers: [OPERATOR_ACTIONS_LEDGER],
    };
  }
  const entries = [...prior.map(parseEvidence), stored];
  const expectedIdentity = stringField(action, "expectedOutputIdentity");
  const complete = expectedCommands.every((command) =>
    entries.some(
      (entry) =>
        entry.command === command &&
        entry.exitCode === 0 &&
        entry.revision === revision &&
        entry.acknowledgementEpoch === acknowledgementEpoch &&
        entry.outputIdentity === expectedIdentity,
    ),
  );
  action.status = complete ? "verified" : "acknowledged";
  action.fields["evidence"] = [...prior, encoded];
  if (complete) {
    action.fields["verifiedAt"] = mutation.evidence.observedAt;
    action.fields["verifiedRevision"] = String(revision);
  }
  applyProvenance(action, mutation.provenance, now());
  return {
    result: {
      kind: "record-evidence",
      state: complete ? "verified" : "acknowledged",
      action: cloneItem(action),
    },
    dirtyLedgers: [OPERATOR_ACTIONS_LEDGER],
  };
}

function revise(
  ledgers: Map<string, Ledger>,
  action: Item,
  revision: number,
  mutation: Extract<OperatorActionLifecycleMutation, { kind: "revise" }>,
  now: () => string,
): OperatorActionLifecycleMutationOutcome {
  if (action.status !== "pending" && action.status !== "acknowledged") {
    throw new LedgerError(
      `Operator action ${action.id} may be revised only while pending or acknowledged`,
    );
  }
  assertRevisionEvidenceState(action, revision);
  const taskId = referencedId(action, "taskRef", TASKS_LEDGER);
  const task = findMutableItem(ledgers, TASKS_LEDGER, taskId);
  const handoff = findMutableItem(ledgers, HANDOFFS_LEDGER, handoffIdForTask(taskId));
  if (task.status !== "planned" && task.status !== "abandoned") {
    throw new LedgerError(
      `Operator-action task ${task.id} may be revised only from planned or abandoned`,
    );
  }
  if (
    action.milestoneId !== task.milestoneId ||
    handoff.milestoneId !== task.milestoneId ||
    handoff.status !== "user-action-required"
  ) {
    throw new LedgerError(
      `Operator action ${action.id} may be revised only with a safe task and handoff state`,
    );
  }
  const history =
    action.fields["revisionHistory"] === undefined
      ? []
      : storedStringArrayField(action, "revisionHistory");
  action.fields["revisionHistory"] = [
    ...history,
    JSON.stringify({
      revision,
      action: snapshotWithoutHistory(action),
      task: cloneItem(task),
      handoff: cloneItem(handoff),
    }),
  ];
  action.status = "pending";
  action.fields["revision"] = String(revision + 1);
  action.fields["expectedOutputIdentity"] = mutation.expectedOutputIdentity;
  action.fields["expectedEvidence"] = [...mutation.expectedEvidence];
  for (const field of [
    "acknowledgedOutputIdentity",
    "acknowledgedAt",
    OPERATOR_ACTION_ACKNOWLEDGEMENT_EPOCH_FIELD,
    "evidence",
    "lastFailure",
    "verifiedAt",
    "verifiedRevision",
    "completion",
  ]) {
    delete action.fields[field];
  }
  applyProvenance(action, mutation.provenance, mutation.revisedAt);

  task.status = "planned";
  delete task.fields["completion"];
  applyProvenance(task, mutation.provenance, mutation.revisedAt);

  handoff.status = "user-action-required";
  handoff.fields["summary"] =
    `Operator action ${action.id} revision ${String(revision + 1)} awaits deployment identity ` +
    mutation.expectedOutputIdentity;
  handoff.fields["handoffReasons"] = [
    `Deploy ${mutation.expectedOutputIdentity} and acknowledge ${action.id} revision ${String(revision + 1)}`,
  ];
  applyProvenance(handoff, mutation.provenance, mutation.revisedAt);
  void now;
  return {
    result: {
      kind: "revise",
      action: cloneItem(action),
      task: cloneItem(task),
      handoff: cloneItem(handoff),
    },
    dirtyLedgers: [OPERATOR_ACTIONS_LEDGER, TASKS_LEDGER, HANDOFFS_LEDGER],
  };
}

function complete(
  ledgers: Map<string, Ledger>,
  action: Item,
  revision: number,
  mutation: Extract<OperatorActionLifecycleMutation, { kind: "complete" }>,
  now: () => string,
): OperatorActionLifecycleMutationOutcome {
  if (action.status !== "verified") {
    throw new LedgerError(`Operator action ${action.id} is not verified`);
  }
  const verifiedRevision = action.fields["verifiedRevision"];
  if (verifiedRevision !== undefined && verifiedRevision !== String(revision)) {
    throw new LedgerError(`Operator action ${action.id} verification belongs to another revision`);
  }
  const task = findMutableItem(
    ledgers,
    TASKS_LEDGER,
    referencedId(action, "taskRef", TASKS_LEDGER),
  );
  if (task.status !== "planned") {
    throw new LedgerError(`Operator-action task ${task.id} is not planned`);
  }
  action.fields["completion"] = mutation.completion;
  applyProvenance(action, mutation.provenance, now());
  task.status = "done";
  task.fields["completion"] = mutation.completion;
  applyProvenance(task, mutation.provenance, now());
  return {
    result: { kind: "complete", action: cloneItem(action), task: cloneItem(task) },
    dirtyLedgers: [OPERATOR_ACTIONS_LEDGER, TASKS_LEDGER],
  };
}

function findMutableItem(ledgers: Map<string, Ledger>, ledgerId: string, itemId: string): Item {
  const ledger = ledgers.get(ledgerId);
  if (ledger === undefined) throw new LedgerError(`ledger not found: ${ledgerId}`);
  for (const milestone of ledger.milestones) {
    const item = milestone.items.find((candidate) => candidate.id === itemId);
    if (item !== undefined) return item;
  }
  throw new ItemNotFoundError(ledgerId, itemId);
}

function referencedId(action: Item, field: string, ledgerId: string): string {
  const value = stringField(action, field);
  const prefix = `${ledgerId}:`;
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    throw new LedgerError(`Operator action ${action.id} has an invalid ${field}`);
  }
  return value.slice(prefix.length);
}

function handoffIdForTask(taskId: string): string {
  const match = /^T(\d+)$/.exec(taskId);
  if (match?.[1] === undefined) {
    throw new LedgerError(`Operator-action task ${taskId} cannot derive a handoff id`);
  }
  return `HO${match[1]}`;
}

function acknowledgementEpochForExactReplay(action: Item): string {
  const current = stringField(action, OPERATOR_ACTION_ACKNOWLEDGEMENT_EPOCH_FIELD);
  if (action.status === "acknowledged" && current.length > 0) return current;
  if (current.length === 0) return "1";
  if (!/^[1-9]\d*$/.test(current)) {
    throw new SchemaValidationError("stored acknowledgement epoch is malformed");
  }
  const parsed = Number(current);
  if (!Number.isSafeInteger(parsed) || parsed === Number.MAX_SAFE_INTEGER) {
    throw new SchemaValidationError("stored acknowledgement epoch exceeds the safe range");
  }
  return String(parsed + 1);
}

function parseEvidence(value: string): StoredOperatorActionEvidence {
  const parsed = JSON.parse(value) as Partial<StoredOperatorActionEvidence>;
  if (
    typeof parsed.command !== "string" ||
    typeof parsed.stdout !== "string" ||
    typeof parsed.stderr !== "string" ||
    typeof parsed.exitCode !== "number" ||
    typeof parsed.outputIdentity !== "string" ||
    typeof parsed.observedAt !== "string" ||
    typeof parsed.acknowledgementEpoch !== "string" ||
    typeof parsed.revision !== "number"
  ) {
    throw new SchemaValidationError("stored operator-action evidence is malformed");
  }
  return parsed as StoredOperatorActionEvidence;
}

function assertRevisionEvidenceState(action: Item, revision: number): void {
  const rawEvidence = action.fields["evidence"];
  const rawLastFailure = action.fields["lastFailure"];
  if (rawEvidence === undefined) {
    if (rawLastFailure !== undefined) {
      throw new LedgerError(
        `Operator action ${action.id} has inconsistent failed-evidence audit state`,
      );
    }
    return;
  }
  if (!Array.isArray(rawEvidence) || rawEvidence.some((entry) => typeof entry !== "string")) {
    throw new SchemaValidationError("stored operator-action evidence is malformed");
  }
  if (rawEvidence.length === 0) {
    if (rawLastFailure !== undefined) {
      throw new LedgerError(
        `Operator action ${action.id} has inconsistent failed-evidence audit state`,
      );
    }
    return;
  }
  if (action.status !== "pending" || typeof rawLastFailure !== "string") {
    throw new LedgerError(
      `Operator action ${action.id} may not be revised after evidence without a terminal failure`,
    );
  }
  const evidence = rawEvidence.map(parseEvidence);
  const terminal = evidence[evidence.length - 1]!;
  const lastFailure = parseEvidence(rawLastFailure);
  if (
    rawLastFailure !== rawEvidence[rawEvidence.length - 1] ||
    JSON.stringify(lastFailure) !== JSON.stringify(terminal)
  ) {
    throw new LedgerError(
      `Operator action ${action.id} has inconsistent failed-evidence audit state`,
    );
  }
  const acknowledgementEpoch = positiveIntegerStringField(
    action,
    OPERATOR_ACTION_ACKNOWLEDGEMENT_EPOCH_FIELD,
  );
  if (
    terminal.revision !== revision ||
    terminal.acknowledgementEpoch !== acknowledgementEpoch
  ) {
    throw new LedgerError(`Operator action ${action.id} has stale failed-evidence audit state`);
  }
  const expectedOutputIdentity = stringField(action, "expectedOutputIdentity");
  const acknowledgedOutputIdentity = stringField(action, "acknowledgedOutputIdentity");
  const expectedEvidence = storedStringArrayField(action, "expectedEvidence");
  if (
    expectedOutputIdentity.length === 0 ||
    acknowledgedOutputIdentity.length === 0 ||
    !expectedEvidence.includes(terminal.command)
  ) {
    throw new LedgerError(
      `Operator action ${action.id} has inconsistent failed-evidence audit state`,
    );
  }
  const terminalFailed =
    terminal.exitCode !== 0 ||
    terminal.outputIdentity !== expectedOutputIdentity ||
    terminal.outputIdentity !== acknowledgedOutputIdentity;
  if (!terminalFailed) {
    throw new LedgerError(
      `Operator action ${action.id} may not be revised after successful evidence`,
    );
  }
}

function positiveIntegerStringField(item: Item, field: string): string {
  const value = item.fields[field];
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new SchemaValidationError(`stored ${field} is malformed`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new SchemaValidationError(`stored ${field} exceeds the safe range`);
  }
  return value;
}

function snapshotWithoutHistory(action: Item): Item {
  const snapshot = cloneItem(action);
  delete snapshot.fields["revisionHistory"];
  return snapshot;
}

function applyProvenance(
  item: Item,
  provenance: { readonly author: string; readonly session?: string },
  at: string,
): void {
  item.updatedAt = at;
  item.author = provenance.author;
  if (provenance.session !== undefined) item.session = provenance.session;
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SchemaValidationError("expected revision must be a positive safe integer");
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function storedStringArrayField(item: Item, field: string): string[] {
  const value = item.fields[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new SchemaValidationError(`stored ${field} is malformed`);
  }
  return value;
}

function stringField(item: Item, field: string): string {
  const value = item.fields[field];
  return typeof value === "string" ? value : "";
}

function cloneItem(item: Item): Item {
  return JSON.parse(JSON.stringify(item)) as Item;
}
