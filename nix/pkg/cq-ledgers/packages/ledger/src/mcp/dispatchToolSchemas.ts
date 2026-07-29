import { z } from "zod";
import { DISPATCH_ABORT_REASONS } from "@cq/config";

const handle = {
  attestationId: z.string(),
  generation: z.number().int().min(1),
} as const;

const resultCapability = z.object({
  scope: z.literal("store-result"),
  token: z.string(),
});

const nativeCompletion = z.object({
  kind: z.literal("native-completion"),
  actor: z.enum(["trusted-parent", "trusted-extension"]),
  childId: z.string().min(1),
  runId: z.string().min(1),
  completedAt: z.string(),
});

export const PREPARE_DISPATCH_INPUT = {
  roleId: z.string(),
  input: z.json(),
  idempotencyKey: z.string().min(1).max(256),
  timeoutMs: z.number().int().positive(),
  expectedChild: z.object({
    childId: z.string().min(1),
    runId: z.string().min(1),
  }),
  reprepareOf: z.object(handle).optional(),
} as const;

export const STORE_RESULT_INPUT = {
  resultCapability,
  output: z.json(),
} as const;

export const CONFIRM_DISPATCH_COMPLETION_INPUT = {
  ...handle,
  nativeCompletion,
  expectedProvenance: z.object({
    roleId: z.string(),
    version: z.number().int().min(1),
    promptDigest: z.string(),
    inputDigest: z.string(),
  }),
} as const;

export const ABORT_DISPATCH_INPUT = {
  ...handle,
  reason: z.enum(DISPATCH_ABORT_REASONS),
  details: z.json().optional(),
} as const;

export const FETCH_DISPATCH_RESULT_INPUT = handle;
