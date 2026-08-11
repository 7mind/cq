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

const inputCapability = z.object({
  scope: z.literal("fetch-input"),
  token: z.string(),
});

const gitChangeCapability = z.object({
  scope: z.literal("git-change"),
  token: z.string(),
});

const gitConflictCapability = z.object({
  scope: z.literal("git-conflict"),
  token: z.string(),
});

const gitPathState = z
  .object({
    mode: z.enum(["100644", "100755"]),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const gitChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), path: z.string(), newState: gitPathState }).strict(),
  z
    .object({
      kind: z.literal("modify"),
      path: z.string(),
      oldState: gitPathState,
      newState: gitPathState,
    })
    .strict(),
  z.object({ kind: z.literal("delete"), path: z.string(), oldState: gitPathState }).strict(),
  z
    .object({
      kind: z.literal("rename"),
      oldPath: z.string(),
      newPath: z.string(),
      oldState: gitPathState,
      newState: gitPathState,
    })
    .strict(),
]);

const gitConflictStage = z
  .object({
    path: z.string(),
    stage: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    mode: z.string().regex(/^\d{6}$/),
    oid: gitObjectId,
  })
  .strict();

const gitRebaseConflictState = z
  .object({
    baseCommit: gitObjectId,
    currentHead: gitObjectId,
    expectedAncestry: z.array(
      z
        .object({
          ancestor: gitObjectId,
          descendant: gitObjectId,
        })
        .strict(),
    ),
    sequencer: z
      .object({
        kind: z.literal("rebase-merge"),
        identity: z.string().regex(/^[0-9a-f]{64}$/),
        headName: z.string(),
        originalTip: gitObjectId,
        onto: gitObjectId,
        stoppedCommit: gitObjectId,
        currentCommand: z.string().min(1),
        todoDigest: z.string().regex(/^[0-9a-f]{64}$/),
        doneDigest: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    conflicts: z.array(gitConflictStage).min(1),
  })
  .strict();

const gitConflictResolution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("regular"), path: z.string(), newState: gitPathState }).strict(),
  z.object({ kind: z.literal("delete"), path: z.string() }).strict(),
]);

const nativeCompletion = z.object({
  kind: z.literal("native-completion"),
  actor: z.enum(["trusted-parent", "trusted-extension"]),
  childId: z.string().min(1),
  runId: z.string().min(1),
  completedAt: z.string(),
});

export const PREPARE_DISPATCH_INPUT = {
  roleId: z.string().optional(),
  input: z.json().optional(),
  refs: z.unknown().optional(),
  idempotencyKey: z.string().min(1).max(256),
  timeoutMs: z.number().int().positive(),
  overlays: z
    .array(
      z.object({
        overlayId: z.string(),
        data: z.json(),
      }),
    )
    .optional(),
  expectedChild: z.object({
    childId: z.string().min(1),
    runId: z.string().min(1),
  }),
  reprepareOf: z.object(handle).optional(),
} as const;

export const FETCH_DISPATCH_INPUT_INPUT = {
  ...handle,
  inputCapability,
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

export const GIT_COMMIT_INPUT = {
  ...handle,
  gitChangeCapability,
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  expectedHead: z.string().regex(/^[0-9a-f]{40,64}$/),
  message: z.string().min(1).max(16 * 1024),
  changes: z.array(gitChange).min(1),
} as const;

export const GIT_RESOLVE_CONTINUE_INPUT = {
  ...handle,
  gitConflictCapability,
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  expectedState: gitRebaseConflictState,
  resolutions: z.array(gitConflictResolution).min(1),
} as const;
