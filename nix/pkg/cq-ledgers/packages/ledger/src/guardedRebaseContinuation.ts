/**
 * T2150 / D334 — the replay-safe task-bound guarded-rebase authority boundary.
 *
 * A guarded rebase rewrites a managed worker branch, which destroys every
 * durable broker receipt lineage the dispatch runtime relies on. This module
 * journals the operation under the managed handle's Git-effect lock, binding
 * the task, the handle token/fingerprint, the canonical repository/common
 * directory, the worktree, the branch/ref, the old tip, the onto commit, the
 * terminal rebased head, the request digest, the conflict-continuation receipt
 * chain, the outcome, and the timestamps. The
 * ONLY thing a caller ever holds is the opaque digest-backed reference
 * (`cq-guarded-rebase:v1:<requestDigest>`); the trusted manager resolves it
 * back to the terminal journal server-side and materializes the closed
 * {@link DispatchGuardedRebaseBridge} persisted on the dispatch Git binding.
 *
 * Exact replay (same operation id, same payload) returns the same reference;
 * changed-payload reuse rejects; a restart after a durable start or
 * continuation reconciles the same journal; a nonterminal journal never
 * authorizes a prepare.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { DispatchGuardedRebaseBridge } from "@cq/config";
import {
  resolveInheritedGitChangeReceipts,
  type GitChangeReceiptLineageBinding,
} from "./gitChangeBroker.js";
import {
  durableHandleConflictContinuationReceipts,
  gitRebaseConflictStateDigest,
  observeManagedWorktreeConflictState,
  type GitConflictContinuationReceipt,
} from "./gitConflictContinuation.js";
import {
  withManagedWorktreeEffectLock,
  type ManagedWorktreeDeps,
  type ManagedWorktreeDispatchBinding,
} from "./managedWorktree.js";

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const JOURNAL_STATES = new Set<GuardedRebaseJournalState>([
  "intent",
  "rebase-stopped",
  "finalized",
]);

export const GUARDED_REBASE_REFERENCE_PREFIX = "cq-guarded-rebase:v1:";
export const GUARDED_REBASE_REFERENCE_PATTERN = /^cq-guarded-rebase:v1:[0-9a-f]{64}$/;

/** A prepare-facing rejection: the carry field is the exact launch-envelope path. */
export class GuardedRebaseRejection extends Error {
  constructor(
    readonly path: "guardedRebase" | "input.baseCommit" | "input.startingCommit" | "input.priorResultCommit",
    message: string,
  ) {
    super(message);
    this.name = "GuardedRebaseRejection";
  }
}

/** The journal is live but has no verified terminal tip yet — a pending state, not an integrity failure. */
class NonterminalGuardedRebaseError extends Error {}

type GuardedRebaseJournalState = "intent" | "rebase-stopped" | "finalized";

/** The durable journal. Everything a verified bridge derives from lives here. */
export interface GuardedRebaseJournal {
  readonly version: 1;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly createdAt: string;
  readonly state: GuardedRebaseJournalState;
  readonly taskId: string;
  readonly handleToken: string;
  readonly handleFingerprint: string;
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly commonDir: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly ref: string;
  readonly baseCommit: string;
  readonly oldResultCommit: string;
  readonly ontoCommit: string;
  readonly rebasedStartCommit?: string;
  readonly outcome?: "clean" | "conflicted";
  readonly exactTip?: boolean;
  readonly conflictStateDigest?: string;
  readonly conflictHead?: string;
  readonly conflictIdentity?: string;
  readonly conflictReceipts?: readonly GitConflictContinuationReceipt[];
  readonly finalizedAt?: string;
}

export interface GuardedRebaseEffectResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GuardedRebaseRunOutcome =
  | {
      readonly kind: "finalized";
      readonly reference: string;
      readonly bridge: DispatchGuardedRebaseBridge;
      /** Null when an exact replay returned without re-running the effect. */
      readonly effect: GuardedRebaseEffectResult | null;
    }
  | {
      readonly kind: "conflict-pending";
      readonly effect: GuardedRebaseEffectResult;
    };

export interface RunGuardedRebaseOptions {
  readonly binding: ManagedWorktreeDispatchBinding;
  readonly operationId: string;
  readonly ontoCommit: string;
  /** Launches the admitted `git rebase <ontoCommit>` effect exactly once. */
  readonly runEffect: () => Promise<GuardedRebaseEffectResult>;
  readonly now?: () => Date;
  readonly stateDir?: string;
}

interface GitResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function trustedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) delete environment[key];
  }
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    LANG: "C",
    LC_ALL: "C",
  };
}

function runGit(
  cwd: string,
  args: readonly string[],
  input?: Uint8Array,
): Promise<GitResult> {
  const child = Bun.spawn(
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    {
      cwd,
      env: trustedGitEnvironment(),
      stdin: input ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]).then(([code, stdout, stderr]) => {
    return { code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
  });
}

async function checkedGit(cwd: string, args: readonly string[], input?: Uint8Array): Promise<Buffer> {
  const result = await runGit(cwd, args, input);
  if (result.code !== 0) {
    throw new Error(`git ${args[0] ?? ""} failed (${result.code}): ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

function guardedRebaseRoot(
  binding: ManagedWorktreeDispatchBinding,
  stateDir?: string,
): string {
  return join(
    stateDir ?? join(binding.repositoryRoot, ".claude", "worktrees", ".cq-managed-registry"),
    "guarded-rebase",
  );
}

function operationRoot(
  binding: ManagedWorktreeDispatchBinding,
  operationId: string,
  stateDir?: string,
): string {
  const key = sha256(`${binding.taskId}\n${binding.handleToken}\n${operationId}`);
  return join(guardedRebaseRoot(binding, stateDir), key);
}

/** The replay-stable request identity: the parent payload plus the full handle identity. */
function guardedRebaseRequestDigest(
  binding: ManagedWorktreeDispatchBinding,
  operationId: string,
  ontoCommit: string,
): string {
  return sha256(
    canonical({
      operationId,
      ontoCommit,
      taskId: binding.taskId,
      handleToken: binding.handleToken,
      handleFingerprint: binding.handleFingerprint,
      repositoryRoot: binding.repositoryRoot,
      repositoryId: binding.repositoryId,
      commonDir: binding.commonDir,
      worktreePath: binding.worktreePath,
      branch: binding.branch,
      ref: binding.ref,
      baseCommit: binding.baseCommit,
    }),
  );
}

export function guardedRebaseReference(requestDigest: string): string {
  if (!SHA256.test(requestDigest)) {
    throw new Error("guarded rebase reference requires a full request digest");
  }
  return `${GUARDED_REBASE_REFERENCE_PREFIX}${requestDigest}`;
}

async function writeJournal(file: string, journal: GuardedRebaseJournal): Promise<void> {
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

function assertJournalShape(journal: GuardedRebaseJournal): GuardedRebaseJournal {
  if (
    journal === null ||
    typeof journal !== "object" ||
    journal.version !== 1 ||
    !OPERATION_ID.test(journal.operationId) ||
    !SHA256.test(journal.requestDigest) ||
    typeof journal.createdAt !== "string" ||
    !JOURNAL_STATES.has(journal.state)
  ) {
    throw new Error("invalid durable guarded-rebase journal");
  }
  for (const field of [
    "taskId",
    "handleToken",
    "handleFingerprint",
    "repositoryRoot",
    "repositoryId",
    "commonDir",
    "worktreePath",
    "branch",
    "ref",
  ] as const) {
    if (typeof journal[field] !== "string" || journal[field].length === 0) {
      throw new Error("invalid durable guarded-rebase journal");
    }
  }
  for (const field of ["baseCommit", "oldResultCommit", "ontoCommit"] as const) {
    if (!FULL_COMMIT.test(journal[field])) {
      throw new Error("invalid durable guarded-rebase journal");
    }
  }
  if (journal.state === "finalized") {
    if (
      journal.rebasedStartCommit === undefined ||
      !FULL_COMMIT.test(journal.rebasedStartCommit) ||
      (journal.outcome !== "clean" && journal.outcome !== "conflicted") ||
      typeof journal.exactTip !== "boolean" ||
      typeof journal.finalizedAt !== "string" ||
      (journal.outcome === "conflicted" &&
        (!Array.isArray(journal.conflictReceipts) || journal.conflictReceipts.length === 0))
    ) {
      throw new Error("invalid durable guarded-rebase journal");
    }
  }
  return journal;
}

async function readJournal(file: string): Promise<GuardedRebaseJournal | null> {
  try {
    const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let bytes: string;
    try {
      bytes = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    return assertJournalShape(JSON.parse(bytes) as GuardedRebaseJournal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function liveTip(
  binding: ManagedWorktreeDispatchBinding,
): Promise<string> {
  const symbolic = await runGit(binding.worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
  if (symbolic.code !== 0 || symbolic.stdout.toString().trim() !== binding.ref) {
    throw new Error("guarded rebase requires the bound task ref checked out");
  }
  const tip = (
    await checkedGit(binding.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"])
  )
    .toString()
    .trim();
  if (!FULL_COMMIT.test(tip)) throw new Error("guarded rebase observed a malformed live tip");
  return tip;
}

async function assertAncestor(
  binding: ManagedWorktreeDispatchBinding,
  ancestor: string,
  descendant: string,
  label: string,
): Promise<void> {
  const result = await runGit(binding.worktreePath, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  if (result.code !== 0) {
    throw new Error(`guarded rebase ${label} ancestry ${ancestor} -> ${descendant} does not hold`);
  }
}

async function sequencerActive(binding: ManagedWorktreeDispatchBinding): Promise<boolean> {
  const gitDir = (
    await checkedGit(binding.worktreePath, [
      "rev-parse",
      "--path-format=absolute",
      "--absolute-git-dir",
    ])
  )
    .toString()
    .trim();
  try {
    return (await fs.lstat(join(gitDir, "rebase-merge"))).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Stable patch-id of one squashed range diff; "" when the range is empty. */
async function rangePatchId(
  binding: ManagedWorktreeDispatchBinding,
  base: string,
  tip: string,
): Promise<string> {
  const diff = await checkedGit(binding.worktreePath, ["diff", base, tip]);
  if (diff.length === 0) return "";
  const identified = await checkedGit(
    binding.worktreePath,
    ["patch-id", "--stable"],
    new Uint8Array(diff),
  );
  const line = identified.toString().trim().split("\n")[0] ?? "";
  const patchId = line.split(" ")[0] ?? "";
  if (!FULL_COMMIT.test(patchId)) {
    throw new Error("guarded rebase could not derive a stable patch id");
  }
  return patchId;
}

function bridgeOf(
  journal: GuardedRebaseJournal,
  reference: string,
): DispatchGuardedRebaseBridge {
  if (
    journal.state !== "finalized" ||
    journal.rebasedStartCommit === undefined ||
    journal.outcome === undefined ||
    journal.exactTip === undefined ||
    journal.finalizedAt === undefined
  ) {
    throw new Error("guarded rebase journal is not terminal");
  }
  return Object.freeze({
    guardedRebase: reference,
    operationId: journal.operationId,
    requestDigest: journal.requestDigest,
    oldResultCommit: journal.oldResultCommit,
    ontoCommit: journal.ontoCommit,
    rebasedStartCommit: journal.rebasedStartCommit,
    outcome: journal.outcome,
    exactTip: journal.exactTip,
    finalizedAt: journal.finalizedAt,
  });
}

async function finalizeClean(
  binding: ManagedWorktreeDispatchBinding,
  journal: GuardedRebaseJournal,
  rebasedStartCommit: string,
  now: () => Date,
): Promise<GuardedRebaseJournal> {
  await assertAncestor(binding, journal.ontoCommit, rebasedStartCommit, "onto");
  const oldPatch = await rangePatchId(binding, journal.baseCommit, journal.oldResultCommit);
  const rebasedPatch = await rangePatchId(binding, journal.ontoCommit, rebasedStartCommit);
  return Object.freeze({
    ...journal,
    state: "finalized" as const,
    rebasedStartCommit,
    outcome: "clean" as const,
    exactTip: oldPatch === rebasedPatch,
    finalizedAt: now().toISOString(),
  });
}

async function finalizeConflicted(
  binding: ManagedWorktreeDispatchBinding,
  journal: GuardedRebaseJournal,
  deps: Pick<ManagedWorktreeDeps, "stateDir">,
  now: () => Date,
): Promise<GuardedRebaseJournal> {
  if (await sequencerActive(binding)) {
    throw new NonterminalGuardedRebaseError("guarded rebase has not reached a verified terminal tip");
  }
  const receipts = await durableHandleConflictContinuationReceipts(binding, deps);
  const tip = await liveTip(binding);
  const terminal = receipts.at(-1);
  if (
    receipts.length === 0 ||
    terminal === undefined ||
    terminal.outcome.kind !== "terminal" ||
    terminal.newHead !== tip
  ) {
    throw new NonterminalGuardedRebaseError("guarded rebase has not reached a verified terminal tip");
  }
  const first = receipts[0]!;
  if (journal.conflictHead !== undefined && first.oldHead !== journal.conflictHead) {
    throw new Error("guarded rebase continuation chain does not start at the journaled conflict");
  }
  for (const receipt of receipts) {
    const state = receipt.outcome.kind === "conflict" ? receipt.outcome.state : undefined;
    if (state === undefined) continue;
    if (
      state.sequencer.headName !== binding.ref ||
      state.sequencer.onto !== journal.ontoCommit ||
      state.sequencer.originalTip !== journal.oldResultCommit
    ) {
      throw new Error("guarded rebase continuation belongs to a foreign rebase");
    }
    if (
      journal.conflictIdentity !== undefined &&
      state.sequencer.identity !== journal.conflictIdentity
    ) {
      throw new Error("guarded rebase continuation belongs to a foreign rebase");
    }
  }
  await assertAncestor(binding, journal.ontoCommit, tip, "onto");
  return Object.freeze({
    ...journal,
    state: "finalized" as const,
    rebasedStartCommit: tip,
    outcome: "conflicted" as const,
    exactTip: false,
    conflictReceipts: receipts,
    finalizedAt: now().toISOString(),
  });
}

/**
 * Run (or reconcile) exactly one journaled guarded rebase under the managed
 * handle's Git-effect lock. The effect itself is launched by the caller's
 * admitted gate; this boundary owns the journal, the terminal verification,
 * and the opaque reference.
 */
export async function runGuardedRebase(
  options: RunGuardedRebaseOptions,
): Promise<GuardedRebaseRunOutcome> {
  if (!OPERATION_ID.test(options.operationId)) {
    throw new Error("guarded rebase operationId must match /^[A-Za-z0-9_-]{1,128}$/");
  }
  if (!FULL_COMMIT.test(options.ontoCommit)) {
    throw new Error("guarded rebase requires one full onto commit SHA");
  }
  const binding = options.binding;
  const now = options.now ?? (() => new Date());
  const requestDigest = guardedRebaseRequestDigest(binding, options.operationId, options.ontoCommit);
  const reference = guardedRebaseReference(requestDigest);
  const root = operationRoot(binding, options.operationId, options.stateDir);
  const journalFile = join(root, "journal.json");
  return await withManagedWorktreeEffectLock(
    binding,
    { ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }) },
    async () => {
      let journal = await readJournal(journalFile);
      if (journal !== null && journal.requestDigest !== requestDigest) {
        throw new Error(
          `guarded rebase operationId ${options.operationId} was reused with a different request`,
        );
      }
      if (journal?.state === "finalized") {
        const tip = await liveTip(binding);
        if (tip !== journal.rebasedStartCommit) {
          throw new Error(
            "guarded rebase reference is stale: the managed ref advanced past the journaled rebased head",
          );
        }
        return Object.freeze({
          kind: "finalized" as const,
          reference,
          bridge: bridgeOf(journal, reference),
          effect: null,
        });
      }
      if (journal?.state === "rebase-stopped") {
        let finalized: GuardedRebaseJournal;
        try {
          finalized = await finalizeConflicted(
            binding,
            journal,
            { ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }) },
            now,
          );
        } catch (error) {
          if (!(error instanceof NonterminalGuardedRebaseError)) throw error;
          return Object.freeze({
            kind: "conflict-pending" as const,
            effect: { code: 1, stdout: "", stderr: "guarded rebase stopped on a conflict" },
          });
        }
        await writeJournal(journalFile, finalized);
        return Object.freeze({
          kind: "finalized" as const,
          reference,
          bridge: bridgeOf(finalized, reference),
          effect: null,
        });
      }
      // "intent": fresh start, or a restart after the durable intent but before
      // (or during) the effect. Reconcile the live state before deciding.
      if (journal !== null && (await sequencerActive(binding))) {
        const conflict = await observeManagedWorktreeConflictState(binding, {
          ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
        });
        journal = Object.freeze({
          ...journal,
          state: "rebase-stopped" as const,
          conflictStateDigest: gitRebaseConflictStateDigest(conflict),
          conflictHead: conflict.currentHead,
          conflictIdentity: conflict.sequencer.identity,
        });
        await writeJournal(journalFile, journal);
        try {
          const finalized = await finalizeConflicted(
            binding,
            journal,
            { ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }) },
            now,
          );
          await writeJournal(journalFile, finalized);
          return Object.freeze({
            kind: "finalized" as const,
            reference,
            bridge: bridgeOf(finalized, reference),
            effect: null,
          });
        } catch (error) {
          if (!(error instanceof NonterminalGuardedRebaseError)) throw error;
          return Object.freeze({
            kind: "conflict-pending" as const,
            effect: { code: 1, stdout: "", stderr: "guarded rebase stopped on a conflict" },
          });
        }
      }
      if (journal !== null) {
        const tip = await liveTip(binding);
        if (tip !== journal.oldResultCommit) {
          // The effect ran to completion but the outcome was never recorded.
          const receipts = await durableHandleConflictContinuationReceipts(binding, {
            ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
          });
          const finalized =
            receipts.length === 0
              ? await finalizeClean(binding, journal, tip, now)
              : await finalizeConflicted(
                  binding,
                  journal,
                  { ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }) },
                  now,
                );
          await writeJournal(journalFile, finalized);
          return Object.freeze({
            kind: "finalized" as const,
            reference,
            bridge: bridgeOf(finalized, reference),
            effect: null,
          });
        }
      }
      if (journal === null) {
        journal = Object.freeze({
          version: 1 as const,
          operationId: options.operationId,
          requestDigest,
          createdAt: now().toISOString(),
          state: "intent" as const,
          taskId: binding.taskId,
          handleToken: binding.handleToken,
          handleFingerprint: binding.handleFingerprint,
          repositoryRoot: binding.repositoryRoot,
          repositoryId: binding.repositoryId,
          commonDir: binding.commonDir,
          worktreePath: binding.worktreePath,
          branch: binding.branch,
          ref: binding.ref,
          baseCommit: binding.baseCommit,
          oldResultCommit: await liveTip(binding),
          ontoCommit: options.ontoCommit,
        });
        await writeJournal(journalFile, journal);
      }
      const effect = await options.runEffect();
      if (effect.code !== 0) {
        if (await sequencerActive(binding)) {
          const conflict = await observeManagedWorktreeConflictState(binding, {
            ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
          });
          journal = Object.freeze({
            ...journal,
            state: "rebase-stopped" as const,
            conflictStateDigest: gitRebaseConflictStateDigest(conflict),
            conflictHead: conflict.currentHead,
            conflictIdentity: conflict.sequencer.identity,
          });
          await writeJournal(journalFile, journal);
          return Object.freeze({ kind: "conflict-pending" as const, effect });
        }
        throw new Error(
          `guarded rebase effect failed (${effect.code}): ${effect.stderr.trim()}`,
        );
      }
      const tip = await liveTip(binding);
      const finalized = await finalizeClean(binding, journal, tip, now);
      await writeJournal(journalFile, finalized);
      return Object.freeze({
        kind: "finalized" as const,
        reference,
        bridge: bridgeOf(finalized, reference),
        effect,
      });
    },
  );
}

async function readJournals(
  binding: ManagedWorktreeDispatchBinding,
  stateDir?: string,
): Promise<readonly GuardedRebaseJournal[]> {
  const root = guardedRebaseRoot(binding, stateDir);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("guarded rebase reference does not resolve to a durable journal");
    }
    throw error;
  }
  const journals: GuardedRebaseJournal[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const journal = await readJournal(join(root, entry.name, "journal.json"));
    if (journal !== null) journals.push(journal);
  }
  return Object.freeze(journals);
}

const BINDING_IDENTITY_FIELDS = [
  "taskId",
  "handleToken",
  "handleFingerprint",
  "repositoryRoot",
  "repositoryId",
  "commonDir",
  "worktreePath",
  "branch",
  "ref",
  "baseCommit",
] as const;

function assertJournalMatchesBinding(
  journal: GuardedRebaseJournal,
  binding: ManagedWorktreeDispatchBinding,
  label: string,
): void {
  for (const field of BINDING_IDENTITY_FIELDS) {
    if (journal[field] !== binding[field]) {
      throw new Error(`guarded rebase journal does not match the ${label} binding at ${field}`);
    }
  }
}

function journalMatchesBinding(
  journal: GuardedRebaseJournal,
  binding: ManagedWorktreeDispatchBinding,
): boolean {
  return BINDING_IDENTITY_FIELDS.every((field) => journal[field] === binding[field]);
}

function composeGuardedRebaseBridge(
  journals: readonly GuardedRebaseJournal[],
  selected: GuardedRebaseJournal,
  binding: ManagedWorktreeDispatchBinding,
  oldResultCommit: string,
  reference: string,
): DispatchGuardedRebaseBridge {
  const chain = [selected];
  const visited = new Set([selected.requestDigest]);
  let cursor = selected;
  while (cursor.oldResultCommit !== oldResultCommit) {
    const matching = journals.filter(
      (journal) =>
        journal.state === "finalized" &&
        journal.rebasedStartCommit === cursor.oldResultCommit &&
        journalMatchesBinding(journal, binding),
    );
    const predecessors = matching.filter((journal) => !visited.has(journal.requestDigest));
    if (predecessors.length === 0) {
      if (matching.length > 0) {
        throw new Error("guarded rebase journal chain contains a cycle");
      }
      throw new Error("guarded rebase journal chain has a gap before the terminal worker result");
    }
    if (predecessors.length > 1) {
      throw new Error("guarded rebase journal chain forks before the terminal worker result");
    }
    const predecessor = predecessors[0]!;
    visited.add(predecessor.requestDigest);
    chain.push(predecessor);
    cursor = predecessor;
  }
  const latest = bridgeOf(selected, reference);
  return Object.freeze({
    ...latest,
    oldResultCommit,
    outcome: chain.some((journal) => journal.outcome === "conflicted")
      ? "conflicted"
      : "clean",
    exactTip: chain.every((journal) => journal.exactTip === true),
  });
}

export interface MaterializeGuardedRebaseBridgeOptions {
  readonly reference: string;
  /** The exact terminal prior worker generation's persisted binding. */
  readonly prior: GitChangeReceiptLineageBinding;
  /** The live binding resolved for THIS prepare. */
  readonly current: ManagedWorktreeDispatchBinding;
  readonly baseCommitInput: string;
  readonly startingCommitInput: string;
  readonly priorResultCommitInput?: string | null;
  readonly stateDir?: string;
}

/**
 * Resolve the opaque reference to its terminal journal and verify the complete
 * bridge against the prior generation, the live binding, the declared
 * coordinates, and the durable pre-rebase receipt chain. Throws on every
 * omission, substitution, foreign, stale, or nonterminal case.
 */
export async function materializeGuardedRebaseBridge(
  options: MaterializeGuardedRebaseBridgeOptions,
): Promise<DispatchGuardedRebaseBridge> {
  if (!GUARDED_REBASE_REFERENCE_PATTERN.test(options.reference)) {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      "guardedRebase must be one opaque cq-guarded-rebase:v1 reference",
    );
  }
  const requestDigest = options.reference.slice(GUARDED_REBASE_REFERENCE_PREFIX.length);
  let journal: GuardedRebaseJournal;
  let journals: readonly GuardedRebaseJournal[];
  try {
    journals = await readJournals(options.current, options.stateDir);
    const matches = journals.filter((candidate) => candidate.requestDigest === requestDigest);
    if (matches.length === 0) {
      throw new Error("guarded rebase reference does not resolve to a durable journal");
    }
    if (matches.length > 1) {
      throw new Error("guarded rebase reference resolves to multiple durable journals");
    }
    journal = matches[0]!;
  } catch (error) {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (journal.state !== "finalized") {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      "guarded rebase journal has not reached a verified terminal tip",
    );
  }
  try {
    assertJournalMatchesBinding(journal, options.current, "current");
    assertJournalMatchesBinding(journal, options.prior, "prior-generation");
  } catch (error) {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    options.priorResultCommitInput === undefined ||
    options.priorResultCommitInput === null ||
    !FULL_COMMIT.test(options.priorResultCommitInput)
  ) {
    throw new GuardedRebaseRejection(
      "input.priorResultCommit",
      "guarded rebase continuation requires one full terminal priorResultCommit",
    );
  }
  let bridge: DispatchGuardedRebaseBridge;
  try {
    bridge = composeGuardedRebaseBridge(
      journals,
      journal,
      options.current,
      options.priorResultCommitInput,
      options.reference,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("gap")) {
      throw new GuardedRebaseRejection(
        "input.priorResultCommit",
        "guarded rebase continuation requires priorResultCommit to equal the bound old worker result",
      );
    }
    throw new GuardedRebaseRejection(
      detail.includes("fork") || detail.includes("cycle")
        ? "guardedRebase"
        : "input.priorResultCommit",
      detail,
    );
  }
  try {
    await resolveInheritedGitChangeReceipts(options.prior, bridge.oldResultCommit, {
      ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    });
  } catch (error) {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      `guarded rebase old result is not the exact terminal prior generation result: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (options.baseCommitInput !== bridge.ontoCommit) {
    throw new GuardedRebaseRejection(
      "input.baseCommit",
      "guarded rebase continuation requires baseCommit to equal the journaled ontoCommit",
    );
  }
  if (options.startingCommitInput !== bridge.rebasedStartCommit) {
    throw new GuardedRebaseRejection(
      "input.startingCommit",
      "guarded rebase continuation requires startingCommit to equal the journaled rebased head",
    );
  }
  if ((await liveTip(options.current)) !== bridge.rebasedStartCommit) {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      "guarded rebase reference is stale: the managed ref advanced past the journaled rebased head",
    );
  }
  return bridge;
}

export interface ReverifyGuardedRebaseBridgeOptions {
  /** The bridge persisted on the exact terminal prior generation. */
  readonly bridge: DispatchGuardedRebaseBridge;
  readonly current: ManagedWorktreeDispatchBinding;
  readonly baseCommitInput: string;
  readonly startingCommitInput: string;
  /** First oldHead of the inherited post-rebase suffix, or null when it is empty. */
  readonly firstInheritedOldHead: string | null;
  readonly stateDir?: string;
}

/**
 * Carry the verified bridge through a later same-lineage correction: the
 * journal is re-resolved and re-verified against the live binding, and the
 * inherited post-rebase suffix must begin exactly at the journaled rebased
 * head (an empty suffix pins startingCommit to it).
 */
export async function reverifyGuardedRebaseBridge(
  options: ReverifyGuardedRebaseBridgeOptions,
): Promise<DispatchGuardedRebaseBridge> {
  const bridge = options.bridge;
  if (!GUARDED_REBASE_REFERENCE_PATTERN.test(bridge.guardedRebase)) {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      "persisted guarded-rebase bridge carries a malformed reference",
    );
  }
  let journal: GuardedRebaseJournal;
  let journals: readonly GuardedRebaseJournal[];
  try {
    journals = await readJournals(options.current, options.stateDir);
    const matches = journals.filter(
      (candidate) => candidate.requestDigest === bridge.requestDigest,
    );
    if (matches.length === 0) {
      throw new Error("guarded rebase reference does not resolve to a durable journal");
    }
    if (matches.length > 1) {
      throw new Error("guarded rebase reference resolves to multiple durable journals");
    }
    journal = matches[0]!;
  } catch (error) {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (journal.state !== "finalized") {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      "guarded rebase journal has not reached a verified terminal tip",
    );
  }
  if (guardedRebaseReference(journal.requestDigest) !== bridge.guardedRebase) {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      "persisted guarded-rebase bridge reference does not match its journal",
    );
  }
  try {
    assertJournalMatchesBinding(journal, options.current, "current");
  } catch (error) {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      error instanceof Error ? error.message : String(error),
    );
  }
  let materialized: DispatchGuardedRebaseBridge;
  try {
    materialized = composeGuardedRebaseBridge(
      journals,
      journal,
      options.current,
      bridge.oldResultCommit,
      bridge.guardedRebase,
    );
  } catch (error) {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (canonical(materialized) !== canonical(bridge)) {
    throw new GuardedRebaseRejection(
      "guardedRebase",
      "persisted guarded-rebase bridge does not match its terminal journal",
    );
  }
  if (options.baseCommitInput !== bridge.ontoCommit) {
    throw new GuardedRebaseRejection(
      "input.baseCommit",
      "guarded rebase correction requires baseCommit to equal the journaled ontoCommit",
    );
  }
  if (options.firstInheritedOldHead === null) {
    if (options.startingCommitInput !== bridge.rebasedStartCommit) {
      throw new GuardedRebaseRejection(
        "input.startingCommit",
        "a guarded rebase correction without an inherited suffix requires startingCommit to equal the rebased head",
      );
    }
  } else if (options.firstInheritedOldHead !== bridge.rebasedStartCommit) {
    throw new GuardedRebaseRejection(
      "input.startingCommit",
      "guarded rebase correction suffix does not begin at the journaled rebased head",
    );
  }
  return materialized;
}
