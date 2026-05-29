# outer-13 / coherence — plan doc

**Cycle:** coherence (cross-process cache invalidation between cq-server
and cq-mcp via an internal WebSocket channel).

**Goal:** close the cross-process cache-coherence gap. cq-server and
cq-mcp each open independent `FsLedgerStore` instances against the same
`docs/` directory. The advisory lockfile keeps on-disk state consistent
but neither process invalidates its **in-memory** cache when the other
writes. A Codex session that creates a ledger via `mcp__cq__create_ledger`
is invisible to cq-server until restart.

Ship a per-process internal WebSocket channel that delivers
`ledger.changed` invalidation notifications between the two processes.

**Baseline (verified, this worktree, HEAD `cb93b00`):**
- `bun run check` → 718 pass / 0 fail / 0 error / 2567 expect() across 86 files (per the active ledger).
- `bun run e2e` → 20 pass / 0 skip / 0 fail.
- `nix build .#default` → exit 0 (per outer-12 discharge metrics).

---

## 0. Design decisions (from brief; locked here)

1. **Same `Bun.serve`, separate path with token auth.** Add a new path
   `/__internal/cq-mcp` to the existing server. cq generates a per-process
   random hex token at startup (`crypto.randomBytes(16).toString("hex")`)
   and passes it to spawned cq-mcp instances via `CQ_INTERNAL_WS_TOKEN`
   alongside `CQ_INTERNAL_WS_URL`. cq-mcp sends the token in the
   `Sec-WebSocket-Protocol` header as `cq-internal.<token>`. The
   server's upgrade handler:
   1. routes by path,
   2. validates the suffix against the per-process token via
      `crypto.timingSafeEqual` (rejects HTTP 401 on mismatch — never with
      a 1000-class WS close code, because the failure happens pre-upgrade),
   3. echoes the `cq-internal.<token>` subprotocol in the response by
      setting `Sec-WebSocket-Protocol` on the upgrade headers.
   - The internal path is NOT subject to the same-origin check (no
     Origin header is sent by a Node/Bun WS client).

2. **Crash cq-mcp loudly on connect failure.** If `CQ_INTERNAL_WS_URL`
   is set:
   - `CQ_INTERNAL_WS_TOKEN` must also be set (fatal if missing).
   - Connect with a 5-second timeout. On failure (timeout, refused,
     401, malformed handshake) log a clear stderr line and exit code 2:
     `cq-mcp: failed to connect to cq internal WS at <url>: <reason>`.
   - On success: register tools, start the stdio MCP server, install
     the bidirectional message router.
   If `CQ_INTERNAL_WS_URL` is NOT set, log a single informational line
   (`cq-mcp: running without internal WS channel; ledger cache
   invalidation disabled`) and proceed — preserves the existing
   standalone test in `packages/cq-mcp/test/main.test.ts`.

3. **Extensible router from day 1.** All messages share a discriminated-
   union Zod envelope in `packages/shared/src/internalProtocol.ts`. Each
   side has a `handlers: Map<MessageType, Handler>` registry. Adding a
   new message type is one new variant in the union plus one handler.
   Unknown types are dropped with a warning (not an error — forward-
   compatibility). Outbound writes go through a single
   `send(msg: InternalWsMessage)` that Zod-validates first.

   THIS CYCLE only registers `ledger.changed`. No speculative types.

---

## 1. PR breakdown

One commit per PR. Tag `coherence-N`. Each PR's verification is run
before its commit. `bun run check` must remain green at every PR
boundary except where the discriminated-union schema is added before
its consumers (in which case it must self-test).

### PR coherence-1 — internal protocol envelope (shared)

**Scope:** new file `packages/shared/src/internalProtocol.ts` plus
export from `packages/shared/src/index.ts`. Tests in
`packages/shared/test/internalProtocol.test.ts`.

**Schema (verbatim):**
```ts
export const LedgerOp = z.enum(["create", "update", "archive"]);
export type LedgerOp = z.infer<typeof LedgerOp>;

export const InternalWsMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ledger.changed"),
    ledgerId: z.string(),
    op: LedgerOp,
    sourcePid: z.number().int(),
  }),
]);
export type InternalWsMessage = z.infer<typeof InternalWsMessage>;

export type InternalWsMessageType = InternalWsMessage["type"];
```

Also: a constant `INTERNAL_WS_PATH = "/__internal/cq-mcp"` and a
`INTERNAL_WS_SUBPROTOCOL_PREFIX = "cq-internal"` so client/server agree.

**Tests:** Zod round-trip happy-path for `ledger.changed`; malformed
envelopes (missing fields, wrong types, unknown discriminant) rejected;
the unknown-discriminant rejection emits a stable Zod-style error
shape we can match against.

**Verification:** `bun test packages/shared` green; `tsc -b` clean.

---

### PR coherence-2 — `FsLedgerStore` mutation hook + `invalidate()`

**Scope:** modify `packages/ledger/src/store/{FsLedgerStore,InMemoryLedgerStore,LedgerStore}.ts`.

**LedgerStore interface additions:**
```ts
/** Fires after every successful write. MUST be synchronous-callable. */
onMutation?: (ledgerId: string, op: LedgerOp) => void;
invalidate(ledgerId: string): Promise<void>;
```
(`onMutation` is a CONSTRUCTOR option, not an interface field; the
`invalidate` method belongs on the interface so callers don't need to
narrow.)

**`FsLedgerStoreOpts` gains:**
```ts
onMutation?: (ledgerId: string, op: "create" | "update" | "archive") => void;
```
Hook fires AFTER the lockfile is released and after the in-memory map
is updated. If the hook throws, log via `process.stderr.write` and
continue — must not unwind the write.

**Hook firing matrix** (verified against `store/core.ts` mutation
entry points):
- `createLedger(name, schema)` → `onMutation(name, "create")`
- `createMilestone(init)` → `onMutation(MILESTONES_LEDGER, "create")`
- `createItem(ledger, m, init)` → `onMutation(ledger, "create")`
- `updateItem(ledger, id, patch)` → `onMutation(ledger, "update")`
- `updateMilestone(id, patch)` → `onMutation(MILESTONES_LEDGER, "update")`
- `archiveMilestone(id, summary)` → for each participating ledger
  (incl. the milestones ledger) fire `onMutation(ledger, "archive")`.
  Fire AFTER all per-ledger writes complete so cross-process readers
  don't see a partially-archived state.

Reads (`fetch`, `fetchItem`, etc.) do NOT fire.

**`invalidate(ledgerId)`:**
- No-op if `!this.ledgers.has(ledgerId)` (graceful — the other process
  may have created a ledger we haven't yet learned about; first
  invalidation on a fresh-to-us ledger is handled via the registry
  reload path below).
- Otherwise: acquire the per-ledger mutex+lockfile (same discipline as
  writes), drop the cached `Ledger`, re-read `docs/<ledger>.md` from
  disk, parse, install in the map. Release the lock. Synchronous in
  in-memory store (no-op since there is no disk source of truth).

**Registry reload caveat (addressed but minimal in this PR):**
The brief's invalidate contract is per-ledger; if the OTHER process
created a brand-new ledger, our registry has no entry, so we'd no-op
and miss it. Fix: when `invalidate(ledgerId)` is called on an unknown
ledger, reload the registry under the registry lock and, if the ledger
is now in it, load and cache it. This is the surgical extension needed
to actually fix the user-visible scenario in the brief (Codex creates
`manual-test`; cq-server must see it). Without this, cache invalidation
covers update/archive but not create across processes.

**Mirror in `InMemoryLedgerStore`:** `onMutation` opt accepted; hook
fires at the same boundaries; `invalidate` is a no-op (the in-memory
adapter is the source of truth — there is no other writer).

**Tests:** new abstract-suite cases in `store-abstract.ts` (apply to
both adapters):
- `onMutation` fires exactly once per mutation type, with the right
  `(ledgerId, op)` pair, for each of the six entry points.
- `onMutation` throwing does not unwind the write (the item is still
  present afterwards) and the error surface is stable (asserted via a
  captured stderr buffer fed in by the test).
- `invalidate(ledgerId)` is a no-op when the ledger isn't registered.

Plus FS-only tests in `store-fs.test.ts` (cross-instance, can't run
on the in-memory adapter):
- Two `FsLedgerStore` instances, same tmp dir. A writes a new item via
  `updateItem`. B's `fetchItem` returns stale. `B.invalidate(ledger)`.
  B's `fetchItem` returns fresh.
- `createLedger` on A, then `B.invalidate("new-ledger")` makes B see
  it via `enumerate()` and `fetch()`.

**Verification:** `bun test packages/ledger` green; +12..+18 new tests.

---

### PR coherence-3 — server-side internal WS service

**Scope:** new file `packages/server/src/agent/internalWs.ts` plus
wire-up in `packages/server/src/server.ts` (and `devServer.ts` if it
needs the channel — for now devServer can skip it; the brief's
manual-test scenario uses `bun run dev` which is `devServer.ts`, so we
**do** wire it into both).

**`InternalWsService` (constructor):**
- Generates token via `crypto.randomBytes(16).toString("hex")`.
- Holds `handlers: Map<MessageType, (msg) => void>`.
- Holds `sockets: Set<ServerWebSocket<InternalWsData>>` for broadcast.
- `tokenForChild(): string` returns the token.
- `registerHandler<T>(type: T, fn: (msg: …) => void): void`.
- `broadcast(msg: InternalWsMessage): void` — Zod-validate, send to all
  in `sockets`. Loop-detection happens on RECEIVE, not on broadcast,
  because the message we broadcast already carries our own pid.
- `handleUpgrade(req, srv, sessionId): Response | undefined` — returns
  401 Response on bad token; calls `srv.upgrade(req, { data, headers:
  { "Sec-WebSocket-Protocol": "cq-internal.<token>" } })` on accept;
  returns undefined when upgrade succeeds (Bun convention).
- `open(ws)`, `message(ws, raw)`, `close(ws, code, reason)` — the Bun
  WS callbacks used by the server's outer `websocket:` block.

**Token parsing:** the WS client sends ONE subprotocol value of the
form `cq-internal.<hex>`. We:
1. Read `req.headers.get("Sec-WebSocket-Protocol")`. If null or empty
   → 401.
2. There may be multiple comma-separated values per RFC 6455. Iterate;
   for each: trim whitespace, split into prefix + suffix on the FIRST
   `.`. Accept the first one with prefix `cq-internal`.
3. Hex-decode the suffix (catch errors → 401). The expected token is
   also hex; compare via `crypto.timingSafeEqual` on equal-length
   `Buffer`s. Different lengths → 401 (constant-time-ness is irrelevant
   when lengths leak, but we still avoid `===` so the comparison is
   uniform).

**Inbound routing (`message`):**
- JSON-parse; on failure, log and drop.
- `InternalWsMessage.safeParse(...)`; on failure, log and drop (with
  type-name detail when available, so unknown discriminants are
  obvious).
- If `msg.sourcePid === process.pid` → drop (loop detection — defends
  against a future case where two server processes share the channel;
  with the current 1-server-1-client topology it never fires, but the
  brief calls for it explicitly).
- Look up `handlers.get(msg.type)`. If absent, log a warning and
  continue (forward-compat). If present, call it; catch + log
  exceptions — handlers must not crash the WS layer.

**Wiring in `server.ts` and `devServer.ts`:**
- Construct `InternalWsService` once at startup.
- Pass `onMutation` to `FsLedgerStore` constructor: it calls
  `internalWs.broadcast({type: "ledger.changed", ledgerId, op,
  sourcePid: process.pid})`.
- Register `ledger.changed` inbound handler: calls
  `ledgerStore.invalidate(ledgerId)` (await dropped — handler signature
  is `void`-returning so we kick it off; exceptions go to the inbound
  router's catch).
- In the `Bun.serve` `fetch` handler: BEFORE the `/ws` browser branch,
  route `/__internal/cq-mcp` to `internalWs.handleUpgrade`.
- In the `websocket:` block: branch on `ws.data.kind === "internal"`
  vs `"browser"` so the existing browser-session callbacks aren't
  affected. (We change `WsSessionData` to a discriminated union, or
  introduce a parallel `InternalWsData`.)
- Expose `internalWsTokenForChild()` and the URL `ws://<host>:<port>/
  __internal/cq-mcp` via `RunningServer` so `CodexBridge` can read them.

**Port-binding race (adversarial focus):** the URL must reflect the
bound port (not the requested port — Bun may pick an ephemeral port
when `port: 0`). Pull it from `server.url` after `Bun.serve(...)`
returns. The `RunningServer.internalWsUrl` getter returns it.

**Tests** in `packages/server/test/internalWs.test.ts`:
- Token generation produces a 32-char hex string (16 bytes).
- `handleUpgrade` rejects (401) when:
  - `Sec-WebSocket-Protocol` header is missing,
  - prefix mismatch,
  - token suffix is wrong length,
  - token suffix is wrong value (constant-time check still rejects).
- `handleUpgrade` accepts when the subprotocol matches and echoes
  `cq-internal.<token>` in the response. Asserted via a Bun.serve
  smoke harness + a Bun WebSocket client that requests the subprotocol.
- Inbound: a valid `ledger.changed` from a foreign pid routes to the
  registered handler. A `ledger.changed` whose `sourcePid ===
  process.pid` is dropped. An envelope with `type:"unknown.thing"` is
  dropped with a warning, not an exception. Malformed JSON is dropped.

**Verification:** `bun test packages/server/test/internalWs.test.ts`
green; +8..+12 new tests.

---

### PR coherence-4 — cq-mcp client + wire-up

**Scope:**
- new `packages/cq-mcp/src/internalWs.ts` (client channel),
- `packages/cq-mcp/src/main.ts` reads env vars, connects on startup,
  wires `onMutation → channel.send` and `ledger.changed → store.invalidate`,
- `packages/server/src/agent/codexBridge.ts` passes
  `CQ_INTERNAL_WS_URL` and `CQ_INTERNAL_WS_TOKEN` env vars to spawned
  cq-mcp.

**`InternalWsChannel.connect({url, token, logger})`:**
- Open `new WebSocket(url, { protocols: ["cq-internal." + token] })`
  (Bun's WS client supports `protocols`).
- Race against a 5-second timeout. On open → resolve with `Channel`.
  On error/close-before-open → reject with `Error(reason)`. On timeout
  → reject with `Error("timeout after 5000ms")`. ALL three failure
  paths funnel into the same `cq-mcp: failed to connect ...` stderr
  line + exit(2) at the call site.
- After open, install `onmessage` handler that mirrors the server's:
  JSON-parse → Zod-parse → loop-drop → dispatch via `handlers`.

**`Channel.send(msg)`:** Zod-validate; if invalid, log and drop (don't
crash the binary). Otherwise `socket.send(JSON.stringify(msg))`.

**`Channel.registerHandler(type, fn)`:** same as server.

**`Channel.close()`:** graceful close (code 1000).

**`packages/cq-mcp/src/main.ts` wiring:**
1. `parseArgs(argv)` as today.
2. Read `CQ_INTERNAL_WS_URL` + `CQ_INTERNAL_WS_TOKEN`.
3. Validate: if URL set, token MUST be set; if URL set + token missing
   → stderr fatal + exit(2).
4. If URL+token set, `try { await InternalWsChannel.connect(...) } catch
   → stderr + exit(2)`.
5. Wire `store = new FsLedgerStore({ root: cwd, onMutation: (lid, op)
   => channel?.send({type:"ledger.changed", ledgerId:lid, op, sourcePid:
   process.pid}) })`.
6. `channel?.registerHandler("ledger.changed", (msg) => {
      void store.invalidate(msg.ledgerId).catch(err =>
        process.stderr.write(\`cq-mcp: invalidate failed: ${err}\n\`))
   })`.
7. `process.on("SIGTERM" | "SIGINT", () => { channel?.close(); ... })`.
8. If URL is NOT set, log the standalone-mode message and proceed —
   `onMutation` undefined, store still works.

**`codexBridge.ts` wiring:**
- `CodexBridgeOpts` gains `internalWsUrl?: string` and
  `internalWsToken?: string` (both optional; injecting them is the way
  the server wires this).
- In `handleChatStart`, when constructing the `CodexOptions` config,
  add `env` to the `mcp_servers.cq` entry: `{ command, args, env: {
  CQ_INTERNAL_WS_URL, CQ_INTERNAL_WS_TOKEN } }`. Verify the codex-sdk
  supports `mcp_servers.<name>.env` (it does — TOML pass-through; the
  Codex CLI honors it).

  **Open question to verify in implementation:** does the codex-sdk's
  serialization of `CodexOptions.config.mcp_servers.cq.env` carry
  through to the spawned process's env? If not, fall back to setting
  the env on the parent (Codex CLI inherits) or to passing on the
  command line via additional `--env` flags. Investigated under PR-4.

**Tests** in `packages/cq-mcp/test/`:
- Existing `main.test.ts` (standalone, no env vars set) MUST remain
  green with no edits. Adding the env reads must not alter the default
  path.
- New `packages/cq-mcp/test/internalWs.test.ts`: spawn a Bun.serve
  fake internal WS, set the env vars, run cq-mcp; assert it connects,
  invalidates on receive, and sends on store mutation. The "shutdown
  cleanly" assertion is just `expect(exit code).toBe(0)` on SIGTERM.

**Verification:** `bun test packages/cq-mcp` green; +3..+5 new tests.

---

### PR coherence-5 — cross-process integration test

**Scope:** new `packages/server/test/internalWs-integration.test.ts`.

Drive a real cq-mcp subprocess (resolved via `defaultResolveCqMcpBin`
or by `bun run` against the source) against a real cq-server `Bun.serve`
instance:

1. Start cq-server in a tmp cwd; capture `internalWsUrl` + token.
2. Spawn cq-mcp with `CQ_INTERNAL_WS_URL` + `CQ_INTERNAL_WS_TOKEN` and
   `--cwd <same>`.
3. Connect a fresh `Client` from `@modelcontextprotocol/sdk` to the
   spawned cq-mcp via `StdioClientTransport`.
4. Call `create_ledger("itest", schema)` through the MCP client.
5. Poll up to 1 second: `server.ledgerStore.enumerate()` includes
   `"itest"`. Asserts the cq-server's in-memory cache was invalidated
   by the WS notification.
6. Conversely, mutate via cq-server (e.g. `createMilestone`) and
   observe the cq-mcp invalidation by reading via its MCP tools.

**Verification:** `bun test packages/server/test/internalWs-integration.test.ts`
green.

---

### PR coherence-6 — discharge & ledgers

**Scope:** no source changes. Update `tasks.md` (mark milestone done,
rich `Completed` entry); update `defects.md` rows for any defects
opened+closed during cycles; write `docs/logs/20260529-…-coherence-log.md`.

Run the discharge battery:
- `bun run check`
- `bun run e2e`
- `nix build .#default`
- Manual `bun run dev` scenario per brief.

---

## 2. Cross-cutting design (locked decisions)

- **D-COHERENCE — race window: read between WRITE and WS LANDING.**
  This window cannot be closed entirely — the brief explicitly accepts
  eventual consistency in the seconds-scale "Codex creates ledger; cq
  sees it" scenario. The invariant we DO maintain: every write commits
  to disk before the hook fires; the hook fires before any new reader
  sees the broadcast; and the receiver's `invalidate` re-reads from
  disk under the per-ledger lock — so the receiver always converges.
  Bounded staleness; no torn reads.

- **D-COHERENCE — race: hook fires BEFORE lockfile released.**
  Specification: the hook fires AFTER the lockfile is released. The
  receiver then takes the lock to re-read. If we fired the hook
  inside the lock, the receiver's lock acquisition could race the
  releaser and momentarily block. Firing after release is simpler and
  the in-memory state is already consistent at that point.

- **D-COHERENCE — token timing-safe compare.** Use
  `crypto.timingSafeEqual` on equal-length `Buffer`s. Different-length
  inputs short-circuit before the timing-safe call — acceptable
  because token length is a 32-char invariant; length leakage is not
  a threat in this model.

- **D-COHERENCE — port-binding race.** Read the bound port from
  `server.url` AFTER `Bun.serve(...)` returns; do not assume the
  requested port. `CodexBridge` reads it from `RunningServer`'s
  `internalWsUrl` getter.

- **D-COHERENCE — multi-server topology.** Out of scope for this
  cycle. Loop-detection via `sourcePid` exists so a hypothetical
  multi-process setup doesn't cause an infinite ping-pong, but no
  feature relies on it. The `Map<pid,…>` would extend to multi-process
  trivially.

- **No reconnection logic.** Per brief constraint. cq-mcp is short-
  lived per Codex session; on disconnect we log and continue serving
  stdio MCP. Cache invalidation is then disabled for that session.

- **Browser-facing protocol UNCHANGED.** Per brief constraint. The
  same-origin check still runs for `/ws` and is bypassed for
  `/__internal/cq-mcp`. The browser cannot reach the internal path
  without the per-process token (which it never has).

---

## 3. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `Sec-WebSocket-Protocol` echo doesn't reach the Bun WS client | medium | high (handshake fails silently) | Tested in PR-3 via a Bun WS client requesting the subprotocol; assert the client receives `cq-internal.<token>` back. |
| codex-sdk `mcp_servers.<n>.env` does not propagate | medium | high (env vars not delivered to cq-mcp) | PR-4: write a one-off probe; if it doesn't propagate, fall back to passing on the command line as additional `args`. |
| `FsLedgerStore.invalidate(unknown_id)` no-ops and we miss new ledgers | high | high (the literal user-visible scenario) | Reload the registry under the registry lock when invalidate is called on an unknown ledger. Tested in PR-2. |
| `archiveMilestone` fires one hook per ledger or one total — semantics drift | low | medium | Firing per-ledger AFTER all writes is the contract. Asserted in tests. |
| Bun.WebSocket client `protocols` not honored | low | high | Verified by the integration test in PR-5; if it isn't, fall back to setting the header on a raw HTTP CONNECT (out of scope; defer). |
| Token exposure via logs | low | low | `tokenForChild()` returns the token but it's only used in the spawn-env. Don't log it. Rely on standard process isolation. |

---

## 4. Acceptance criteria (final)

- `bun run check` green; +15..+25 net new passing tests vs the
  baseline of 718/0 (subject to defects opened+closed during cycles).
- `bun run e2e` retains 20/0/0.
- `nix build .#default` exit 0; `cq-mcp` still smoke-tests against
  `--cwd /tmp/…` with no env vars set (standalone mode preserved).
- Manual scenario green: `bun run dev` → Codex agent creates a
  ledger via `mcp__cq__create_ledger` → cq's `FsLedgerStore.enumerate()`
  reflects the new ledger without restart (poll within 1 second).
- All prior D-OUTER\*/D-CQMCP\*/D-GC\* defects remain `[x] resolved`.
- New D-COHERENCE-NN rows per defect surfaced and closed.
