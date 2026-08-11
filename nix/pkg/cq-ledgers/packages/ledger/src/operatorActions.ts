import {
  GOALS_LEDGER,
  HANDOFFS_LEDGER,
  isIsoTimestamp,
  OPERATOR_ACTION_ACKNOWLEDGEMENT_EPOCH_FIELD,
  OPERATOR_ACTIONS_LEDGER,
  TASKS_LEDGER,
} from "./constants.js";
import type { LedgerStore, UpdateItemPatch } from "./store/LedgerStore.js";
import type { Item } from "./types.js";
import { DuplicateIdError, LedgerError, SchemaValidationError } from "./types.js";

export const OPERATOR_ACTION_ENVELOPE_PREFIX = "CQ-OPERATOR-ACTION" as const;
export const OPERATOR_ACTION_ENVELOPE_VERSION = "v1" as const;

const OPERATOR_ACTION_ENVELOPE_RE =
  /^CQ-OPERATOR-ACTION v1 ([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\.(?:\s|$)/;
const MAX_COMMAND_BYTES = 4096;
const MAX_STREAM_BYTES = 65_536;
const authorizedCompletionPatches = new WeakSet<object>();
const authorizedActionMutations = new WeakSet<object>();

export interface OperatorActionDirective {
  readonly version: "v1";
  readonly actionKey: string;
}

export interface MaterializeOperatorActionInput {
  readonly taskId: string;
  readonly expectedOutputIdentity: string;
  readonly expectedEvidence: readonly string[];
  readonly author?: string;
  readonly session?: string;
}

export interface MaterializedOperatorAction {
  readonly state: "created" | "existing";
  readonly action: Item;
  readonly handoff: Item;
}

export interface AcknowledgeOperatorActionInput {
  readonly actionId: string;
  readonly outputIdentity: string;
  readonly acknowledgedAt: string;
  readonly session?: string;
}

export type AcknowledgeOperatorActionResult =
  | { readonly state: "acknowledged"; readonly action: Item }
  | { readonly state: "verified"; readonly action: Item }
  | { readonly state: "pending"; readonly reason: "identity-mismatch"; readonly action: Item };

export interface OperatorActionShellEvidence {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly outputIdentity: string;
  readonly observedAt: string;
}

interface StoredOperatorActionShellEvidence extends OperatorActionShellEvidence {
  readonly acknowledgementEpoch: string;
}

export type RecordOperatorActionEvidenceResult =
  | { readonly state: "acknowledged" | "verified"; readonly action: Item }
  | { readonly state: "pending"; readonly reason: "probe-failed"; readonly action: Item };

export class OperatorActionEnvelopeError extends SchemaValidationError {
  constructor(reason: string) {
    super(`operator-action envelope: ${reason}`);
    this.name = "OperatorActionEnvelopeError";
  }
}

export class OperatorActionConflictError extends LedgerError {
  constructor(actionId: string, reason: string) {
    super(`Operator action ${actionId} conflicts with the requested materialization: ${reason}`);
    this.name = "OperatorActionConflictError";
  }
}

/** Internal cross-adapter completion authority consumed by store/core.ts. */
export function isAuthorizedOperatorActionCompletionPatch(patch: object): boolean {
  return authorizedCompletionPatches.has(patch);
}

/** Internal authority for canonical operatorActions creates/updates. */
export function isAuthorizedOperatorActionMutation(mutation: object): boolean {
  return authorizedActionMutations.has(mutation);
}

export function parseOperatorActionEnvelope(description: string): OperatorActionDirective | null {
  const occurrences = description.split(OPERATOR_ACTION_ENVELOPE_PREFIX).length - 1;
  if (occurrences === 0) return null;
  if (occurrences !== 1) {
    throw new OperatorActionEnvelopeError("exactly one envelope is required");
  }
  const match = OPERATOR_ACTION_ENVELOPE_RE.exec(description);
  if (match === null || match[1] === undefined) {
    throw new OperatorActionEnvelopeError(
      "expected `CQ-OPERATOR-ACTION v1 <action-key>.` at description start",
    );
  }
  return { version: OPERATOR_ACTION_ENVELOPE_VERSION, actionKey: match[1] };
}

export function operatorActionDirectiveForTask(task: Item): OperatorActionDirective | null {
  const description = task.fields["description"];
  return parseOperatorActionEnvelope(typeof description === "string" ? description : "");
}

export async function materializeOperatorAction(
  store: LedgerStore,
  input: MaterializeOperatorActionInput,
): Promise<MaterializedOperatorAction> {
  assertNonEmpty(input.expectedOutputIdentity, "expectedOutputIdentity");
  assertExpectedEvidence(input.expectedEvidence);
  const task = store.fetchItem(TASKS_LEDGER, input.taskId);
  if (task.status !== "planned") {
    throw new LedgerError(`Operator-action task ${task.id} must remain planned until verification`);
  }
  const directive = operatorActionDirectiveForTask(task);
  if (directive === null) {
    throw new OperatorActionEnvelopeError(`task ${task.id} has no envelope`);
  }
  const goalRefs = stringArray(task.fields["ledgerRefs"]).filter((ref) =>
    ref.startsWith(`${GOALS_LEDGER}:`),
  );
  if (goalRefs.length !== 1) {
    throw new OperatorActionEnvelopeError(
      `task ${task.id} must link exactly one goal (found ${String(goalRefs.length)})`,
    );
  }
  const actionId = actionIdForTask(task.id);
  const expectedFields = {
    actionKey: directive.actionKey,
    summary: `Operator action ${directive.actionKey}`,
    taskRef: `${TASKS_LEDGER}:${task.id}`,
    goalRef: goalRefs[0]!,
    expectedOutputIdentity: input.expectedOutputIdentity,
    expectedEvidence: [...input.expectedEvidence],
    ledgerRefs: [`${TASKS_LEDGER}:${task.id}`, goalRefs[0]!],
  };

  let action: Item;
  let state: MaterializedOperatorAction["state"] = "created";
  try {
    const init = {
      id: actionId,
      status: "pending",
      fields: expectedFields,
      ...(input.author === undefined ? {} : { author: input.author }),
      ...(input.session === undefined ? {} : { session: input.session }),
    } as const;
    authorizedActionMutations.add(init);
    action = await store.createItem(OPERATOR_ACTIONS_LEDGER, task.milestoneId, init);
  } catch (error) {
    if (!(error instanceof DuplicateIdError)) throw error;
    state = "existing";
    action = store.fetchItem(OPERATOR_ACTIONS_LEDGER, actionId);
    assertExistingActionMatches(action, task, expectedFields);
  }

  const handoffId = handoffIdForTask(task.id);
  let handoff: Item;
  try {
    handoff = await store.createItem(HANDOFFS_LEDGER, task.milestoneId, {
      id: handoffId,
      status: "user-action-required",
      fields: {
        summary:
          `Operator action ${action.id} awaits deployment identity ` +
          input.expectedOutputIdentity,
        flow: "implement",
        ledgerRefs: [
          `${TASKS_LEDGER}:${task.id}`,
          goalRefs[0]!,
          `${OPERATOR_ACTIONS_LEDGER}:${action.id}`,
        ],
        handoffReasons: [
          `Deploy ${input.expectedOutputIdentity} and acknowledge ${action.id}`,
        ],
        tags: ["operator-action", directive.actionKey],
      },
      ...(input.author === undefined ? {} : { author: input.author }),
      ...(input.session === undefined ? {} : { session: input.session }),
    });
  } catch (error) {
    if (!(error instanceof DuplicateIdError)) throw error;
    handoff = store.fetchItem(HANDOFFS_LEDGER, handoffId);
    const refs = stringArray(handoff.fields["ledgerRefs"]);
    if (!refs.includes(`${OPERATOR_ACTIONS_LEDGER}:${action.id}`)) {
      throw new OperatorActionConflictError(action.id, `handoff id ${handoff.id} belongs elsewhere`);
    }
  }
  return { state, action, handoff };
}

export async function acknowledgeOperatorAction(
  store: LedgerStore,
  input: AcknowledgeOperatorActionInput,
): Promise<AcknowledgeOperatorActionResult> {
  const action = store.fetchItem(OPERATOR_ACTIONS_LEDGER, input.actionId);
  if (action.status === "verified") return { state: "verified", action };
  const expectedIdentity = stringField(action, "expectedOutputIdentity");
  if (input.outputIdentity !== expectedIdentity) {
    return { state: "pending", reason: "identity-mismatch", action };
  }
  const patch: UpdateItemPatch = {
    status: action.status === "pending" ? "acknowledged" : action.status,
    fields: {
      acknowledgedOutputIdentity: input.outputIdentity,
      acknowledgedAt: input.acknowledgedAt,
      [OPERATOR_ACTION_ACKNOWLEDGEMENT_EPOCH_FIELD]: acknowledgementEpochForExactReplay(action),
    },
    author: "user",
    ...(input.session === undefined ? {} : { session: input.session }),
  };
  authorizedActionMutations.add(patch);
  const updated = await store.updateItem(OPERATOR_ACTIONS_LEDGER, action.id, patch);
  return { state: "acknowledged", action: updated };
}

export async function recordOperatorActionEvidence(
  store: LedgerStore,
  actionId: string,
  evidence: OperatorActionShellEvidence,
  provenance: { readonly author: string; readonly session?: string },
): Promise<RecordOperatorActionEvidenceResult> {
  assertEvidenceBounds(evidence);
  const action = store.fetchItem(OPERATOR_ACTIONS_LEDGER, actionId);
  if (action.status !== "acknowledged") {
    throw new LedgerError(`Operator action ${action.id} is not acknowledged`);
  }
  const prior = stringArray(action.fields["evidence"]);
  const decoded = prior.map(parseEvidence);
  const acknowledgementEpoch = stringField(
    action,
    OPERATOR_ACTION_ACKNOWLEDGEMENT_EPOCH_FIELD,
  );
  if (acknowledgementEpoch.length === 0) {
    throw new LedgerError(`Operator action ${action.id} has no acknowledgement epoch`);
  }
  const expectedCommands = stringArray(action.fields["expectedEvidence"]);
  if (!expectedCommands.includes(evidence.command)) {
    throw new LedgerError(`Operator action ${action.id} did not declare command ${evidence.command}`);
  }
  const storedEvidence: StoredOperatorActionShellEvidence = {
    ...evidence,
    acknowledgementEpoch,
  };
  const encoded = JSON.stringify(storedEvidence);
  const identityMatches =
    evidence.outputIdentity === stringField(action, "expectedOutputIdentity") &&
    evidence.outputIdentity === stringField(action, "acknowledgedOutputIdentity");
  if (evidence.exitCode !== 0 || !identityMatches) {
    const patch: UpdateItemPatch = {
      status: "pending",
      fields: { evidence: [...prior, encoded], lastFailure: encoded },
      author: provenance.author,
      ...(provenance.session === undefined ? {} : { session: provenance.session }),
    };
    authorizedActionMutations.add(patch);
    const updated = await store.updateItem(OPERATOR_ACTIONS_LEDGER, action.id, patch);
    return { state: "pending", reason: "probe-failed", action: updated };
  }
  const evidenceEntries = [...decoded, storedEvidence];
  const expectedIdentity = stringField(action, "expectedOutputIdentity");
  const complete = expectedCommands.every((command) =>
    evidenceEntries.some(
      (entry) =>
        entry.command === command &&
        entry.exitCode === 0 &&
        entry.acknowledgementEpoch === acknowledgementEpoch &&
        entry.outputIdentity === expectedIdentity,
    ),
  );
  const patch: UpdateItemPatch = {
    status: complete ? "verified" : "acknowledged",
    fields: {
      evidence: [...prior, encoded],
      ...(complete ? { verifiedAt: evidence.observedAt } : {}),
    },
    author: provenance.author,
    ...(provenance.session === undefined ? {} : { session: provenance.session }),
  };
  authorizedActionMutations.add(patch);
  const updated = await store.updateItem(OPERATOR_ACTIONS_LEDGER, action.id, patch);
  return { state: complete ? "verified" : "acknowledged", action: updated };
}

export async function completeOperatorActionTask(
  store: LedgerStore,
  actionId: string,
  completion: string,
  provenance: { readonly author: string; readonly session?: string },
): Promise<Item> {
  assertNonEmpty(completion, "completion");
  const action = store.fetchItem(OPERATOR_ACTIONS_LEDGER, actionId);
  if (action.status !== "verified") {
    throw new LedgerError(`Operator action ${action.id} is not verified`);
  }
  const taskRef = stringField(action, "taskRef");
  if (!taskRef.startsWith(`${TASKS_LEDGER}:`)) {
    throw new LedgerError(`Operator action ${action.id} has an invalid taskRef`);
  }
  const taskId = taskRef.slice(TASKS_LEDGER.length + 1);
  const actionPatch: UpdateItemPatch = {
    fields: { completion },
    author: provenance.author,
    ...(provenance.session === undefined ? {} : { session: provenance.session }),
  };
  authorizedActionMutations.add(actionPatch);
  await store.updateItem(OPERATOR_ACTIONS_LEDGER, action.id, actionPatch);
  const taskPatch: UpdateItemPatch = {
    status: "done",
    fields: { completion },
    author: provenance.author,
    ...(provenance.session === undefined ? {} : { session: provenance.session }),
  };
  authorizedCompletionPatches.add(taskPatch);
  return await store.updateItem(TASKS_LEDGER, taskId, taskPatch);
}

function actionIdForTask(taskId: string): string {
  const match = /^T(\d+)$/.exec(taskId);
  if (match === null || match[1] === undefined) {
    throw new OperatorActionEnvelopeError(`task id ${taskId} cannot derive an action id`);
  }
  return `OA${match[1]}`;
}

function handoffIdForTask(taskId: string): string {
  const match = /^T(\d+)$/.exec(taskId);
  if (match === null || match[1] === undefined) {
    throw new OperatorActionEnvelopeError(`task id ${taskId} cannot derive a handoff id`);
  }
  return `HO${match[1]}`;
}

function assertExistingActionMatches(
  action: Item,
  task: Item,
  expected: Record<string, string | string[]>,
): void {
  if (action.milestoneId !== task.milestoneId) {
    throw new OperatorActionConflictError(action.id, "milestone differs");
  }
  for (const [field, value] of Object.entries(expected)) {
    if (JSON.stringify(action.fields[field]) !== JSON.stringify(value)) {
      throw new OperatorActionConflictError(action.id, `${field} differs`);
    }
  }
}

function assertExpectedEvidence(commands: readonly string[]): void {
  if (commands.length === 0 || new Set(commands).size !== commands.length) {
    throw new SchemaValidationError("expectedEvidence must contain unique commands");
  }
  for (const command of commands) {
    assertNonEmpty(command, "expectedEvidence command");
    if (byteLength(command) > MAX_COMMAND_BYTES) {
      throw new SchemaValidationError("expectedEvidence command exceeds 4096 bytes");
    }
  }
}

function assertEvidenceBounds(evidence: OperatorActionShellEvidence): void {
  assertNonEmpty(evidence.command, "command");
  assertNonEmpty(evidence.outputIdentity, "outputIdentity");
  if (!Number.isSafeInteger(evidence.exitCode)) {
    throw new SchemaValidationError("exitCode must be a safe integer");
  }
  if (!isIsoTimestamp(evidence.observedAt)) {
    throw new SchemaValidationError("observedAt must be an ISO timestamp");
  }
  if (byteLength(evidence.command) > MAX_COMMAND_BYTES) {
    throw new SchemaValidationError("command exceeds 4096 bytes");
  }
  if (byteLength(evidence.stdout) > MAX_STREAM_BYTES || byteLength(evidence.stderr) > MAX_STREAM_BYTES) {
    throw new SchemaValidationError("stdout/stderr exceeds 65536 bytes");
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) throw new SchemaValidationError(`${name} must not be empty`);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function acknowledgementEpochForExactReplay(action: Item): string {
  const current = stringField(action, OPERATOR_ACTION_ACKNOWLEDGEMENT_EPOCH_FIELD);
  if (action.status === "acknowledged" && current.length > 0) return current;
  if (current.length === 0) return "1";
  if (!/^[1-9]\d*$/.test(current)) {
    throw new SchemaValidationError(`stored acknowledgement epoch is malformed`);
  }
  const parsed = Number(current);
  if (!Number.isSafeInteger(parsed) || parsed === Number.MAX_SAFE_INTEGER) {
    throw new SchemaValidationError(`stored acknowledgement epoch exceeds the safe range`);
  }
  return String(parsed + 1);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringField(item: Item, field: string): string {
  const value = item.fields[field];
  return typeof value === "string" ? value : "";
}

function parseEvidence(value: string): Partial<StoredOperatorActionShellEvidence> & OperatorActionShellEvidence {
  const parsed = JSON.parse(value) as Partial<StoredOperatorActionShellEvidence>;
  if (
    typeof parsed.command !== "string" ||
    typeof parsed.stdout !== "string" ||
    typeof parsed.stderr !== "string" ||
    typeof parsed.exitCode !== "number" ||
    typeof parsed.outputIdentity !== "string" ||
    typeof parsed.observedAt !== "string"
  ) {
    throw new SchemaValidationError("stored operator-action evidence is malformed");
  }
  if (
    parsed.acknowledgementEpoch !== undefined &&
    !/^[1-9]\d*$/.test(parsed.acknowledgementEpoch)
  ) {
    throw new SchemaValidationError("stored operator-action acknowledgement epoch is malformed");
  }
  return parsed as Partial<StoredOperatorActionShellEvidence> & OperatorActionShellEvidence;
}
