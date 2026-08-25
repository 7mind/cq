import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
  dispatchPayloadDigest,
  type AttestationNamespace,
  type DispatchJSONValue,
  type DispatchOverlayApplication,
  type DispatchPromptProvenance,
} from "@cq/config";
import { z } from "zod";
import type { GitChangeBrokerReceipt } from "./gitChangeBroker.js";

const TASK_ID = /^T[0-9]+$/u;
const ATTESTATION_ID = /^att_[A-Za-z0-9_-]{32,}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/u;

export const CURRENT_RECOVERY_SEAL_REFERENCE_PREFIX = "cq-current-recovery-seal:v1:";
export const CURRENT_RECOVERY_SEAL_REFERENCE_PATTERN =
  /^cq-current-recovery-seal:v1:[0-9a-f]{64}$/u;
export const LINEAGE_CUTOVER_FENCE_ACTION_KEY = "lineage-cutover-fence" as const;

export const CURRENT_RECOVERY_SOURCE_ABORT_REASONS = [
  "invalid-output",
  "missing-result",
  "deadline-exceeded",
  "parent-lost",
] as const;

export type CurrentRecoverySourceAbortReason =
  (typeof CURRENT_RECOVERY_SOURCE_ABORT_REASONS)[number];

const jsonValueSchema: z.ZodType<DispatchJSONValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const overlayApplicationSchema = z
  .object({
    overlayId: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    data: jsonValueSchema,
  })
  .strict();

const namespaceSchema = z
  .object({
    backend: z.enum(["fs", "xdg", "git-object", "remote", "postgres"]),
    projectKey: z.string().min(1),
  })
  .strict();

const dispatchHandleSchema = z
  .object({
    attestationId: z.string().regex(ATTESTATION_ID),
    generation: z.number().int().positive(),
  })
  .strict();

const promptProvenanceSchema = z
  .object({
    roleId: z.literal("implement-worker"),
    version: z.number().int().positive(),
    surface: z.enum(["claude", "codex", "pi"]),
    promptDigest: z.string().regex(SHA256),
    catalogHash: z.string().regex(SHA256),
    inputDigest: z.string().regex(SHA256),
  })
  .strict();

const gitBindingSchema = z
  .object({
    taskId: z.string().regex(TASK_ID),
    repositoryRoot: z.string().min(1),
    repositoryId: z.string().regex(SHA256),
    commonDir: z.string().min(1),
    worktreePath: z.string().min(1),
    branch: z.string().min(1),
    ref: z.string().min(1),
    baseCommit: z.string().regex(FULL_COMMIT),
  })
  .strict();

const gitChangeReceiptSchema = z
  .object({
    kind: z.literal("cq-git-change-receipt"),
    version: z.literal(1),
    attestationId: z.string().min(1),
    generation: z.number().int().positive(),
    taskId: z.string().regex(TASK_ID),
    operationId: z.string().min(1),
    requestDigest: z.string().regex(SHA256),
    oldHead: z.string().regex(FULL_OID),
    newHead: z.string().regex(FULL_OID),
    tree: z.string().regex(FULL_OID),
    objectOids: z.array(z.string().regex(FULL_OID)),
    paths: z.array(z.string().min(1)),
    committedAt: z.string().regex(ISO_INSTANT),
  })
  .strict();

const recoverySeedSchema = z
  .object({
    kind: z.literal("cq-current-recovery-seed"),
    version: z.literal(1),
    selectedSourceHandle: dispatchHandleSchema,
    lineageMaximumGeneration: z.number().int().positive(),
    snapshotDigest: z.string().regex(SHA256),
    sourceAbortReason: z.enum(CURRENT_RECOVERY_SOURCE_ABORT_REASONS),
    sourceTerminalDigest: z.string().regex(SHA256),
    namespace: namespaceSchema,
    promptProvenance: promptProvenanceSchema,
    prepareRequestDigest: z.string().regex(SHA256),
    taskId: z.string().regex(TASK_ID),
    taskDigest: z.string().regex(SHA256),
    finalizedManifestDigest: z.string().regex(SHA256),
    inputRecipe: jsonValueSchema,
    overlays: z.array(overlayApplicationSchema),
    gitBinding: gitBindingSchema,
    gitReceipts: z.array(gitChangeReceiptSchema).min(1),
    gitReceiptsDigest: z.string().regex(SHA256),
    liveTip: z.string().regex(FULL_COMMIT),
    managedFingerprint: z.string().regex(SHA256),
    capturedAt: z.string().regex(ISO_INSTANT),
  })
  .strict();

export const CurrentRecoverySealSchema = z
  .object({
    kind: z.literal("cq-current-recovery-seal"),
    version: z.literal(1),
    sealDigest: z.string().regex(SHA256),
    sealReference: z.string().regex(CURRENT_RECOVERY_SEAL_REFERENCE_PATTERN),
    seed: recoverySeedSchema,
  })
  .strict();

const provisionalJournalSchema = z
  .object({
    kind: z.literal("cq-current-recovery-seal-journal"),
    version: z.literal(1),
    state: z.literal("provisional"),
    taskId: z.string().regex(TASK_ID),
    snapshotDigest: z.string().regex(SHA256),
    seal: CurrentRecoverySealSchema,
    writtenAt: z.string().regex(ISO_INSTANT),
  })
  .strict();

const committedJournalSchema = provisionalJournalSchema
  .omit({ state: true })
  .extend({
    state: z.literal("committed"),
    committedAt: z.string().regex(ISO_INSTANT),
  })
  .strict();

export const CurrentRecoverySealJournalSchema = z.discriminatedUnion("state", [
  provisionalJournalSchema,
  committedJournalSchema,
]);

const absentStatusSchema = z
  .object({
    kind: z.literal("cq-current-recovery-status"),
    version: z.literal(1),
    taskId: z.string().regex(TASK_ID),
    state: z.literal("absent"),
  })
  .strict();

const provisionalStatusSchema = z
  .object({
    kind: z.literal("cq-current-recovery-status"),
    version: z.literal(1),
    taskId: z.string().regex(TASK_ID),
    state: z.literal("provisional"),
    selectedSourceHandle: dispatchHandleSchema,
    lineageMaximumGeneration: z.number().int().positive(),
    snapshotDigest: z.string().regex(SHA256),
    liveTip: z.string().regex(FULL_COMMIT),
    updatedAt: z.string().regex(ISO_INSTANT),
  })
  .strict();

const committedStatusSchema = z
  .object({
    kind: z.literal("cq-current-recovery-status"),
    version: z.literal(1),
    taskId: z.string().regex(TASK_ID),
    state: z.literal("committed"),
    selectedSourceHandle: dispatchHandleSchema,
    lineageMaximumGeneration: z.number().int().positive(),
    snapshotDigest: z.string().regex(SHA256),
    liveTip: z.string().regex(FULL_COMMIT),
    sealReference: z.string().regex(CURRENT_RECOVERY_SEAL_REFERENCE_PATTERN),
    sealDigest: z.string().regex(SHA256),
    seal: CurrentRecoverySealSchema,
  })
  .strict();

export const CurrentRecoveryStatusSchema = z.discriminatedUnion("state", [
  absentStatusSchema,
  provisionalStatusSchema,
  committedStatusSchema,
]);

export type CurrentRecoverySeed = z.infer<typeof recoverySeedSchema>;
export type CurrentRecoverySeal = z.infer<typeof CurrentRecoverySealSchema>;
export type CurrentRecoverySealJournal = z.infer<typeof CurrentRecoverySealJournalSchema>;
export type CurrentRecoveryStatus = z.infer<typeof CurrentRecoveryStatusSchema>;

export type CurrentRecoveryProvisionalJournal = Extract<
  CurrentRecoverySealJournal,
  { readonly state: "provisional" }
>;
export type CurrentRecoveryCommittedJournal = Extract<
  CurrentRecoverySealJournal,
  { readonly state: "committed" }
>;

export class CurrentRecoverySealError extends Error {
  constructor(
    readonly reason:
      | "invalid"
      | "lineage-active"
      | "source-not-found"
      | "source-ambiguous"
      | "snapshot-changed"
      | "journal-conflict",
    message: string,
  ) {
    super(message);
    this.name = "CurrentRecoverySealError";
  }
}

function payloadDigest(value: unknown): string {
  return dispatchPayloadDigest(value as DispatchJSONValue);
}

function assertReceiptChain(
  taskId: string,
  receipts: readonly GitChangeBrokerReceipt[],
  liveTip?: string,
): void {
  if (receipts.length === 0) {
    throw new CurrentRecoverySealError("invalid", "recovery receipt closure must be non-empty");
  }
  for (const [index, receipt] of receipts.entries()) {
    gitChangeReceiptSchema.parse(receipt);
    if (receipt.taskId !== taskId) {
      throw new CurrentRecoverySealError(
        "invalid",
        `recovery receipt ${String(index)} has a foreign task identity`,
      );
    }
    const preceding = receipts[index - 1];
    if (preceding !== undefined && preceding.newHead !== receipt.oldHead) {
      throw new CurrentRecoverySealError(
        "invalid",
        `recovery receipt closure diverges at entry ${String(index)}`,
      );
    }
  }
  if (liveTip !== undefined && receipts.at(-1)?.newHead !== liveTip) {
    throw new CurrentRecoverySealError(
      "invalid",
      "recovery receipt closure does not end at the live tip",
    );
  }
}

export function currentRecoveryReceiptClosureDigest(
  receipts: readonly GitChangeBrokerReceipt[],
): string {
  return payloadDigest(receipts);
}

export interface CurrentRecoverySourceCandidate {
  readonly selectedSourceHandle: {
    readonly attestationId: string;
    readonly generation: number;
  };
  readonly lineageMaximumGeneration: number;
  readonly sourceAbortReason: CurrentRecoverySourceAbortReason;
  readonly sourceTerminalDigest: string;
  readonly gitReceipts: readonly GitChangeBrokerReceipt[];
  readonly gitReceiptsDigest: string;
}

function receiptIdentity(receipt: GitChangeBrokerReceipt): string {
  return payloadDigest(receipt);
}

function chainIsPrefix(
  left: readonly GitChangeBrokerReceipt[],
  right: readonly GitChangeBrokerReceipt[],
): boolean {
  return (
    left.length <= right.length &&
    left.every((receipt, index) => receiptIdentity(receipt) === receiptIdentity(right[index]!))
  );
}

/** Select the one strict maximal valid closure; only byte-identical maxima use generation/id tie-breaks. */
export function selectStrictMaximalRecoverySource(
  taskId: string,
  liveTip: string,
  candidates: readonly CurrentRecoverySourceCandidate[],
): CurrentRecoverySourceCandidate {
  if (!TASK_ID.test(taskId) || !FULL_COMMIT.test(liveTip)) {
    throw new CurrentRecoverySealError("invalid", "recovery selection coordinates are malformed");
  }
  const valid = candidates.map((candidate) => {
    dispatchHandleSchema.parse(candidate.selectedSourceHandle);
    if (candidate.lineageMaximumGeneration < candidate.selectedSourceHandle.generation) {
      throw new CurrentRecoverySealError(
        "invalid",
        "lineage maximum generation precedes its selected source",
      );
    }
    if (!CURRENT_RECOVERY_SOURCE_ABORT_REASONS.includes(candidate.sourceAbortReason)) {
      throw new CurrentRecoverySealError("invalid", "recovery source abort reason is ineligible");
    }
    if (!SHA256.test(candidate.sourceTerminalDigest)) {
      throw new CurrentRecoverySealError("invalid", "recovery source terminal digest is malformed");
    }
    assertReceiptChain(taskId, candidate.gitReceipts);
    const digest = currentRecoveryReceiptClosureDigest(candidate.gitReceipts);
    if (candidate.gitReceiptsDigest !== digest) {
      throw new CurrentRecoverySealError("invalid", "recovery receipt closure digest is invalid");
    }
    return candidate;
  });
  if (valid.length === 0) {
    throw new CurrentRecoverySealError(
      "source-not-found",
      "no valid terminal recovery source exists",
    );
  }
  const maximal = valid.filter(
    (candidate) =>
      !valid.some(
        (other) =>
          other !== candidate &&
          candidate.gitReceipts.length < other.gitReceipts.length &&
          chainIsPrefix(candidate.gitReceipts, other.gitReceipts),
      ),
  );
  const closureDigests = new Set(maximal.map(({ gitReceiptsDigest }) => gitReceiptsDigest));
  if (closureDigests.size !== 1) {
    throw new CurrentRecoverySealError(
      "source-ambiguous",
      "terminal recovery sources have incomparable maximal receipt closures",
    );
  }
  const selected = [...maximal].sort((left, right) => {
    const byGeneration =
      right.selectedSourceHandle.generation - left.selectedSourceHandle.generation;
    if (byGeneration !== 0) return byGeneration;
    const leftId = left.selectedSourceHandle.attestationId;
    const rightId = right.selectedSourceHandle.attestationId;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  })[0]!;
  if (selected.gitReceipts.at(-1)?.newHead !== liveTip) {
    throw new CurrentRecoverySealError(
      "source-not-found",
      "maximal recovery receipt closure does not end at the live tip",
    );
  }
  return selected;
}

function validateSealSemantics(seal: CurrentRecoverySeal): CurrentRecoverySeal {
  const seed = seal.seed;
  if (
    seed.selectedSourceHandle.generation > seed.lineageMaximumGeneration ||
    seed.taskId !== seed.gitBinding.taskId ||
    seed.liveTip !== seed.gitReceipts.at(-1)?.newHead ||
    seed.promptProvenance.inputDigest !== payloadDigest(seed.inputRecipe) ||
    seed.gitReceiptsDigest !== currentRecoveryReceiptClosureDigest(seed.gitReceipts)
  ) {
    throw new CurrentRecoverySealError("invalid", "recovery seal has inconsistent seed bindings");
  }
  assertReceiptChain(seed.taskId, seed.gitReceipts, seed.liveTip);
  const sealDigest = payloadDigest(seed);
  if (
    seal.sealDigest !== sealDigest ||
    seal.sealReference !== `${CURRENT_RECOVERY_SEAL_REFERENCE_PREFIX}${sealDigest}`
  ) {
    throw new CurrentRecoverySealError(
      "invalid",
      "recovery seal digest is not self-authenticating",
    );
  }
  return seal;
}

export function parseCurrentRecoverySeal(value: unknown): CurrentRecoverySeal {
  try {
    return validateSealSemantics(CurrentRecoverySealSchema.parse(value));
  } catch (error) {
    if (error instanceof CurrentRecoverySealError) throw error;
    throw new CurrentRecoverySealError(
      "invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function createCurrentRecoverySeal(seed: CurrentRecoverySeed): CurrentRecoverySeal {
  const parsedSeed = recoverySeedSchema.parse(seed);
  const sealDigest = payloadDigest(parsedSeed);
  return parseCurrentRecoverySeal({
    kind: "cq-current-recovery-seal",
    version: 1,
    sealDigest,
    sealReference: `${CURRENT_RECOVERY_SEAL_REFERENCE_PREFIX}${sealDigest}`,
    seed: parsedSeed,
  });
}

export function parseCurrentRecoverySealJournal(value: unknown): CurrentRecoverySealJournal {
  try {
    const journal = CurrentRecoverySealJournalSchema.parse(value);
    parseCurrentRecoverySeal(journal.seal);
    if (journal.taskId !== journal.seal.seed.taskId) {
      throw new CurrentRecoverySealError("invalid", "recovery journal task binding is invalid");
    }
    return journal;
  } catch (error) {
    if (error instanceof CurrentRecoverySealError) throw error;
    throw new CurrentRecoverySealError(
      "invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface CurrentRecoverySealJournalStore {
  read(taskId: string): Promise<CurrentRecoverySealJournal | null>;
  put(journal: CurrentRecoverySealJournal): Promise<void>;
}

function assertJournalTransition(
  current: CurrentRecoverySealJournal | null,
  next: CurrentRecoverySealJournal,
): void {
  if (current === null || payloadDigest(current) === payloadDigest(next)) return;
  if (
    current.state === "provisional" &&
    next.state === "committed" &&
    current.taskId === next.taskId &&
    current.snapshotDigest === next.snapshotDigest &&
    current.writtenAt === next.writtenAt &&
    current.seal.sealDigest === next.seal.sealDigest
  ) {
    return;
  }
  if (next.state === "provisional" && current.taskId === next.taskId) return;
  throw new CurrentRecoverySealError(
    "journal-conflict",
    "current recovery journal cannot replace committed authority with unrelated state",
  );
}

export class InMemoryCurrentRecoverySealJournalStore implements CurrentRecoverySealJournalStore {
  readonly #journals = new Map<string, CurrentRecoverySealJournal>();

  async read(taskId: string): Promise<CurrentRecoverySealJournal | null> {
    const journal = this.#journals.get(taskId);
    return journal === undefined ? null : structuredClone(journal);
  }

  async put(value: CurrentRecoverySealJournal): Promise<void> {
    const journal = parseCurrentRecoverySealJournal(value);
    const current = this.#journals.get(journal.taskId) ?? null;
    assertJournalTransition(current, journal);
    this.#journals.set(journal.taskId, structuredClone(journal));
  }
}

export class FsCurrentRecoverySealJournalStore implements CurrentRecoverySealJournalStore {
  constructor(readonly root: string) {}

  #path(taskId: string): string {
    if (!TASK_ID.test(taskId)) {
      throw new CurrentRecoverySealError("invalid", "recovery journal task id is malformed");
    }
    return join(this.root, "current-recovery-seals", `${taskId}.json`);
  }

  async read(taskId: string): Promise<CurrentRecoverySealJournal | null> {
    try {
      return parseCurrentRecoverySealJournal(
        JSON.parse(await fs.readFile(this.#path(taskId), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(value: CurrentRecoverySealJournal): Promise<void> {
    const journal = parseCurrentRecoverySealJournal(value);
    const current = await this.read(journal.taskId);
    assertJournalTransition(current, journal);
    const file = this.#path(journal.taskId);
    await fs.mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    const handle = await fs.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const directory = await fs.open(dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export function currentRecoveryJournalRoot(repositoryRoot: string, stateDir?: string): string {
  return stateDir ?? join(repositoryRoot, ".claude", "worktrees", ".cq-managed-registry");
}

export async function readCommittedCurrentRecoverySeal(
  store: CurrentRecoverySealJournalStore,
  taskId: string,
): Promise<CurrentRecoverySeal | null> {
  const journal = await store.read(taskId);
  return journal?.state === "committed" ? journal.seal : null;
}

export function currentRecoveryStatusFromJournal(
  journal: CurrentRecoverySealJournal | null,
  taskId: string,
): CurrentRecoveryStatus {
  if (journal === null) {
    return parseCurrentRecoveryStatus({
      kind: "cq-current-recovery-status",
      version: 1,
      taskId,
      state: "absent",
    });
  }
  if (journal.taskId !== taskId) {
    throw new CurrentRecoverySealError("invalid", "recovery status task binding is invalid");
  }
  const common = {
    kind: "cq-current-recovery-status" as const,
    version: 1 as const,
    taskId,
    selectedSourceHandle: journal.seal.seed.selectedSourceHandle,
    lineageMaximumGeneration: journal.seal.seed.lineageMaximumGeneration,
    snapshotDigest: journal.snapshotDigest,
    liveTip: journal.seal.seed.liveTip,
  };
  return parseCurrentRecoveryStatus(
    journal.state === "committed"
      ? {
          ...common,
          state: "committed",
          sealReference: journal.seal.sealReference,
          sealDigest: journal.seal.sealDigest,
          seal: journal.seal,
        }
      : { ...common, state: "provisional", updatedAt: journal.writtenAt },
  );
}

export async function currentRecoveryStatus(
  store: CurrentRecoverySealJournalStore,
  taskId: string,
): Promise<CurrentRecoveryStatus> {
  return currentRecoveryStatusFromJournal(await store.read(taskId), taskId);
}

export function parseCurrentRecoveryStatus(value: unknown): CurrentRecoveryStatus {
  try {
    const status = CurrentRecoveryStatusSchema.parse(value);
    if (status.state === "committed") {
      parseCurrentRecoverySeal(status.seal);
    }
    if (
      status.state === "committed" &&
      (status.sealReference !== `${CURRENT_RECOVERY_SEAL_REFERENCE_PREFIX}${status.sealDigest}` ||
        status.sealReference !== status.seal.sealReference ||
        status.sealDigest !== status.seal.sealDigest ||
        status.taskId !== status.seal.seed.taskId ||
        status.selectedSourceHandle.attestationId !==
          status.seal.seed.selectedSourceHandle.attestationId ||
        status.selectedSourceHandle.generation !==
          status.seal.seed.selectedSourceHandle.generation ||
        status.lineageMaximumGeneration !== status.seal.seed.lineageMaximumGeneration ||
        status.snapshotDigest !== status.seal.seed.snapshotDigest ||
        status.liveTip !== status.seal.seed.liveTip)
    ) {
      throw new CurrentRecoverySealError(
        "invalid",
        "recovery status fields are not authenticated by its seal",
      );
    }
    return status;
  } catch (error) {
    if (error instanceof CurrentRecoverySealError) throw error;
    throw new CurrentRecoverySealError(
      "invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Semantic validation used by the lineage-cutover-fence operator action. */
export function parseCommittedCurrentRecoveryStatusOutput(
  stdout: string,
): Extract<CurrentRecoveryStatus, { readonly state: "committed" }> {
  const lines = stdout.trim().split(/\r?\n/u);
  if (lines.length !== 1 || lines[0] === "") {
    throw new CurrentRecoverySealError("invalid", "recovery status must be one JSON line");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(lines[0]!);
  } catch {
    throw new CurrentRecoverySealError("invalid", "recovery status output is not JSON");
  }
  const status = parseCurrentRecoveryStatus(decoded);
  if (status.state !== "committed") {
    throw new CurrentRecoverySealError(
      "invalid",
      "only a committed recovery seal grants authority",
    );
  }
  return status;
}

export interface CurrentRecoverySeedInput {
  readonly selectedSourceHandle: CurrentRecoverySeed["selectedSourceHandle"];
  readonly lineageMaximumGeneration: number;
  readonly snapshotDigest: string;
  readonly sourceAbortReason: CurrentRecoverySourceAbortReason;
  readonly sourceTerminalDigest: string;
  readonly namespace: AttestationNamespace;
  readonly promptProvenance: DispatchPromptProvenance;
  readonly prepareRequestDigest: string;
  readonly taskId: string;
  readonly taskDigest: string;
  readonly finalizedManifestDigest: string;
  readonly inputRecipe: DispatchJSONValue;
  readonly overlays: readonly DispatchOverlayApplication[];
  readonly gitBinding: CurrentRecoverySeed["gitBinding"] & {
    readonly handleFingerprint: string;
  };
  readonly gitReceipts: readonly GitChangeBrokerReceipt[];
  readonly liveTip: string;
  readonly capturedAt: string;
}

export function createCurrentRecoverySeed(input: CurrentRecoverySeedInput): CurrentRecoverySeed {
  const { gitBinding, ...seedInput } = input;
  return recoverySeedSchema.parse({
    kind: "cq-current-recovery-seed",
    version: 1,
    ...seedInput,
    gitBinding: {
      taskId: gitBinding.taskId,
      repositoryRoot: gitBinding.repositoryRoot,
      repositoryId: gitBinding.repositoryId,
      commonDir: gitBinding.commonDir,
      worktreePath: gitBinding.worktreePath,
      branch: gitBinding.branch,
      ref: gitBinding.ref,
      baseCommit: gitBinding.baseCommit,
    },
    gitReceiptsDigest: currentRecoveryReceiptClosureDigest(input.gitReceipts),
    managedFingerprint: gitBinding.handleFingerprint,
  });
}
