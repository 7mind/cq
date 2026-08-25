import { createHash, timingSafeEqual } from "node:crypto";
import {
  dispatchJournalRecoveryRequired,
  dispatchPayloadDigest,
  type AttestationNamespace,
  type DispatchJournalRecoveryRequired,
  type DispatchJSONValue,
} from "@cq/config";
import { z } from "zod";

const TASK_ID = /^T[0-9]+$/u;
const ATTESTATION_ID = /^att_[A-Za-z0-9_-]{32,}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO_INSTANT =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/u;
const RECOVERY_SEED_REFERENCE = /^cq-current-recovery-seal:v1:[0-9a-f]{64}$/u;

export const DISPATCH_LINEAGE_CUTOVER_FENCE_REFERENCE_PREFIX =
  "cq-dispatch-lineage-cutover-fence:v1:";
export const DISPATCH_LINEAGE_CUTOVER_FENCE_REFERENCE_PATTERN =
  /^cq-dispatch-lineage-cutover-fence:v1:[0-9a-f]{64}$/u;

export interface DispatchLineageFenceCapability {
  readonly scope: "dispatch-lineage-fence";
  readonly token: string;
}

export interface DispatchLineageFenceAuthority {
  readonly recoverySeedRef: string;
  readonly fenceCapability: DispatchLineageFenceCapability;
}

const namespaceSchema = z
  .object({
    backend: z.enum(["fs", "xdg", "git-object", "remote", "postgres"]),
    projectKey: z.string().min(1),
  })
  .strict();

export const DispatchLineageCutoverFenceSchema = z
  .object({
    kind: z.literal("cq-dispatch-lineage-cutover-fence"),
    version: z.literal(1),
    state: z.literal("journal-only"),
    fenceRef: z.string().regex(DISPATCH_LINEAGE_CUTOVER_FENCE_REFERENCE_PATTERN),
    taskRef: z.string().regex(/^tasks:T[0-9]+$/u),
    namespace: namespaceSchema,
    taskId: z.string().regex(TASK_ID),
    managedFingerprint: z.string().regex(SHA256),
    sourceAttestationId: z.string().regex(ATTESTATION_ID),
    selectedSourceGeneration: z.number().int().positive(),
    lineageMaximumGeneration: z.number().int().positive(),
    recoverySeedRef: z.string().regex(RECOVERY_SEED_REFERENCE),
    fenceCapabilityHash: z.string().regex(SHA256),
    installedAt: z.string().regex(ISO_INSTANT),
  })
  .strict();

export type DispatchLineageCutoverFence = z.infer<
  typeof DispatchLineageCutoverFenceSchema
>;

export interface CreateDispatchLineageCutoverFenceInput {
  readonly namespace: AttestationNamespace;
  readonly taskId: string;
  readonly managedFingerprint: string;
  readonly sourceAttestationId: string;
  readonly selectedSourceGeneration: number;
  readonly lineageMaximumGeneration: number;
  readonly recoverySeedRef: string;
  readonly fenceCapability: DispatchLineageFenceCapability;
  readonly installedAt: string;
}

export class DispatchLineageCutoverFenceError extends Error {
  constructor(
    readonly reason: "invalid" | "conflict" | "unauthorized-release",
    message: string,
  ) {
    super(message);
    this.name = "DispatchLineageCutoverFenceError";
  }
}

function capabilityHash(capability: DispatchLineageFenceCapability): string {
  if (
    capability.scope !== "dispatch-lineage-fence" ||
    typeof capability.token !== "string" ||
    capability.token.length < 16
  ) {
    throw new DispatchLineageCutoverFenceError("invalid", "fence capability is malformed");
  }
  return createHash("sha256").update(capability.token, "utf8").digest("hex");
}

function fencePayload(
  fence: Omit<DispatchLineageCutoverFence, "fenceRef">,
): DispatchJSONValue {
  return fence as unknown as DispatchJSONValue;
}

function validateFenceSemantics(fence: DispatchLineageCutoverFence): DispatchLineageCutoverFence {
  if (
    fence.taskRef !== `tasks:${fence.taskId}` ||
    fence.selectedSourceGeneration > fence.lineageMaximumGeneration
  ) {
    throw new DispatchLineageCutoverFenceError(
      "invalid",
      "lineage fence task or generation bindings are inconsistent",
    );
  }
  const { fenceRef: _fenceRef, ...payload } = fence;
  const expected = `${DISPATCH_LINEAGE_CUTOVER_FENCE_REFERENCE_PREFIX}${dispatchPayloadDigest(
    fencePayload(payload),
  )}`;
  if (fence.fenceRef !== expected) {
    throw new DispatchLineageCutoverFenceError(
      "invalid",
      "lineage fence reference does not authenticate its payload",
    );
  }
  return Object.freeze(structuredClone(fence));
}

export function parseDispatchLineageCutoverFence(value: unknown): DispatchLineageCutoverFence {
  try {
    return validateFenceSemantics(DispatchLineageCutoverFenceSchema.parse(value));
  } catch (error) {
    if (error instanceof DispatchLineageCutoverFenceError) throw error;
    throw new DispatchLineageCutoverFenceError(
      "invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function createDispatchLineageCutoverFence(
  input: CreateDispatchLineageCutoverFenceInput,
): DispatchLineageCutoverFence {
  const payload = {
    kind: "cq-dispatch-lineage-cutover-fence" as const,
    version: 1 as const,
    state: "journal-only" as const,
    taskRef: `tasks:${input.taskId}`,
    namespace: input.namespace,
    taskId: input.taskId,
    managedFingerprint: input.managedFingerprint,
    sourceAttestationId: input.sourceAttestationId,
    selectedSourceGeneration: input.selectedSourceGeneration,
    lineageMaximumGeneration: input.lineageMaximumGeneration,
    recoverySeedRef: input.recoverySeedRef,
    fenceCapabilityHash: capabilityHash(input.fenceCapability),
    installedAt: input.installedAt,
  };
  return parseDispatchLineageCutoverFence({
    ...payload,
    fenceRef: `${DISPATCH_LINEAGE_CUTOVER_FENCE_REFERENCE_PREFIX}${dispatchPayloadDigest(
      fencePayload(payload),
    )}`,
  });
}

export function dispatchLineageFenceMatches(
  fence: DispatchLineageCutoverFence,
  input: {
    readonly namespace: AttestationNamespace;
    readonly taskId: string;
    readonly managedFingerprint: string;
  },
): boolean {
  return (
    fence.namespace.backend === input.namespace.backend &&
    fence.namespace.projectKey === input.namespace.projectKey &&
    fence.taskId === input.taskId &&
    fence.managedFingerprint === input.managedFingerprint
  );
}

export function dispatchLineageFenceAuthorizes(
  fence: DispatchLineageCutoverFence,
  authority: DispatchLineageFenceAuthority | undefined,
): boolean {
  if (authority === undefined || authority.recoverySeedRef !== fence.recoverySeedRef) {
    return false;
  }
  let presented: string;
  try {
    presented = capabilityHash(authority.fenceCapability);
  } catch {
    return false;
  }
  const expectedBytes = Buffer.from(fence.fenceCapabilityHash, "hex");
  const presentedBytes = Buffer.from(presented, "hex");
  return (
    expectedBytes.length === presentedBytes.length &&
    timingSafeEqual(expectedBytes, presentedBytes)
  );
}

export function journalRecoveryRequiredForFence(
  fence: DispatchLineageCutoverFence,
): DispatchJournalRecoveryRequired {
  return dispatchJournalRecoveryRequired(fence.fenceRef, fence.taskRef);
}

export function dispatchLineageFenceKey(fence: DispatchLineageCutoverFence): string {
  return dispatchPayloadDigest({
    namespace: fence.namespace,
    taskId: fence.taskId,
    managedFingerprint: fence.managedFingerprint,
    sourceAttestationId: fence.sourceAttestationId,
  });
}
