import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { DispatchHandle, DispatchJSONValue, DispatchPrepared } from "@cq/config";
import type {
  MergeEffectBinding,
  WorksetEffectAdmissionProvider,
  WorksetBrokerAdmissionHandle,
} from "@cq/process-control";
import { Lockfile, type LockfileOpts } from "./store/lockfile.js";
import { REVIEWS_LEDGER, TASKS_LEDGER } from "./constants.js";
import type { CreateItemInit, LedgerStore, UpdateItemPatch } from "./store/LedgerStore.js";
import { DuplicateIdError } from "./types.js";

export const IMPLEMENTATION_EVIDENCE_VERSION = 1 as const;

const FULL_SHA = /^[0-9a-f]{40}$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TASK_REF = /^tasks:(T[0-9]+)$/u;
const COMPLETION_REF = /^cq-implementation-completion:v1:[0-9a-f]{64}$/u;
const PANEL_REF = /^cq-implementation-review-panel:v1:[0-9a-f]{64}$/u;
const ATTEMPT_REF = /^cq-implementation-review-attempt:v1:[0-9a-f]{64}$/u;

export type ImplementationReviewTerminalState =
  "approved" | "disapproved" | "operational-abstention";

export interface ImplementationReviewerIdentity {
  readonly alias: string;
  readonly harness: string;
  readonly model: string;
  readonly provider: string | null;
  readonly effort?: string | null;
  readonly launch: "native" | "adapter";
  readonly adapterId: string;
}

export interface ImplementationReviewPanelRecord {
  readonly version: 1;
  readonly panelRef: string;
  readonly taskRef: string;
  readonly resultCommit: string;
  readonly workerDispatch: DispatchHandle;
  readonly rosterDigest: string;
  readonly roster: readonly ImplementationReviewerIdentity[];
  readonly attemptRefs: readonly string[];
  readonly fallbackAttemptRef: string | null;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly author: string;
  readonly session: string | null;
  readonly createdAt: string;
}

export interface ExternalImplementationReviewExecution {
  readonly executionRef: string;
  readonly adapterIdentity: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly parseResult:
    | { readonly kind: "valid-verdict"; readonly verdict: DispatchJSONValue }
    | {
        readonly kind: "operational-abstention";
        readonly reason: "unavailable" | "failed" | "empty" | "malformed";
        readonly detail: string;
      };
  readonly executedAt: string;
}

export interface ImplementationReviewAttemptRecord {
  readonly version: 1;
  readonly attemptRef: string;
  readonly panelRef: string;
  readonly taskRef: string;
  readonly resultCommit: string;
  readonly position: number;
  readonly identity: ImplementationReviewerIdentity;
  readonly fallback: boolean;
  readonly fallbackTrigger: string | null;
  readonly fallbackExclusions: readonly string[];
  readonly preparedDispatch: DispatchPrepared | null;
  readonly execution: ExternalImplementationReviewExecution | null;
  readonly terminalState: ImplementationReviewTerminalState | null;
  readonly verdictDigest: string | null;
  readonly verdict: DispatchJSONValue | null;
  readonly operations: Readonly<Record<string, string>>;
  readonly author: string;
  readonly session: string | null;
  readonly createdAt: string;
}

export type ImplementationCompletionState =
  "prepared" | "merge-started" | "merged" | "recording" | "superseded" | "recorded";

export interface ImplementationCompletionRecord {
  readonly version: 1;
  readonly completionRef: string;
  readonly taskRef: string;
  readonly ownerGoalRef: string;
  readonly resultCommit: string;
  readonly repositoryHead: string;
  readonly baseCommit: string;
  readonly startingCommit: string;
  readonly workerDispatch: DispatchHandle;
  readonly workerResult: DispatchJSONValue;
  readonly reviewAttemptRefs: readonly string[];
  readonly completion: string;
  readonly logPaths: readonly string[];
  readonly finalizedManifest: string;
  readonly verification: DispatchJSONValue;
  readonly mergeOperationId: string;
  readonly evidenceFingerprint: string;
  readonly supersedesCompletionRef: string | null;
  readonly state: ImplementationCompletionState;
  readonly reviewRef: string | null;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly author: string;
  readonly session: string | null;
  readonly preparedAt: string;
  readonly mergeStartedAt: string | null;
  readonly mergedAt: string | null;
  readonly recordedAt: string | null;
  readonly recordOperationId: string | null;
}

export interface ImplementationEvidenceSnapshot {
  readonly version: 1;
  readonly panels: Readonly<Record<string, ImplementationReviewPanelRecord>>;
  readonly attempts: Readonly<Record<string, ImplementationReviewAttemptRecord>>;
  readonly completions: Readonly<Record<string, ImplementationCompletionRecord>>;
}

interface MutableImplementationEvidenceSnapshot {
  version: 1;
  panels: Record<string, ImplementationReviewPanelRecord>;
  attempts: Record<string, ImplementationReviewAttemptRecord>;
  completions: Record<string, ImplementationCompletionRecord>;
}

const mutateEvidence = Symbol("cq.implementation-evidence.mutate");
const authorizedImplementationEvidenceMutations = new WeakSet<object>();

/** Internal predicate consumed by core's generic-write denial. */
export function isAuthorizedImplementationEvidenceMutation(value: object): boolean {
  return authorizedImplementationEvidenceMutations.has(value);
}

/** Protected store: callers can observe snapshots but cannot obtain a generic write method. */
export interface ImplementationEvidenceStore {
  snapshot(): Promise<ImplementationEvidenceSnapshot>;
  [mutateEvidence]<T>(
    mutation: (draft: MutableImplementationEvidenceSnapshot) => T | Promise<T>,
  ): Promise<T>;
}

function emptyState(): MutableImplementationEvidenceSnapshot {
  return { version: IMPLEMENTATION_EVIDENCE_VERSION, panels: {}, attempts: {}, completions: {} };
}

function cloneState(state: ImplementationEvidenceSnapshot): MutableImplementationEvidenceSnapshot {
  return structuredClone(state) as MutableImplementationEvidenceSnapshot;
}

class SerialBoundary {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/** Strict hand-written dummy used by the shared evidence-store contract. */
export function createInMemoryImplementationEvidenceStore(
  initial: ImplementationEvidenceSnapshot = emptyState(),
): ImplementationEvidenceStore {
  let state = cloneState(initial);
  const boundary = new SerialBoundary();
  return {
    async snapshot() {
      return cloneState(state);
    },
    async [mutateEvidence]<T>(
      mutation: (draft: MutableImplementationEvidenceSnapshot) => T | Promise<T>,
    ): Promise<T> {
      return await boundary.run(async () => {
        const draft = cloneState(state);
        const result = await mutation(draft);
        state = draft;
        return result;
      });
    },
  };
}

function parseStoredState(value: unknown): MutableImplementationEvidenceSnapshot {
  if (!object(value)) throw new Error("implementation evidence store root must be an object");
  if (
    value["version"] !== 1 ||
    !object(value["panels"]) ||
    !object(value["attempts"]) ||
    !object(value["completions"])
  ) {
    throw new Error("implementation evidence store has an unsupported or malformed version");
  }
  return structuredClone(value) as unknown as MutableImplementationEvidenceSnapshot;
}

export interface CreateFsImplementationEvidenceStoreOptions {
  readonly path: string;
  readonly lockfile?: LockfileOpts;
}

/** Durable sidecar adapter; the file is not reachable through generic ledger fields. */
export function createFsImplementationEvidenceStore(
  options: CreateFsImplementationEvidenceStoreOptions,
): ImplementationEvidenceStore {
  const boundary = new SerialBoundary();
  const lockfile = new Lockfile(options.lockfile);
  const parent = dirname(options.path);
  const locks = join(parent, ".locks");
  const read = async (): Promise<MutableImplementationEvidenceSnapshot> => {
    let bytes: string;
    try {
      bytes = await fs.readFile(options.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
    return parseStoredState(JSON.parse(bytes));
  };
  const write = async (state: MutableImplementationEvidenceSnapshot): Promise<void> => {
    await fs.mkdir(parent, { recursive: true });
    const temporary = `${options.path}.tmp-${process.pid}-${randomUUID()}`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, options.path);
  };
  return {
    async snapshot() {
      return await read();
    },
    async [mutateEvidence]<T>(
      mutation: (draft: MutableImplementationEvidenceSnapshot) => T | Promise<T>,
    ): Promise<T> {
      return await boundary.run(async () => {
        const release = await lockfile.acquire(locks, "implementation-evidence");
        try {
          const draft = await read();
          const result = await mutation(draft);
          await write(draft);
          return result;
        } finally {
          await release();
        }
      });
    },
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("implementation evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("implementation evidence contains a non-JSON value");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function opaqueRef(prefix: string, value: unknown): string {
  return `${prefix}:v1:${digest(value)}`;
}

function assertOperationId(value: string): void {
  if (!OPERATION_ID.test(value)) throw new Error("operation_id must be one stable operation id");
}

function taskIdFromRef(taskRef: string): string {
  const match = TASK_REF.exec(taskRef);
  if (match?.[1] === undefined) throw new Error("task_ref must be one canonical task ref");
  return match[1];
}

function assertFullSha(value: string, label: string): void {
  if (!FULL_SHA.test(value)) throw new Error(`${label} must be one full lowercase commit SHA`);
}

function handleOf(dispatch: DispatchPrepared): DispatchHandle {
  return { attestationId: dispatch.attestationId, generation: dispatch.generation };
}

function sameHandle(left: DispatchHandle, right: DispatchHandle): boolean {
  return left.attestationId === right.attestationId && left.generation === right.generation;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = [...allowed].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateReviewerVerdict(
  value: unknown,
  expectedTaskId: string,
  expectedResultCommit: string,
): value is DispatchJSONValue {
  if (!object(value)) return false;
  const optional = ["summary", "gateDurationMs", "gateReRanReason", "actualWorktreePath"];
  const required = [
    "taskId",
    "verdict",
    "criticism",
    "questions",
    "defects",
    "rationale",
    "gateReRan",
    "resultCommitVerified",
    "resultCommitEvidence",
    "baseAncestry",
  ];
  const keys = Object.keys(value);
  if (keys.some((key) => !required.includes(key) && !optional.includes(key))) return false;
  if (required.some((key) => !keys.includes(key))) return false;
  if (value["taskId"] !== expectedTaskId) return false;
  if (value["verdict"] !== "approve" && value["verdict"] !== "disapprove") return false;
  if (!stringArray(value["criticism"]) || !stringArray(value["questions"])) return false;
  if (!Array.isArray(value["defects"]) || typeof value["rationale"] !== "string") return false;
  if (typeof value["gateReRan"] !== "boolean" || typeof value["resultCommitVerified"] !== "boolean")
    return false;
  if (value["gateReRan"] === true && !Number.isInteger(value["gateDurationMs"])) return false;
  if (
    value["verdict"] === "disapprove" &&
    value["criticism"].length === 0 &&
    value["questions"].length === 0
  )
    return false;
  const resultEvidence = value["resultCommitEvidence"];
  const baseAncestry = value["baseAncestry"];
  if (!object(resultEvidence) || !object(baseAncestry)) return false;
  if (value["verdict"] === "approve") {
    if (value["resultCommitVerified"] !== true) return false;
    if (!exactKeys(resultEvidence, ["status", "resultCommit", "branchTip"])) return false;
    if (resultEvidence["status"] !== "verified") return false;
    if (
      resultEvidence["resultCommit"] !== expectedResultCommit ||
      resultEvidence["branchTip"] !== expectedResultCommit
    )
      return false;
    if (!exactKeys(baseAncestry, ["status", "relation", "baseCommit", "resultCommit", "mergeBase"]))
      return false;
    if (
      baseAncestry["status"] !== "verified" ||
      baseAncestry["resultCommit"] !== expectedResultCommit
    )
      return false;
    if (baseAncestry["relation"] !== "equal" && baseAncestry["relation"] !== "descendant")
      return false;
    if (
      ![baseAncestry["baseCommit"], baseAncestry["mergeBase"]].every(
        (entry) => typeof entry === "string" && FULL_SHA.test(entry),
      )
    )
      return false;
  }
  return true;
}

function parseAdapterVerdict(
  stdout: string,
  taskId: string,
  resultCommit: string,
): ExternalImplementationReviewExecution["parseResult"] {
  const trimmed = stdout.trim();
  if (trimmed === "")
    return { kind: "operational-abstention", reason: "empty", detail: "adapter stdout was empty" };
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
  const payload = fenced?.[1]?.trim() ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    return {
      kind: "operational-abstention",
      reason: "malformed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!validateReviewerVerdict(parsed, taskId, resultCommit)) {
    return {
      kind: "operational-abstention",
      reason: "malformed",
      detail: "adapter result did not satisfy the implement-reviewer contract",
    };
  }
  return { kind: "valid-verdict", verdict: parsed };
}

interface OperationProvenance {
  readonly operationId: string;
  readonly author: string;
  readonly session?: string;
}

export interface PrepareImplementationReviewPanelInput extends OperationProvenance {
  readonly taskRef: string;
  readonly resultCommit: string;
  readonly workerDispatch: DispatchHandle;
}

export interface PrepareImplementationReviewAttemptInput extends OperationProvenance {
  readonly panelRef: string;
  readonly attemptRef: string;
}

export interface ExecuteExternalImplementationReviewAttemptInput extends OperationProvenance {
  readonly attemptRef: string;
}

export interface FinalizeImplementationReviewAttemptInput extends OperationProvenance {
  readonly attemptRef: string;
}

export interface PrepareImplementationReviewFallbackInput extends OperationProvenance {
  readonly panelRef: string;
}

export interface PrepareImplementationCompletionInput extends OperationProvenance {
  readonly taskRef: string;
  readonly expectedRepositoryHead: string;
  readonly resultCommit: string;
  readonly workerDispatch: DispatchHandle;
  readonly reviewAttemptRefs: readonly string[];
  readonly completion: string;
  readonly logPaths: readonly string[];
  readonly mergeOperationId: string;
  readonly supersedesCompletionRef?: string;
}

export interface RecordImplementationCompletionInput extends OperationProvenance {
  readonly taskRef: string;
  readonly expectedRepositoryHead: string;
}

export interface ImplementationWorkerObservation {
  readonly state: "consumed" | "aborted" | "missing";
  readonly input?: DispatchJSONValue;
  readonly output?: DispatchJSONValue;
}

export interface ImplementationReviewObservation {
  readonly state: "consumed" | "aborted" | "missing";
  readonly output?: DispatchJSONValue;
  readonly retainedAttestation?: string;
}

export interface ExternalReviewProcessObservation {
  readonly adapterIdentity: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ImplementationTaskAuthority {
  readonly taskRef: string;
  readonly ownerGoalRef: string;
  readonly status: string;
  readonly finalizedManifest: string;
}

export interface ImplementationVerificationObservation {
  readonly baseCommit: string;
  readonly startingCommit: string;
  readonly clean: boolean;
  readonly ancestryVerified: boolean;
  readonly receiptsVerified: boolean;
  readonly acceptanceVerified: boolean;
  readonly gateVerified: boolean;
  readonly details: DispatchJSONValue;
}

export interface ImplementationCompletionLedgerResult {
  readonly reviewRef: string;
}

export interface ImplementationEvidenceServiceDependencies {
  readonly store: ImplementationEvidenceStore;
  readonly reviewerRoster: readonly ImplementationReviewerIdentity[];
  readonly nativeFallback: ImplementationReviewerIdentity;
  readonly now?: () => string;
  readonly prepareNativeReview: (input: {
    readonly attemptRef: string;
    readonly panel: ImplementationReviewPanelRecord;
    readonly identity: ImplementationReviewerIdentity;
    readonly operationId: string;
  }) => Promise<DispatchPrepared>;
  readonly fetchNativeReview: (
    dispatch: DispatchPrepared,
  ) => Promise<ImplementationReviewObservation>;
  readonly executeExternalReview: (input: {
    readonly attemptRef: string;
    readonly panel: ImplementationReviewPanelRecord;
    readonly identity: ImplementationReviewerIdentity;
  }) => Promise<ExternalReviewProcessObservation>;
  readonly fetchWorker: (dispatch: DispatchHandle) => Promise<ImplementationWorkerObservation>;
  readonly readTaskAuthority: (taskRef: string) => Promise<ImplementationTaskAuthority>;
  readonly repositoryHead: () => Promise<string>;
  readonly verifyImplementation: (input: {
    readonly task: ImplementationTaskAuthority;
    readonly resultCommit: string;
    readonly worker: ImplementationWorkerObservation;
    readonly attempts: readonly ImplementationReviewAttemptRecord[];
  }) => Promise<ImplementationVerificationObservation>;
  readonly recordLedgerCompletion: (input: {
    readonly task: ImplementationTaskAuthority;
    readonly completion: ImplementationCompletionRecord;
    readonly author: string;
    readonly session?: string;
  }) => Promise<ImplementationCompletionLedgerResult>;
}

function operationReplay(
  operations: Readonly<Record<string, string>>,
  operationId: string,
  requestDigest: string,
): boolean {
  const existing = operations[operationId];
  if (existing === undefined) return false;
  if (existing !== requestDigest)
    throw new Error(`operation_id ${operationId} was reused with a different request`);
  return true;
}

function withOperation(
  attempt: ImplementationReviewAttemptRecord,
  operationId: string,
  requestDigest: string,
): ImplementationReviewAttemptRecord {
  return { ...attempt, operations: { ...attempt.operations, [operationId]: requestDigest } };
}

export class ImplementationEvidenceService {
  private readonly deps: ImplementationEvidenceServiceDependencies;
  private readonly now: () => string;

  constructor(dependencies: ImplementationEvidenceServiceDependencies) {
    this.deps = dependencies;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    if (dependencies.reviewerRoster.length === 0)
      throw new Error("implementation reviewer roster must not be empty");
    if (dependencies.nativeFallback.launch !== "native")
      throw new Error("implementation fallback reviewer must be native");
  }

  async assertGenericTaskTerminalizationAllowed(taskRef: string): Promise<void> {
    taskIdFromRef(taskRef);
    const state = await this.deps.store.snapshot();
    const activated =
      Object.values(state.panels).some((panel) => panel.taskRef === taskRef) ||
      Object.values(state.completions).some((completion) => completion.taskRef === taskRef);
    if (activated) {
      throw new Error(
        `Git-producing task ${taskRef} may terminalize only through protected implementation evidence`,
      );
    }
  }

  async prepareReviewPanel(input: PrepareImplementationReviewPanelInput) {
    assertOperationId(input.operationId);
    taskIdFromRef(input.taskRef);
    assertFullSha(input.resultCommit, "result_commit");
    const roster = structuredClone(this.deps.reviewerRoster);
    const rosterDigest = digest(roster);
    const request = { ...input, roster };
    const requestDigest = digest(request);
    const panelRef = opaqueRef("cq-implementation-review-panel", request);
    const attemptRefs = roster.map((identity, position) =>
      opaqueRef("cq-implementation-review-attempt", { panelRef, position, identity }),
    );
    return await this.deps.store[mutateEvidence](async (state) => {
      for (const panel of Object.values(state.panels)) {
        if (panel.operationId !== input.operationId) continue;
        if (panel.requestDigest !== requestDigest)
          throw new Error(
            `operation_id ${input.operationId} was reused with a different review panel`,
          );
        return {
          status: "existing" as const,
          panelRef: panel.panelRef,
          taskRef: panel.taskRef,
          resultCommit: panel.resultCommit,
          rosterDigest: panel.rosterDigest,
          attemptRefs: panel.attemptRefs,
        };
      }
      const createdAt = this.now();
      const panel: ImplementationReviewPanelRecord = {
        version: 1,
        panelRef,
        taskRef: input.taskRef,
        resultCommit: input.resultCommit,
        workerDispatch: structuredClone(input.workerDispatch),
        rosterDigest,
        roster,
        attemptRefs,
        fallbackAttemptRef: null,
        operationId: input.operationId,
        requestDigest,
        author: input.author,
        session: input.session ?? null,
        createdAt,
      };
      state.panels[panelRef] = panel;
      roster.forEach((identity, position) => {
        const attemptRef = attemptRefs[position]!;
        state.attempts[attemptRef] = {
          version: 1,
          attemptRef,
          panelRef,
          taskRef: input.taskRef,
          resultCommit: input.resultCommit,
          position,
          identity,
          fallback: false,
          fallbackTrigger: null,
          fallbackExclusions: [],
          preparedDispatch: null,
          execution: null,
          terminalState: null,
          verdictDigest: null,
          verdict: null,
          operations: {},
          author: input.author,
          session: input.session ?? null,
          createdAt,
        };
      });
      return {
        status: "prepared" as const,
        panelRef,
        taskRef: input.taskRef,
        resultCommit: input.resultCommit,
        rosterDigest,
        attemptRefs,
      };
    });
  }

  async prepareReviewAttempt(input: PrepareImplementationReviewAttemptInput) {
    assertOperationId(input.operationId);
    if (!PANEL_REF.test(input.panelRef) || !ATTEMPT_REF.test(input.attemptRef))
      throw new Error("invalid implementation review reference");
    const snapshot = await this.deps.store.snapshot();
    const panel = snapshot.panels[input.panelRef];
    const attempt = snapshot.attempts[input.attemptRef];
    if (panel === undefined || attempt === undefined || attempt.panelRef !== panel.panelRef)
      throw new Error("review attempt does not belong to the panel");
    const requestDigest = digest(input);
    if (operationReplay(attempt.operations, input.operationId, requestDigest))
      return this.preparedAttemptResponse("existing", attempt);
    let preparedDispatch: DispatchPrepared | null = null;
    if (attempt.identity.launch === "native")
      preparedDispatch = await this.deps.prepareNativeReview({
        attemptRef: attempt.attemptRef,
        panel,
        identity: attempt.identity,
        operationId: input.operationId,
      });
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.attempts[input.attemptRef];
      if (current === undefined || current.panelRef !== input.panelRef)
        throw new Error("review attempt changed during preparation");
      if (operationReplay(current.operations, input.operationId, requestDigest))
        return this.preparedAttemptResponse("existing", current);
      if (
        current.preparedDispatch !== null &&
        preparedDispatch !== null &&
        !sameHandle(handleOf(current.preparedDispatch), handleOf(preparedDispatch))
      )
        throw new Error("review attempt dispatch identity changed");
      const updated = withOperation(
        { ...current, preparedDispatch: current.preparedDispatch ?? preparedDispatch },
        input.operationId,
        requestDigest,
      );
      state.attempts[input.attemptRef] = updated;
      return this.preparedAttemptResponse("prepared", updated);
    });
  }

  private preparedAttemptResponse(
    status: "prepared" | "existing",
    attempt: ImplementationReviewAttemptRecord,
  ) {
    if (attempt.identity.launch === "adapter")
      return { status, attemptRef: attempt.attemptRef, launch: "adapter" as const };
    if (attempt.preparedDispatch === null)
      throw new Error("native review attempt has no bound dispatch");
    return {
      status,
      attemptRef: attempt.attemptRef,
      launch: "native" as const,
      dispatch: attempt.preparedDispatch,
    };
  }

  async executeExternalReviewAttempt(input: ExecuteExternalImplementationReviewAttemptInput) {
    assertOperationId(input.operationId);
    const snapshot = await this.deps.store.snapshot();
    const attempt = snapshot.attempts[input.attemptRef];
    if (attempt === undefined || attempt.identity.launch !== "adapter")
      throw new Error("attempt is not a configured external review");
    const panel = snapshot.panels[attempt.panelRef];
    if (panel === undefined) throw new Error("review panel is missing");
    const requestDigest = digest(input);
    if (operationReplay(attempt.operations, input.operationId, requestDigest)) {
      if (attempt.execution === null)
        throw new Error("external review replay has no execution receipt");
      return {
        status: "existing" as const,
        attemptRef: attempt.attemptRef,
        executionRef: attempt.execution.executionRef,
      };
    }
    let observation: ExternalReviewProcessObservation | null = null;
    let unavailable: unknown;
    try {
      observation = await this.deps.executeExternalReview({
        attemptRef: attempt.attemptRef,
        panel,
        identity: attempt.identity,
      });
    } catch (error) {
      unavailable = error;
    }
    const executedAt = this.now();
    const parseResult =
      observation === null
        ? {
            kind: "operational-abstention" as const,
            reason: "unavailable" as const,
            detail: unavailable instanceof Error ? unavailable.message : String(unavailable),
          }
        : parseAdapterVerdict(observation.stdout, taskIdFromRef(panel.taskRef), panel.resultCommit);
    const executionBase = {
      adapterIdentity: observation?.adapterIdentity ?? attempt.identity.adapterId,
      stdout: observation?.stdout ?? "",
      stderr: observation?.stderr ?? "",
      exitCode: observation?.exitCode ?? null,
      parseResult,
      executedAt,
    };
    const execution: ExternalImplementationReviewExecution = {
      executionRef: opaqueRef("cq-implementation-review-execution", {
        attemptRef: attempt.attemptRef,
        ...executionBase,
      }),
      ...executionBase,
    };
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.attempts[input.attemptRef];
      if (current === undefined) throw new Error("review attempt disappeared");
      if (operationReplay(current.operations, input.operationId, requestDigest)) {
        if (current.execution === null)
          throw new Error("external review replay has no execution receipt");
        return {
          status: "existing" as const,
          attemptRef: current.attemptRef,
          executionRef: current.execution.executionRef,
        };
      }
      state.attempts[input.attemptRef] = withOperation(
        { ...current, execution },
        input.operationId,
        requestDigest,
      );
      return {
        status: "executed" as const,
        attemptRef: current.attemptRef,
        executionRef: execution.executionRef,
      };
    });
  }

  async finalizeReviewAttempt(input: FinalizeImplementationReviewAttemptInput) {
    assertOperationId(input.operationId);
    const snapshot = await this.deps.store.snapshot();
    const attempt = snapshot.attempts[input.attemptRef];
    if (attempt === undefined) throw new Error("implementation review attempt is missing");
    const requestDigest = digest(input);
    if (operationReplay(attempt.operations, input.operationId, requestDigest)) {
      if (attempt.terminalState === null)
        throw new Error("finalize replay has no terminal receipt");
      return {
        status: "existing" as const,
        attemptRef: attempt.attemptRef,
        terminalState: attempt.terminalState,
      };
    }
    let verdict: DispatchJSONValue | null = null;
    if (attempt.identity.launch === "native") {
      if (attempt.preparedDispatch === null)
        throw new Error("native review attempt was not prepared");
      const observation = await this.deps.fetchNativeReview(attempt.preparedDispatch);
      if (
        observation.state === "consumed" &&
        validateReviewerVerdict(
          observation.output,
          taskIdFromRef(attempt.taskRef),
          attempt.resultCommit,
        )
      )
        verdict = observation.output;
    } else if (attempt.execution?.parseResult.kind === "valid-verdict")
      verdict = attempt.execution.parseResult.verdict;
    const terminalState: ImplementationReviewTerminalState =
      verdict === null
        ? "operational-abstention"
        : (verdict as Record<string, unknown>)["verdict"] === "approve"
          ? "approved"
          : "disapproved";
    const verdictDigest = verdict === null ? null : digest(verdict);
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.attempts[input.attemptRef];
      if (current === undefined) throw new Error("implementation review attempt disappeared");
      if (operationReplay(current.operations, input.operationId, requestDigest)) {
        if (current.terminalState === null)
          throw new Error("finalize replay has no terminal receipt");
        return {
          status: "existing" as const,
          attemptRef: current.attemptRef,
          terminalState: current.terminalState,
        };
      }
      if (current.terminalState !== null)
        throw new Error(
          "implementation review attempt is already terminal under another operation",
        );
      state.attempts[input.attemptRef] = withOperation(
        { ...current, terminalState, verdictDigest, verdict },
        input.operationId,
        requestDigest,
      );
      return { status: "recorded" as const, attemptRef: current.attemptRef, terminalState };
    });
  }

  async prepareReviewFallback(input: PrepareImplementationReviewFallbackInput) {
    assertOperationId(input.operationId);
    const snapshot = await this.deps.store.snapshot();
    const panel = snapshot.panels[input.panelRef];
    if (panel === undefined) throw new Error("implementation review panel is missing");
    const configured = panel.attemptRefs.map((ref) => snapshot.attempts[ref]);
    if (configured.some((attempt) => attempt?.terminalState !== "operational-abstention"))
      throw new Error("native fallback requires every configured attempt to terminally abstain");
    const requestDigest = digest(input);
    const existingRef = panel.fallbackAttemptRef;
    if (existingRef !== null) {
      const existing = snapshot.attempts[existingRef];
      if (
        existing === undefined ||
        !operationReplay(existing.operations, input.operationId, requestDigest) ||
        existing.preparedDispatch === null
      )
        throw new Error("implementation review panel already has a different fallback");
      return {
        status: "existing" as const,
        attemptRef: existing.attemptRef,
        dispatch: existing.preparedDispatch,
      };
    }
    const exclusions = configured.map((attempt) => attempt!.identity.adapterId);
    const attemptRef = opaqueRef("cq-implementation-review-attempt", {
      panelRef: panel.panelRef,
      fallback: true,
      exclusions,
    });
    const seed: ImplementationReviewAttemptRecord = {
      version: 1,
      attemptRef,
      panelRef: panel.panelRef,
      taskRef: panel.taskRef,
      resultCommit: panel.resultCommit,
      position: panel.attemptRefs.length,
      identity: structuredClone(this.deps.nativeFallback),
      fallback: true,
      fallbackTrigger: "all-configured-attempts-operationally-abstained",
      fallbackExclusions: exclusions,
      preparedDispatch: null,
      execution: null,
      terminalState: null,
      verdictDigest: null,
      verdict: null,
      operations: {},
      author: input.author,
      session: input.session ?? null,
      createdAt: this.now(),
    };
    const dispatch = await this.deps.prepareNativeReview({
      attemptRef,
      panel,
      identity: seed.identity,
      operationId: input.operationId,
    });
    return await this.deps.store[mutateEvidence](async (state) => {
      const currentPanel = state.panels[input.panelRef];
      if (currentPanel === undefined) throw new Error("implementation review panel disappeared");
      if (currentPanel.fallbackAttemptRef !== null)
        throw new Error("implementation review fallback raced with another operation");
      const stored = withOperation(
        { ...seed, preparedDispatch: dispatch },
        input.operationId,
        requestDigest,
      );
      state.attempts[attemptRef] = stored;
      state.panels[input.panelRef] = { ...currentPanel, fallbackAttemptRef: attemptRef };
      return { status: "prepared" as const, attemptRef, dispatch };
    });
  }

  async prepareCompletion(input: PrepareImplementationCompletionInput) {
    assertOperationId(input.operationId);
    assertOperationId(input.mergeOperationId);
    taskIdFromRef(input.taskRef);
    assertFullSha(input.expectedRepositoryHead, "expected_repository_head");
    assertFullSha(input.resultCommit, "result_commit");
    if (input.completion.trim() === "") throw new Error("completion must not be empty");
    if (new Set(input.reviewAttemptRefs).size !== input.reviewAttemptRefs.length)
      throw new Error("review_attempt_refs must not contain duplicates");
    const repositoryHead = await this.deps.repositoryHead();
    if (repositoryHead !== input.expectedRepositoryHead)
      throw new Error("expected_repository_head does not match the integration ref");
    const task = await this.deps.readTaskAuthority(input.taskRef);
    if (task.taskRef !== input.taskRef || task.status !== "wip")
      throw new Error("implementation completion requires the exact active wip task");
    const worker = await this.deps.fetchWorker(input.workerDispatch);
    if (
      worker.state !== "consumed" ||
      !object(worker.output) ||
      worker.output["status"] !== "pass" ||
      worker.output["resultCommit"] !== input.resultCommit
    )
      throw new Error("worker_dispatch does not bind a consumed passing result");
    const workerResult = worker.output;
    const snapshot = await this.deps.store.snapshot();
    const attempts = input.reviewAttemptRefs.map((ref) => snapshot.attempts[ref]);
    if (attempts.some((attempt) => attempt === undefined))
      throw new Error("review_attempt_refs contains an unknown attempt");
    const boundAttempts = attempts as ImplementationReviewAttemptRecord[];
    const panelRefs = new Set(boundAttempts.map((attempt) => attempt.panelRef));
    if (panelRefs.size !== 1) throw new Error("review attempts must belong to one panel");
    const panel = snapshot.panels[boundAttempts[0]!.panelRef];
    if (
      panel === undefined ||
      panel.taskRef !== input.taskRef ||
      panel.resultCommit !== input.resultCommit ||
      !sameHandle(panel.workerDispatch, input.workerDispatch)
    )
      throw new Error("review panel does not match task, result, and worker dispatch");
    const expectedAttempts = [
      ...panel.attemptRefs,
      ...(panel.fallbackAttemptRef === null ? [] : [panel.fallbackAttemptRef]),
    ];
    if (canonical(expectedAttempts) !== canonical(input.reviewAttemptRefs))
      throw new Error("review_attempt_refs must be the complete ordered finalized panel");
    if (
      boundAttempts.some(
        (attempt) => attempt.terminalState === null || attempt.terminalState === "disapproved",
      )
    )
      throw new Error("every review attempt must be terminal and none may disapprove");
    if (!boundAttempts.some((attempt) => attempt.terminalState === "approved"))
      throw new Error("at least one authenticated review attempt must approve");
    const verification = await this.deps.verifyImplementation({
      task,
      resultCommit: input.resultCommit,
      worker,
      attempts: boundAttempts,
    });
    assertFullSha(verification.baseCommit, "verified base commit");
    assertFullSha(verification.startingCommit, "verified starting commit");
    if (
      !verification.clean ||
      !verification.ancestryVerified ||
      !verification.receiptsVerified ||
      !verification.acceptanceVerified ||
      !verification.gateVerified
    )
      throw new Error("implementation verification did not satisfy every completion invariant");
    const evidence = {
      version: 1,
      taskRef: input.taskRef,
      ownerGoalRef: task.ownerGoalRef,
      finalizedManifest: task.finalizedManifest,
      repositoryHead,
      resultCommit: input.resultCommit,
      baseCommit: verification.baseCommit,
      startingCommit: verification.startingCommit,
      workerDispatch: input.workerDispatch,
      workerResult,
      reviewAttemptRefs: input.reviewAttemptRefs,
      attempts: boundAttempts.map((attempt) => ({
        attemptRef: attempt.attemptRef,
        position: attempt.position,
        identity: attempt.identity,
        terminalState: attempt.terminalState,
        verdictDigest: attempt.verdictDigest,
        fallback: attempt.fallback,
        fallbackTrigger: attempt.fallbackTrigger,
        fallbackExclusions: attempt.fallbackExclusions,
      })),
      verification,
      completion: input.completion,
      logPaths: input.logPaths,
      mergeOperationId: input.mergeOperationId,
    };
    const evidenceFingerprint = digest(evidence);
    const requestDigest = digest({ ...input, evidenceFingerprint });
    const completionRef = opaqueRef("cq-implementation-completion", {
      taskRef: input.taskRef,
      operationId: input.operationId,
      evidenceFingerprint,
    });
    return await this.deps.store[mutateEvidence](async (state) => {
      for (const existing of Object.values(state.completions)) {
        if (existing.operationId !== input.operationId) continue;
        if (existing.requestDigest !== requestDigest)
          throw new Error(
            `operation_id ${input.operationId} was reused with a different completion`,
          );
        return this.preparedCompletionResponse("existing", existing);
      }
      const activeForTask = Object.values(state.completions).filter(
        (entry) =>
          entry.taskRef === input.taskRef &&
          entry.state !== "superseded" &&
          entry.state !== "recorded",
      );
      if (input.supersedesCompletionRef === undefined) {
        if (activeForTask.length !== 0)
          throw new Error("task already has an active implementation completion journal");
      } else {
        const prior = state.completions[input.supersedesCompletionRef];
        if (prior === undefined || prior.taskRef !== input.taskRef || prior.state !== "prepared")
          throw new Error(
            "supersedes_completion_ref must name the same task's unmerged prepared journal",
          );
        if (activeForTask.length !== 1 || activeForTask[0]!.completionRef !== prior.completionRef)
          throw new Error("superseded completion is not the unique active task journal");
        state.completions[prior.completionRef] = { ...prior, state: "superseded" };
      }
      const record: ImplementationCompletionRecord = {
        version: 1,
        completionRef,
        taskRef: input.taskRef,
        ownerGoalRef: task.ownerGoalRef,
        resultCommit: input.resultCommit,
        repositoryHead,
        baseCommit: verification.baseCommit,
        startingCommit: verification.startingCommit,
        workerDispatch: structuredClone(input.workerDispatch),
        workerResult,
        reviewAttemptRefs: [...input.reviewAttemptRefs],
        completion: input.completion,
        logPaths: [...input.logPaths],
        finalizedManifest: task.finalizedManifest,
        verification: verification.details,
        mergeOperationId: input.mergeOperationId,
        evidenceFingerprint,
        supersedesCompletionRef: input.supersedesCompletionRef ?? null,
        state: "prepared",
        reviewRef: null,
        operationId: input.operationId,
        requestDigest,
        author: input.author,
        session: input.session ?? null,
        preparedAt: this.now(),
        mergeStartedAt: null,
        mergedAt: null,
        recordedAt: null,
        recordOperationId: null,
      };
      state.completions[completionRef] = record;
      return this.preparedCompletionResponse("prepared", record);
    });
  }

  private preparedCompletionResponse(
    status: "prepared" | "existing",
    record: ImplementationCompletionRecord,
  ) {
    return {
      status,
      completionRef: record.completionRef,
      taskRef: record.taskRef,
      resultCommit: record.resultCommit,
      repositoryHead: record.repositoryHead,
      evidenceFingerprint: record.evidenceFingerprint,
    };
  }

  async assertMergeAdmission(
    binding: MergeEffectBinding,
    observedHead: string,
  ): Promise<ImplementationCompletionRecord> {
    return await assertImplementationCompletionMergeAdmission(
      this.deps.store,
      binding,
      observedHead,
    );
  }

  async markMergeStarted(completionRef: string, observedHead: string): Promise<void> {
    await markImplementationCompletionMergeStarted(
      this.deps.store,
      completionRef,
      observedHead,
      this.now,
    );
  }

  async markMerged(completionRef: string, observedHead: string): Promise<void> {
    await markImplementationCompletionMerged(
      this.deps.store,
      completionRef,
      observedHead,
      this.now,
    );
  }

  async mergeAcknowledgement(completionRef: string) {
    return await implementationCompletionMergeAcknowledgement(this.deps.store, completionRef);
  }

  async recordCompletion(input: RecordImplementationCompletionInput) {
    assertOperationId(input.operationId);
    taskIdFromRef(input.taskRef);
    assertFullSha(input.expectedRepositoryHead, "expected_repository_head");
    const head = await this.deps.repositoryHead();
    if (head !== input.expectedRepositoryHead)
      throw new Error("expected_repository_head does not match the integration ref");
    const snapshot = await this.deps.store.snapshot();
    const taskCompletions = Object.values(snapshot.completions).filter(
      (entry) => entry.taskRef === input.taskRef,
    );
    const active = taskCompletions.filter(
      (entry) => entry.state !== "superseded" && entry.state !== "recorded",
    );
    const recorded = taskCompletions.filter((entry) => entry.state === "recorded");
    if (active.length === 0 && recorded.length === 1) {
      const completion = recorded[0]!;
      return {
        status: "existing" as const,
        completionRef: completion.completionRef,
        reviewRef: completion.reviewRef!,
        taskRef: completion.taskRef,
        resultCommit: completion.resultCommit,
        repositoryHead: completion.resultCommit,
        evidenceFingerprint: completion.evidenceFingerprint,
      };
    }
    if (active.length !== 1)
      throw new Error("task must have exactly one active completion journal");
    let completion = active[0]!;
    if (completion.state === "prepared") {
      if (head === completion.repositoryHead)
        return {
          status: "merge-required" as const,
          completionRef: completion.completionRef,
          taskRef: completion.taskRef,
          resultCommit: completion.resultCommit,
          repositoryHead: head,
          evidenceFingerprint: completion.evidenceFingerprint,
        };
      if (head !== completion.resultCommit)
        return {
          status: "reprepare-required" as const,
          completionRef: completion.completionRef,
          taskRef: completion.taskRef,
          resultCommit: completion.resultCommit,
          preparedRepositoryHead: completion.repositoryHead,
          repositoryHead: head,
          evidenceFingerprint: completion.evidenceFingerprint,
        };
    }
    if (head !== completion.resultCommit)
      throw new Error("merge-started or merged completion has an unrelated integration ref");
    if (completion.state === "merge-started") {
      await this.markMerged(completion.completionRef, head);
      completion = (await this.deps.store.snapshot()).completions[completion.completionRef]!;
    }
    if (completion.state !== "merged" && completion.state !== "recording")
      throw new Error("implementation completion is not recordable");
    completion = await this.deps.store[mutateEvidence](async (state) => {
      const current = state.completions[completion.completionRef];
      if (current === undefined)
        throw new Error("implementation completion disappeared before recording");
      if (current.state === "merged") {
        const recording: ImplementationCompletionRecord = {
          ...current,
          state: "recording",
          recordOperationId: input.operationId,
        };
        state.completions[current.completionRef] = recording;
        return recording;
      }
      if (current.state !== "recording" || current.recordOperationId !== input.operationId) {
        throw new Error(
          "implementation completion is already claimed by another recording operation",
        );
      }
      return current;
    });
    const task = await this.deps.readTaskAuthority(completion.taskRef);
    if (
      task.taskRef !== completion.taskRef ||
      task.ownerGoalRef !== completion.ownerGoalRef ||
      task.finalizedManifest !== completion.finalizedManifest
    )
      throw new Error("task authority changed after completion preparation");
    const ledgerResult = await this.deps.recordLedgerCompletion({
      task,
      completion,
      author: input.author,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
    return await this.deps.store[mutateEvidence](async (state) => {
      const current = state.completions[completion.completionRef];
      if (current === undefined)
        throw new Error("implementation completion disappeared during recording");
      if (current.state === "recorded") {
        if (current.reviewRef !== ledgerResult.reviewRef)
          throw new Error("recorded completion review identity changed");
        return {
          status: "existing" as const,
          completionRef: current.completionRef,
          reviewRef: current.reviewRef,
          taskRef: current.taskRef,
          resultCommit: current.resultCommit,
          repositoryHead: current.resultCommit,
          evidenceFingerprint: current.evidenceFingerprint,
        };
      }
      if (current.state !== "recording" || current.recordOperationId !== input.operationId)
        throw new Error("implementation completion changed during ledger recording");
      const recorded: ImplementationCompletionRecord = {
        ...current,
        state: "recorded",
        reviewRef: ledgerResult.reviewRef,
        recordedAt: this.now(),
      };
      state.completions[current.completionRef] = recorded;
      return {
        status: "recorded" as const,
        completionRef: recorded.completionRef,
        reviewRef: ledgerResult.reviewRef,
        taskRef: recorded.taskRef,
        resultCommit: recorded.resultCommit,
        repositoryHead: recorded.resultCommit,
        evidenceFingerprint: recorded.evidenceFingerprint,
      };
    });
  }
}

export async function assertImplementationCompletionMergeAdmission(
  store: ImplementationEvidenceStore,
  binding: MergeEffectBinding,
  observedHead: string,
): Promise<ImplementationCompletionRecord> {
  if (!COMPLETION_REF.test(binding.completionRef))
    throw new Error("merge completionRef is malformed");
  const snapshot = await store.snapshot();
  const completion = snapshot.completions[binding.completionRef];
  if (completion === undefined) throw new Error("merge completion journal is missing");
  if (
    completion.taskRef !== binding.targetRef ||
    completion.resultCommit !== binding.commit ||
    completion.mergeOperationId !== binding.mergeOperationId
  )
    throw new Error("merge coordinates do not match the protected completion journal");
  const blocking = Object.values(snapshot.completions).find(
    (entry) =>
      entry.completionRef !== completion.completionRef &&
      (entry.state === "merge-started" || entry.state === "merged"),
  );
  if (blocking !== undefined)
    throw new Error(
      `implementation completion ${blocking.completionRef} blocks another repository merge until recording`,
    );
  if (
    completion.state !== "prepared" &&
    completion.state !== "merge-started" &&
    completion.state !== "merged"
  )
    throw new Error("implementation completion journal is not merge-admissible");
  if (observedHead !== completion.repositoryHead && observedHead !== completion.resultCommit)
    throw new Error("repository HEAD is unrelated to the prepared completion journal");
  return completion;
}

export async function markImplementationCompletionMergeStarted(
  store: ImplementationEvidenceStore,
  completionRef: string,
  observedHead: string,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  await store[mutateEvidence](async (state) => {
    const completion = state.completions[completionRef];
    if (completion === undefined) throw new Error("merge completion journal disappeared");
    if (
      observedHead === completion.resultCommit &&
      (completion.state === "prepared" || completion.state === "merge-started")
    ) {
      const instant = now();
      state.completions[completionRef] = {
        ...completion,
        state: "merged",
        mergeStartedAt: completion.mergeStartedAt ?? instant,
        mergedAt: completion.mergedAt ?? instant,
      };
      return;
    }
    if (observedHead !== completion.repositoryHead)
      throw new Error("repository HEAD changed before merge launch");
    if (completion.state === "prepared")
      state.completions[completionRef] = {
        ...completion,
        state: "merge-started",
        mergeStartedAt: now(),
      };
    else if (completion.state !== "merge-started")
      throw new Error("completion cannot enter merge-started from its current state");
  });
}

export async function markImplementationCompletionMerged(
  store: ImplementationEvidenceStore,
  completionRef: string,
  observedHead: string,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  await store[mutateEvidence](async (state) => {
    const completion = state.completions[completionRef];
    if (completion === undefined) throw new Error("merge completion journal disappeared");
    if (observedHead !== completion.resultCommit)
      throw new Error("integration ref did not settle at the prepared resultCommit");
    if (completion.state === "merged") return;
    if (completion.state !== "merge-started")
      throw new Error("completion was not merge-started before merge settlement");
    state.completions[completionRef] = { ...completion, state: "merged", mergedAt: now() };
  });
}

export async function implementationCompletionMergeAcknowledgement(
  store: ImplementationEvidenceStore,
  completionRef: string,
  status: "merged" | "existing" = "merged",
) {
  const completion = (await store.snapshot()).completions[completionRef];
  if (completion === undefined || completion.state !== "merged")
    throw new Error("implementation completion is not durably merged");
  return {
    status,
    completionRef: completion.completionRef,
    taskRef: completion.taskRef,
    resultCommit: completion.resultCommit,
    repositoryHead: completion.resultCommit,
    mergeOperationId: completion.mergeOperationId,
    evidenceFingerprint: completion.evidenceFingerprint,
  };
}

/**
 * Protected terminal ledger write. The review is created first and exact
 * replay validates it before the authorized task transition, so response loss
 * converges without allowing generic evidence or task completion writes.
 */
export async function recordProtectedImplementationCompletion(
  store: LedgerStore,
  task: ImplementationTaskAuthority,
  completion: ImplementationCompletionRecord,
  provenance: { readonly author: string; readonly session?: string },
): Promise<ImplementationCompletionLedgerResult> {
  if (completion.state !== "merged" && completion.state !== "recording") {
    throw new Error("protected ledger completion requires a merged journal");
  }
  if (completion.taskRef !== task.taskRef || completion.ownerGoalRef !== task.ownerGoalRef)
    throw new Error("protected ledger completion task authority mismatch");
  const taskId = taskIdFromRef(task.taskRef);
  const reviewId = `R${taskId.slice(1)}`;
  const implementationEvidence = JSON.stringify({
    version: 1,
    completionRef: completion.completionRef,
    taskRef: completion.taskRef,
    resultCommit: completion.resultCommit,
    evidenceFingerprint: completion.evidenceFingerprint,
    reviewAttemptRefs: completion.reviewAttemptRefs,
  });
  const reviewInit: CreateItemInit = {
    id: reviewId,
    status: "go-ahead",
    fields: {
      summary: completion.completion,
      implementationEvidence,
      ledgerRefs: [completion.taskRef, completion.ownerGoalRef] as string[],
      sourceRefs: [...completion.reviewAttemptRefs],
      sessionLogs: [...completion.logPaths],
    },
    author: provenance.author,
    ...(provenance.session === undefined ? {} : { session: provenance.session }),
  };
  authorizedImplementationEvidenceMutations.add(reviewInit);
  try {
    const currentTask = store.fetchItem(TASKS_LEDGER, taskId);
    await store.createItem(REVIEWS_LEDGER, currentTask.milestoneId, reviewInit);
  } catch (error) {
    if (!(error instanceof DuplicateIdError)) throw error;
    const existing = store.fetchItem(REVIEWS_LEDGER, reviewId);
    if (
      existing.status !== "go-ahead" ||
      existing.fields["implementationEvidence"] !== implementationEvidence
    )
      throw new Error("terminal implementation review id belongs to different evidence");
  }
  const patch: UpdateItemPatch = {
    status: "done",
    fields: {
      resultCommit: completion.resultCommit,
      completion: completion.completion,
      sessionLogs: [...completion.logPaths],
    },
    author: provenance.author,
    ...(provenance.session === undefined ? {} : { session: provenance.session }),
  };
  authorizedImplementationEvidenceMutations.add(patch);
  const current = store.fetchItem(TASKS_LEDGER, taskId);
  if (current.status !== "done") await store.updateItem(TASKS_LEDGER, taskId, patch);
  else if (current.fields["resultCommit"] !== completion.resultCommit)
    throw new Error("done task carries a different resultCommit");
  return { reviewRef: `${REVIEWS_LEDGER}:${reviewId}` };
}

export function canonicalImplementationCompletionMergeLine(
  value: Awaited<ReturnType<typeof implementationCompletionMergeAcknowledgement>>,
): string {
  return `CQ_IMPLEMENTATION_COMPLETION_MERGE=${JSON.stringify(value)}`;
}

export interface ImplementationCompletionMergeAdmissionProviderOptions {
  readonly provider: WorksetEffectAdmissionProvider;
  readonly store: ImplementationEvidenceStore;
  readonly binding: MergeEffectBinding;
  readonly repositoryHead: () => Promise<string>;
  readonly now?: () => string;
}

/**
 * Wrap the ordinary workset provider with journal transitions while preserving
 * the same admission through process registration, ref update, settlement,
 * durable `merged`, and release.
 */
export function implementationCompletionMergeAdmissionProviderFromStore(
  options: ImplementationCompletionMergeAdmissionProviderOptions,
): WorksetEffectAdmissionProvider {
  return {
    async acquire(input): Promise<WorksetBrokerAdmissionHandle> {
      if (input.kind !== "merge" || input.targetRef !== options.binding.targetRef)
        throw new Error("implementation completion provider admits only its bound merge");
      await assertImplementationCompletionMergeAdmission(
        options.store,
        options.binding,
        await options.repositoryHead(),
      );
      const underlying = await options.provider.acquire(input);
      return {
        id: underlying.id,
        epoch: underlying.epoch,
        kind: underlying.kind,
        targetRef: underlying.targetRef,
        registerProcessGroup: async (registration, deadline) =>
          await underlying.registerProcessGroup(registration, deadline),
        shareWithGuardian: async (guardian, deadline) => {
          await markImplementationCompletionMergeStarted(
            options.store,
            options.binding.completionRef,
            await options.repositoryHead(),
            options.now,
          );
          await underlying.shareWithGuardian(guardian, deadline);
        },
        markSettled: async () => {
          await markImplementationCompletionMerged(
            options.store,
            options.binding.completionRef,
            await options.repositoryHead(),
            options.now,
          );
          await underlying.markSettled();
        },
        releaseAfterSettlement: async () => await underlying.releaseAfterSettlement(),
        abandonBeforeRegistration: async () => await underlying.abandonBeforeRegistration(),
      };
    },
  };
}
