import {
  dispatchPayloadDigest,
  type AttestationEnvelope,
  type DispatchOverlayApplication,
} from "@cq/config";
import {
  createCurrentRecoverySeal,
  createCurrentRecoverySeed,
  currentRecoveryReceiptClosureDigest,
  type CurrentRecoveryCommittedJournal,
  type CurrentRecoveryProvisionalJournal,
  type CurrentRecoverySeal,
  type GitChangeBrokerReceipt,
  type ManagedWorktreeDispatchBinding,
} from "../src/index.js";

export const RECOVERY_NOW = "2026-08-25T01:00:00.000Z";
export const RECOVERY_LATER = "2026-08-25T01:00:01.000Z";
export const RECOVERY_TASK = "T2345";
export const RECOVERY_BASE = "1".repeat(40);
export const RECOVERY_MIDDLE = "2".repeat(40);
export const RECOVERY_TIP = "3".repeat(40);
export const RECOVERY_ATTESTATION = `att_${"a".repeat(32)}`;

export const RECOVERY_BINDING: ManagedWorktreeDispatchBinding = {
  taskId: RECOVERY_TASK,
  handleToken: "managed-handle-token",
  handleFingerprint: "4".repeat(64),
  repositoryRoot: "/repo",
  repositoryId: "5".repeat(64),
  commonDir: "/repo/.git",
  worktreePath: "/repo/.claude/worktrees/t2345",
  branch: `implement/${RECOVERY_TASK}`,
  ref: `refs/heads/implement/${RECOVERY_TASK}`,
  baseCommit: RECOVERY_BASE,
};

export function receipt(
  generation: number,
  oldHead: string,
  newHead: string,
  operationId = `checkpoint-${String(generation)}`,
): GitChangeBrokerReceipt {
  return {
    kind: "cq-git-change-receipt",
    version: 1,
    attestationId: RECOVERY_ATTESTATION,
    generation,
    taskId: RECOVERY_TASK,
    operationId,
    requestDigest: String(generation).padStart(64, "0"),
    oldHead,
    newHead,
    tree: "6".repeat(40),
    objectOids: [newHead, "6".repeat(40)],
    paths: ["WIP-T2345.md"],
    committedAt: RECOVERY_NOW,
  };
}

export const RECOVERY_RECEIPTS = [
  receipt(1, RECOVERY_BASE, RECOVERY_MIDDLE),
  receipt(2, RECOVERY_MIDDLE, RECOVERY_TIP),
] as const;

export const RECOVERY_INPUT = {
  taskId: RECOVERY_TASK,
  headline: "protected recovery",
  description: "capture the current receipt closure",
  acceptance: "committed status",
  worktreePath: RECOVERY_BINDING.worktreePath,
  branch: RECOVERY_BINDING.branch,
  baseCommit: RECOVERY_BASE,
  round: 17,
  startingCommit: RECOVERY_TIP,
  priorResultCommit: RECOVERY_MIDDLE,
  resolvedModel: "gpt-5.6-sol",
} as const;

export function recoverySeal(): Extract<CurrentRecoverySeal, { readonly version: 1 }> {
  const seal = createCurrentRecoverySeal(
    createCurrentRecoverySeed({
      selectedSourceHandle: { attestationId: RECOVERY_ATTESTATION, generation: 17 },
      lineageMaximumGeneration: 19,
      snapshotDigest: "d".repeat(64),
      source: { kind: "aborted", version: 1, abortReason: "deadline-exceeded" },
      sourceTerminalDigest: "7".repeat(64),
      namespace: { backend: "xdg", projectKey: "project" },
      promptProvenance: {
        roleId: "implement-worker",
        version: 9,
        surface: "codex",
        promptDigest: "8".repeat(64),
        catalogHash: "9".repeat(64),
        inputDigest: dispatchPayloadDigest(RECOVERY_INPUT),
      },
      prepareRequestDigest: "a".repeat(64),
      taskId: RECOVERY_TASK,
      taskDigest: "b".repeat(64),
      finalizedManifestDigest: "c".repeat(64),
      inputRecipe: RECOVERY_INPUT,
      overlays: [],
      gitBinding: RECOVERY_BINDING,
      gitReceipts: RECOVERY_RECEIPTS,
      liveTip: RECOVERY_TIP,
      capturedAt: RECOVERY_NOW,
    }),
  );
  if (seal.version !== 1) throw new Error("aborted recovery fixture did not create a v1 seal");
  return seal;
}

export function provisionalJournal(): Extract<
  CurrentRecoveryProvisionalJournal,
  { readonly version: 1 }
> {
  return {
    kind: "cq-current-recovery-seal-journal",
    version: 1,
    state: "provisional",
    taskId: RECOVERY_TASK,
    snapshotDigest: "d".repeat(64),
    seal: recoverySeal(),
    writtenAt: RECOVERY_NOW,
  };
}

export function committedJournal(): Extract<
  CurrentRecoveryCommittedJournal,
  { readonly version: 1 }
> {
  return { ...provisionalJournal(), state: "committed", committedAt: RECOVERY_LATER };
}

export function abortedEnvelope(input: {
  readonly attestationId?: string;
  readonly generation: number;
  readonly reason?: AttestationEnvelope["abortReason"];
  readonly state?: AttestationEnvelope["state"];
  readonly overlays?: readonly DispatchOverlayApplication[];
}): AttestationEnvelope {
  const state = input.state ?? "aborted";
  return {
    kind: "envelope",
    namespace: { backend: "xdg", projectKey: "project" },
    attestationId: input.attestationId ?? RECOVERY_ATTESTATION,
    generation: input.generation,
    idempotencyKey: `recovery-${String(input.generation)}`,
    state,
    promptProvenance: {
      roleId: "implement-worker",
      version: 9,
      surface: "codex",
      promptDigest: "8".repeat(64),
      catalogHash: "9".repeat(64),
      inputDigest: dispatchPayloadDigest(RECOVERY_INPUT),
    },
    prepareRequestDigest: "a".repeat(64),
    input: RECOVERY_INPUT,
    overlays: input.overlays ?? [],
    deadlines: {
      responseStoreNow: RECOVERY_NOW,
      childCancelAt: RECOVERY_LATER,
      launchDeadline: RECOVERY_LATER,
    },
    expectedChild: { childId: "child", runId: "run" },
    inputCapabilityHash: "e".repeat(64),
    resultCapabilityHash: "f".repeat(64),
    gitChangeCapabilityHash: "0".repeat(64),
    gitEffectBinding: RECOVERY_BINDING,
    createdAt: RECOVERY_NOW,
    ...(state === "aborted"
      ? {
          abortedAt: RECOVERY_LATER,
          abortReason: input.reason ?? "deadline-exceeded",
          terminalAt: RECOVERY_LATER,
          terminalDigest: String(input.generation).padStart(64, "0"),
        }
      : {}),
  };
}

export function sourceCandidate(input: {
  readonly attestationId?: string;
  readonly generation: number;
  readonly lineageMaximumGeneration?: number;
  readonly receipts?: readonly GitChangeBrokerReceipt[];
}) {
  const receipts = input.receipts ?? RECOVERY_RECEIPTS;
  return {
    selectedSourceHandle: {
      attestationId: input.attestationId ?? RECOVERY_ATTESTATION,
      generation: input.generation,
    },
    lineageMaximumGeneration: input.lineageMaximumGeneration ?? input.generation,
    source: { kind: "aborted" as const, version: 1 as const, abortReason: "deadline-exceeded" as const },
    sourceTerminalDigest: "7".repeat(64),
    gitReceipts: receipts,
    gitReceiptsDigest: currentRecoveryReceiptClosureDigest(receipts),
  };
}
