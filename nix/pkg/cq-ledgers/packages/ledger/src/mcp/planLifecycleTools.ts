/**
 * Guarded plan-lifecycle MCP tools (T852 / G99 / D134).
 *
 * The four guarded mutations of {@link PlanLifecycleStore} — claim,
 * publish-or-replace draft, pause-or-abandon, finalize — reach MCP callers
 * through this ONE module, which both transport factories consume:
 * `createLedgerMcpTools` (Claude in-process `tool()`) and
 * `registerLedgerStdioTools` (raw `McpServer.registerTool`). Sharing the spec
 * makes direct/stdio parity structural rather than a duplicated pair of Zod
 * literals kept in step by a test.
 *
 * Authority discipline (PLAN_AUTHORITY_RULES):
 *  - `ownerFenceToken` is CALLER-generated (>=128 bits of base64url) and is
 *    never allocated, echoed, or persisted in plaintext by the store. A claim
 *    is therefore replayable: a caller that loses the initial response retries
 *    the SAME `goalId` + `claimRequestId` + token and gets the identical
 *    acknowledgement back with `replayed: true` — including after a process
 *    restart, because the durable record holds only the SHA-256 verifier and
 *    the redacted acknowledgement projection.
 *  - Only the winning (or exactly-retried) claim response may carry the token.
 *    Every other response — the three owner operations, every conflict, and
 *    every ordinary read — is public data. {@link assertPlanLifecycleTokenExposure}
 *    enforces that at the wire boundary and fails closed.
 *  - Owner authority for publish/pause/finalize is the private token; the
 *    public `claimId` + `generation` pair authorizes NOTHING but exact
 *    recovery abandonment, which deliberately takes no token and loses the
 *    moment ownership moves on.
 *
 * The live response is preserved verbatim for immediate owner use; redaction
 * of persisted transcripts, exports, and backups happens on the log-write path
 * (`redactSecrets`, ../store/logRedaction.ts), never by rewriting this
 * response.
 */

import { z } from "zod";
import {
  PlanClaimInputSchema,
  PlanFinalizeInputSchema,
  PlanPauseEffectSchema,
  PlanPublishDraftInputSchema,
  PlanReleaseInputSchema,
  PlanReviewDefectBatchSchema,
  type PlanLifecycleStore,
} from "../planLifecycle.js";
import type { LedgerStore } from "../store/LedgerStore.js";
import { produceWireDto, type ProducedWireDto } from "./wireResponseContract.js";

export const PLAN_LIFECYCLE_TOOL_NAMES = [
  "claim_plan",
  "publish_plan_draft",
  "release_plan_claim",
  "finalize_plan",
] as const;

export type PlanLifecycleToolName = (typeof PLAN_LIFECYCLE_TOOL_NAMES)[number];

const PLAN_LIFECYCLE_STORE_METHODS = [
  "claimPlan",
  "publishPlanDraft",
  "releasePlanClaim",
  "finalizePlan",
] as const satisfies readonly (keyof PlanLifecycleStore)[];

/**
 * Thrown when a plan-lifecycle tool is invoked over a store that does not
 * implement {@link PlanLifecycleStore}. Every production backend does; the
 * error is reachable only from a hand-rolled store in a test.
 */
export class PlanLifecycleNotImplementedError extends Error {
  constructor(toolName: PlanLifecycleToolName) {
    super(
      `${toolName} is not implemented for this store: it does not expose the ` +
        "guarded PlanLifecycleStore capability",
    );
    this.name = "PlanLifecycleNotImplementedError";
  }
}

/** Duck-typed capability check: does `store` expose the four guarded mutations? */
export function isPlanLifecycleStore(
  store: LedgerStore,
): store is LedgerStore & PlanLifecycleStore {
  const candidate = store as Partial<PlanLifecycleStore>;
  return PLAN_LIFECYCLE_STORE_METHODS.every(
    (method) => typeof candidate[method] === "function",
  );
}

function requireLifecycle(
  store: LedgerStore,
  toolName: PlanLifecycleToolName,
): PlanLifecycleStore {
  if (!isPlanLifecycleStore(store)) {
    throw new PlanLifecycleNotImplementedError(toolName);
  }
  return store;
}

// ---------------------------------------------------------------------------
// Owner-token exposure guard
// ---------------------------------------------------------------------------

const OWNER_FENCE_TOKEN_KEY = "ownerFenceToken";

/** The ONLY response position that may carry the plaintext owner token. */
export const PLAN_CLAIM_TOKEN_ECHO_PATH = "acknowledgement.ownerFenceToken";

function ownerFenceTokenPaths(value: unknown, prefix: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      ownerFenceTokenPaths(entry, `${prefix}[${index}]`),
    );
  }
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (key === OWNER_FENCE_TOKEN_KEY) {
      found.push(path);
      continue;
    }
    found.push(...ownerFenceTokenPaths(nested, path));
  }
  return found;
}

/**
 * Fail closed unless the owner token appears in EXACTLY the one position the
 * authority rules allow: the acknowledgement of a winning or exactly-retried
 * claim. A conflict, a publish/pause/finalize acknowledgement, and any other
 * public payload must carry none — and a winning claim that carries none is
 * equally a contract violation (the owner would have no authority to use).
 */
export function assertPlanLifecycleTokenExposure(
  toolName: PlanLifecycleToolName,
  result: unknown,
): void {
  const echoAllowed =
    toolName === "claim_plan" &&
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === true;
  const expected = echoAllowed ? [PLAN_CLAIM_TOKEN_ECHO_PATH] : [];
  const found = ownerFenceTokenPaths(result, "");
  if (
    found.length !== expected.length ||
    found.some((path, index) => path !== expected[index])
  ) {
    throw new TypeError(
      `${toolName} response carries ownerFenceToken at [${found.join(", ")}] ` +
        `but the authority rules allow exactly [${expected.join(", ")}]`,
    );
  }
}

function planResult(
  toolName: PlanLifecycleToolName,
  result: object,
): ProducedWireDto<object> {
  assertPlanLifecycleTokenExposure(toolName, result);
  return produceWireDto(result);
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

// Derived from the authoritative contract objects so a tool schema cannot
// drift from what the store accepts.
const claimShape = PlanClaimInputSchema.shape;
const publishShape = PlanPublishDraftInputSchema.shape;
const finalizeShape = PlanFinalizeInputSchema.shape;

/**
 * Release is ONE tool over a two-variant discriminated union, so its wire
 * shape is flat and the variant-specific members are optional here. The
 * handler rebuilds the union member and re-parses it against the strict
 * contract, so a pause without a token, or an abandon that smuggles one, is
 * rejected rather than silently coerced.
 */
const releaseShape = {
  kind: z
    .enum(["pause", "abandon"])
    .describe(
      "pause = owner-authorized release with a questions/researches effect; " +
        "abandon = tokenless exact recovery of a stranded claim",
    ),
  goalId: publishShape.goalId,
  claimId: publishShape.claimId,
  generation: publishShape.generation,
  operationId: publishShape.operationId,
  ownerFenceToken: publishShape.ownerFenceToken
    .optional()
    .describe("required for kind=pause; REJECTED for kind=abandon"),
  effect: PlanPauseEffectSchema.optional().describe(
    "required for kind=pause: the questions or researches to create atomically",
  ),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe("required for kind=abandon: why the stranded claim is released"),
  reviewDefects: PlanReviewDefectBatchSchema.optional(),
  author: publishShape.author,
  session: publishShape.session,
} as const;

function definedEntries(
  args: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined) entries[key] = value;
  }
  return entries;
}

/**
 * Every flat release member except the discriminant. Both variants forward
 * ALL of them so the strict union member — not this layer — decides what is
 * admissible: an abandon that supplies `ownerFenceToken` or `effect`, and a
 * pause that supplies `reason`, are REJECTED rather than quietly stripped.
 */
const RELEASE_MEMBER_KEYS = [
  "goalId",
  "claimId",
  "generation",
  "operationId",
  "ownerFenceToken",
  "effect",
  "reason",
  "reviewDefects",
  "author",
  "session",
] as const;

// ---------------------------------------------------------------------------
// Tool specs
// ---------------------------------------------------------------------------

export interface PlanLifecycleToolSpec {
  readonly name: PlanLifecycleToolName;
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodType>;
  run(store: LedgerStore, args: unknown): Promise<ProducedWireDto<object>>;
}

const CLAIM_DESCRIPTION =
  "Claim the planning lifecycle of one goal, fencing every later plan write " +
  "of that generation. `ownerFenceToken` is CALLER-generated (>=128 bits of " +
  "base64url, >=22 chars) and never leaves your process except back to you: " +
  "the store persists only its SHA-256 verifier. `claimRequestId` scopes the " +
  "request so a lost response is recoverable — retry the SAME goalId + " +
  "claimRequestId + token and the identical acknowledgement returns with " +
  "replayed:true, including after a restart. A retry that CHANGES any other " +
  "request field conflicts with claim-request-reused. purpose=initial claims " +
  "a clarifying/planning goal; purpose=follow-up claims a planned|building goal and " +
  "atomically supersedes its replaceable planned work. expectedGeneration is " +
  "the compare-and-set fence (null = the goal carries no plan generation yet).";

const PUBLISH_DESCRIPTION =
  "Publish (or replace) the COMPLETE draft manifest of the claim you own. " +
  "Requires the private ownerFenceToken: the public claimId/generation pair " +
  "authorizes nothing here. Milestones and tasks are allocated atomically and " +
  "stay non-actionable until finalize. Each task's declared ledgerRefs are " +
  "de-duplicated with its mandatory goals:<goalId> owner reference while " +
  "sourceRefs remain separate provenance. `operationId` is the idempotency key " +
  "scoped to claimId+generation+operation: the same id with the same payload " +
  "replays the same allocated ids (replayed:true); the same id with a changed " +
  "payload conflicts with idempotency-key-reused. An optional reviewDefects " +
  "batch is created in the same transaction.";

const RELEASE_DESCRIPTION =
  "Release the claim, either as an owner pause or as a tokenless exact " +
  "recovery abandonment. kind=pause requires the private ownerFenceToken and " +
  "carries the effect that motivates the pause: questions (goal returns to " +
  "clarifying) or researches (goal stays in planning and its waitingResearches " +
  "set is REPLACED by exactly the created ids, suppressing planning until each " +
  "concludes/is abandoned). kind=abandon takes NO token — the exact public " +
  "claimId + generation fence a stranded-owner recovery without any clock or " +
  "lease expiry — and therefore loses as soon as ownership moves on. Same " +
  "operationId idempotency scoping as publish; optional reviewDefects are " +
  "created in the same transaction.";

const FINALIZE_DESCRIPTION =
  "Finalize the exact reviewed draft of the claim you own, making its manifest " +
  "the goal's ONLY executable plan and releasing the claim. Requires the " +
  "private ownerFenceToken, a current draft, and a go-ahead review bound to " +
  "the exact draft identity (goal, claim, generation, revision) — a review of " +
  "another revision or generation conflicts rather than finalizing stale work. " +
  "The decision item commits before the finalized marker, so a crash between " +
  "them replays cleanly. Same operationId idempotency scoping as publish; " +
  "optional reviewDefects must carry the same reviewId.";

export const PLAN_LIFECYCLE_TOOL_SPECS: readonly PlanLifecycleToolSpec[] = [
  {
    name: "claim_plan",
    description: CLAIM_DESCRIPTION,
    inputSchema: claimShape,
    run: async (store, args) => {
      const lifecycle = requireLifecycle(store, "claim_plan");
      const input = PlanClaimInputSchema.parse(args);
      return planResult("claim_plan", await lifecycle.claimPlan(input));
    },
  },
  {
    name: "publish_plan_draft",
    description: PUBLISH_DESCRIPTION,
    inputSchema: publishShape,
    run: async (store, args) => {
      const lifecycle = requireLifecycle(store, "publish_plan_draft");
      const input = PlanPublishDraftInputSchema.parse(args);
      return planResult(
        "publish_plan_draft",
        await lifecycle.publishPlanDraft(input),
      );
    },
  },
  {
    name: "release_plan_claim",
    description: RELEASE_DESCRIPTION,
    inputSchema: releaseShape,
    run: async (store, args) => {
      const lifecycle = requireLifecycle(store, "release_plan_claim");
      const flat = z.object(releaseShape).parse(args);
      const raw = flat as unknown as Record<string, unknown>;
      const input = PlanReleaseInputSchema.parse({
        kind: flat.kind,
        ...definedEntries(raw, RELEASE_MEMBER_KEYS),
      });
      return planResult(
        "release_plan_claim",
        await lifecycle.releasePlanClaim(input),
      );
    },
  },
  {
    name: "finalize_plan",
    description: FINALIZE_DESCRIPTION,
    inputSchema: finalizeShape,
    run: async (store, args) => {
      const lifecycle = requireLifecycle(store, "finalize_plan");
      const input = PlanFinalizeInputSchema.parse(args);
      return planResult("finalize_plan", await lifecycle.finalizePlan(input));
    },
  },
];
