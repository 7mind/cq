/**
 * Internal WebSocket protocol — cq-server ↔ cq-mcp channel envelopes.
 *
 * Two processes own independent in-memory caches of the same on-disk
 * `docs/` tree. The advisory lockfile (D-LED) keeps disk consistent;
 * this protocol delivers per-process cache-invalidation notifications
 * so a write on one side is reflected on the other without restart.
 *
 * Schema is a discriminated union. THIS CYCLE registers exactly one
 * variant — `ledger.changed`. Future cycles (orchestrator /
 * classification / Q&A bridging — see
 * `docs/drafts/20260528-2129-canonical-ledger-schemas.md`) add new
 * variants without breaking the wire shape: receivers drop unknown
 * `type` values with a warning rather than rejecting the channel.
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
]);
export type InternalWsMessage = z.infer<typeof InternalWsMessage>;

/** Discriminator literal of any `InternalWsMessage`. */
export type InternalWsMessageType = InternalWsMessage["type"];
