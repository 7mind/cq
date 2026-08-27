import {
  GOALS_LEDGER,
  HANDOFFS_LEDGER,
  isIsoTimestamp,
  OPERATOR_ACTIONS_LEDGER,
  TASKS_LEDGER,
} from "./constants.js";
import type { LedgerStore } from "./store/LedgerStore.js";
import type { Item } from "./types.js";
import { DuplicateIdError, LedgerError, SchemaValidationError } from "./types.js";

export { operatorActionRevision } from "./store/operatorActionLifecycle.js";

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
  readonly expectedRevision: number;
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

export type RecordOperatorActionEvidenceResult =
  | { readonly state: "acknowledged" | "verified"; readonly action: Item }
  | { readonly state: "pending"; readonly reason: "probe-failed"; readonly action: Item };

export interface ReviseOperatorActionInput {
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly expectedOutputIdentity: string;
  readonly expectedEvidence: readonly string[];
  readonly revisedAt: string;
  readonly author: string;
  readonly session?: string;
}

export interface RevisedOperatorAction {
  readonly action: Item;
  readonly task: Item;
  readonly handoff: Item;
}

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
  if (!description.startsWith(OPERATOR_ACTION_ENVELOPE_PREFIX)) return null;
  const occurrences = description.split(OPERATOR_ACTION_ENVELOPE_PREFIX).length - 1;
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
    revision: "1",
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
          `Operator action ${action.id} awaits deployment identity ` + input.expectedOutputIdentity,
        flow: "implement",
        ledgerRefs: [
          `${TASKS_LEDGER}:${task.id}`,
          goalRefs[0]!,
          `${OPERATOR_ACTIONS_LEDGER}:${action.id}`,
        ],
        handoffReasons: [`Deploy ${input.expectedOutputIdentity} and acknowledge ${action.id}`],
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
      throw new OperatorActionConflictError(
        action.id,
        `handoff id ${handoff.id} belongs elsewhere`,
      );
    }
  }
  return { state, action, handoff };
}

export async function acknowledgeOperatorAction(
  store: LedgerStore,
  input: AcknowledgeOperatorActionInput,
): Promise<AcknowledgeOperatorActionResult> {
  assertRevision(input.expectedRevision);
  if (!isIsoTimestamp(input.acknowledgedAt)) {
    throw new SchemaValidationError("acknowledgedAt must be an ISO timestamp");
  }
  const result = await store.mutateOperatorAction({ kind: "acknowledge", ...input });
  if (result.kind !== "acknowledge") throw new LedgerError("unexpected lifecycle result");
  if (result.state === "pending") {
    return { state: "pending", reason: "identity-mismatch", action: result.action };
  }
  return { state: result.state, action: result.action };
}

export async function recordOperatorActionEvidence(
  store: LedgerStore,
  actionId: string,
  expectedRevision: number,
  evidence: OperatorActionShellEvidence,
  provenance: { readonly author: string; readonly session?: string },
): Promise<RecordOperatorActionEvidenceResult> {
  assertRevision(expectedRevision);
  assertEvidenceBounds(evidence);
  const result = await store.mutateOperatorAction({
    kind: "record-evidence",
    actionId,
    expectedRevision,
    evidence,
    provenance,
  });
  if (result.kind !== "record-evidence") throw new LedgerError("unexpected lifecycle result");
  if (result.state === "pending") {
    return { state: "pending", reason: "probe-failed", action: result.action };
  }
  return { state: result.state, action: result.action };
}

export async function reviseOperatorAction(
  store: LedgerStore,
  input: ReviseOperatorActionInput,
): Promise<RevisedOperatorAction> {
  assertRevision(input.expectedRevision);
  assertNonEmpty(input.expectedOutputIdentity, "expectedOutputIdentity");
  assertExpectedEvidence(input.expectedEvidence);
  if (!isIsoTimestamp(input.revisedAt)) {
    throw new SchemaValidationError("revisedAt must be an ISO timestamp");
  }
  const result = await store.mutateOperatorAction({
    kind: "revise",
    actionId: input.actionId,
    expectedRevision: input.expectedRevision,
    expectedOutputIdentity: input.expectedOutputIdentity,
    expectedEvidence: input.expectedEvidence,
    revisedAt: input.revisedAt,
    provenance: {
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    },
  });
  if (result.kind !== "revise") throw new LedgerError("unexpected lifecycle result");
  return { action: result.action, task: result.task, handoff: result.handoff };
}

export async function completeOperatorActionTask(
  store: LedgerStore,
  actionId: string,
  expectedRevision: number,
  completion: string,
  provenance: { readonly author: string; readonly session?: string },
): Promise<Item> {
  assertRevision(expectedRevision);
  assertNonEmpty(completion, "completion");
  const result = await store.mutateOperatorAction({
    kind: "complete",
    actionId,
    expectedRevision,
    completion,
    provenance,
  });
  if (result.kind !== "complete") throw new LedgerError("unexpected lifecycle result");
  return result.task;
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
    if (field === "revision" && value === "1" && action.fields[field] === undefined) continue;
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
  if (
    byteLength(evidence.stdout) > MAX_STREAM_BYTES ||
    byteLength(evidence.stderr) > MAX_STREAM_BYTES
  ) {
    throw new SchemaValidationError("stdout/stderr exceeds 65536 bytes");
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) throw new SchemaValidationError(`${name} must not be empty`);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SchemaValidationError("expectedRevision must be a positive safe integer");
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
