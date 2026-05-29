/**
 * Internal WebSocket protocol — cq-server ↔ cq-mcp channel envelopes.
 *
 * Two processes own independent in-memory caches of the same on-disk
 * `docs/` tree. The advisory lockfile (D-LED) keeps disk consistent;
 * this protocol delivers per-process cache-invalidation notifications
 * so a write on one side is reflected on the other without restart.
 *
 * Schema is a discriminated union. The base cycle (outer-13) registered
 * `ledger.changed`; the askproxy cycle (outer-14) added `ask.request` +
 * `ask.reply` for the Codex `ask_user_question` WS-back-proxy; the
 * codex-parity cycle (codexwf) added `workflow.submit` + `workflow.submit_ack`
 * for the Codex `/plan` structured-output relay (a CodexProducer / phase
 * subagent's cq-mcp child relays the model's structured payload upstream so
 * the HARNESS — WorkflowRuntime — validates + writes the ledgers, exactly as
 * on the Claude path; cq-mcp NEVER writes ledgers for these tools). Future
 * cycles add new variants without breaking the wire shape: receivers
 * drop unknown `type` values with a warning rather than rejecting the
 * channel.
 *
 * Path + subprotocol constants are exported so client and server cannot
 * drift on the handshake. The token itself is per-process and is NOT
 * encoded in the schema — it lives in `Sec-WebSocket-Protocol` header
 * during the upgrade and never appears in a message body.
 */

import { z } from "zod";

/**
 * The WebSocket path the cq server listens for internal connections on.
 * The browser-facing path (`/ws`) is unaffected.
 */
export const INTERNAL_WS_PATH = "/__internal/cq-mcp";

/**
 * Subprotocol prefix sent by the client (and echoed by the server) in
 * `Sec-WebSocket-Protocol`. The full value is `<prefix>.<token>` where
 * the token is the server's per-process random hex string.
 */
export const INTERNAL_WS_SUBPROTOCOL_PREFIX = "cq-internal";

/** Operation that triggered the invalidation. */
export const LedgerOp = z.enum(["create", "update", "archive"]);
export type LedgerOp = z.infer<typeof LedgerOp>;

/**
 * Questions array carried by `ask.request`. The Claude in-process tool
 * (`askUserQuestion.ts`) types each question as `unknown` and validates
 * the model-emitted array with `z.array(z.any()).min(1).max(4)`; the wire
 * mirror uses `z.unknown()` element type so the proxy passes any
 * well-formed array through to the browser without schema friction. The
 * min/max mirror the Claude tool's own bounds so a malformed Codex ask is
 * rejected at the channel boundary rather than surfacing a broken UI.
 */
export const AskQuestions = z.array(z.unknown()).min(1).max(4);
export type AskQuestions = z.infer<typeof AskQuestions>;

/**
 * Answers map carried by `ask.reply`. Mirrors `ChatQuestionReply.answers`
 * (`protocol.ts`): a record keyed by question text whose values are the
 * raw browser-supplied selections (string or string[]); cq-mcp's broker
 * normalises them to the same comma-joined string shape the Claude
 * `AskBroker` produces.
 */
export const AskAnswers = z.record(z.string(), z.unknown());
export type AskAnswers = z.infer<typeof AskAnswers>;

/**
 * The `/plan` phases a Codex submit relay can carry. Mirrors the server-side
 * phase specs (producer / clarify-reviewer / planner / plan-reviewer); the
 * server's `WorkflowSubmitProxy` selects the per-phase Zod schema by this
 * discriminator before validating the relayed payload. Kept as a closed enum
 * so an unknown phase is rejected at the channel boundary rather than reaching
 * the proxy.
 */
export const WorkflowSubmitPhase = z.enum([
  "produce",
  "clarify_review",
  "plan",
  "plan_review",
]);
export type WorkflowSubmitPhase = z.infer<typeof WorkflowSubmitPhase>;

/**
 * The structured payload a Codex phase submit carries. The cq-mcp side does
 * NOT know each phase's schema — it relays the model-emitted object verbatim
 * (`z.unknown()`); the server's `WorkflowSubmitProxy` validates it against the
 * phase's own schema and ack{ok:false} on a malformed payload so no half-
 * written ledger results. This keeps the relay schema-agnostic, exactly as
 * `ask.request` carries `questions` as `z.unknown()` elements.
 */
export const WorkflowSubmitPayload = z.unknown();
export type WorkflowSubmitPayload = z.infer<typeof WorkflowSubmitPayload>;

/**
 * Envelope union. New variants must keep `sourcePid` so loop-detection
 * stays uniform.
 */
export const InternalWsMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ledger.changed"),
    ledgerId: z.string().min(1),
    op: LedgerOp,
    /**
     * PID of the process that produced this message. Receivers MUST
     * drop messages whose sourcePid matches their own process.pid so
     * loops (or accidental self-broadcast) terminate.
     */
    sourcePid: z.number().int().nonnegative(),
  }),
  /**
   * cq-mcp → cq-server: the Codex session's `ask_user_question` tool was
   * invoked. The server drives the browser ask UI for `sessionId`, awaits
   * the user's `chat.question_reply` for `toolUseId`, and replies with an
   * `ask.reply` carrying the same `askId`.
   */
  z.object({
    type: z.literal("ask.request"),
    /** Unique per ask; generated by cq-mcp; keys the broker + ask.reply. */
    askId: z.string().min(1),
    /** MCP tool_use id; correlation + the browser's ask-card render key. */
    toolUseId: z.string().min(1),
    /** The cq chat session this ask belongs to. */
    sessionId: z.string().min(1),
    /** The model-emitted questions array (1..4 entries). */
    questions: AskQuestions,
    sourcePid: z.number().int().nonnegative(),
  }),
  /**
   * cq-server → cq-mcp: the user answered the ask identified by `askId`.
   * The matching cq-mcp broker resolves its parked tool handler; any other
   * connected cq-mcp drops the message (unknown askId).
   */
  z.object({
    type: z.literal("ask.reply"),
    askId: z.string().min(1),
    answers: AskAnswers,
    sourcePid: z.number().int().nonnegative(),
  }),
  /**
   * cq-mcp → cq-server: a Codex `/plan` phase subagent called its harness-owned
   * `submit_workflow_phase` tool. cq-mcp relays the model's structured payload
   * upstream; the server's `WorkflowSubmitProxy` correlates `submitId` to the
   * waiting headless-Codex dispatch, validates `payload` against the `phase`'s
   * Zod schema, hands the validated value to the WorkflowRuntime (which writes
   * the ledgers), and replies `workflow.submit_ack`. cq-mcp NEVER writes
   * ledgers for this tool — it relays only.
   */
  z.object({
    type: z.literal("workflow.submit"),
    /** Unique per submit; generated by cq-mcp's broker; keys the ack. */
    submitId: z.string().min(1),
    /** Which `/plan` phase this submit belongs to (selects the schema). */
    phase: WorkflowSubmitPhase,
    /** The model-emitted structured payload (validated server-side per phase). */
    payload: WorkflowSubmitPayload,
    sourcePid: z.number().int().nonnegative(),
  }),
  /**
   * cq-server → cq-mcp: the server processed the `workflow.submit` identified by
   * `submitId`. `ok:true` → the payload validated and the harness accepted it
   * (the model's submit tool returns success so the Codex turn ends cleanly).
   * `ok:false` with `error` → validation failed or no dispatch was waiting; the
   * model's submit tool returns the error so it can retry or the phase errors
   * loudly. The matching cq-mcp broker resolves its parked tool handler; any
   * other connected cq-mcp drops the message (unknown submitId).
   */
  z.object({
    type: z.literal("workflow.submit_ack"),
    submitId: z.string().min(1),
    ok: z.boolean(),
    error: z.string().optional(),
    sourcePid: z.number().int().nonnegative(),
  }),
]);
export type InternalWsMessage = z.infer<typeof InternalWsMessage>;

/** Discriminator literal of any `InternalWsMessage`. */
export type InternalWsMessageType = InternalWsMessage["type"];
