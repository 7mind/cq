import path from "node:path";
import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import type { Logger } from "./log/logger";
import { WsSession, type WsSessionData } from "./ws/session";
import { isOriginAllowed } from "./ws/origin";
import { Bridge } from "./agent/bridge";
import { SessionRegistry } from "./seq/sessionRegistry";
import { SqlitePersistence } from "./persist/SqlitePersistence.js";
import { FsLedgerStore } from "@cq/ledger";
import { initLedgerStoreOrExit } from "./ledgerInit";
import { INTERNAL_WS_PATH, InternalWsService, type InternalWsConnData } from "./agent/internalWs";
import { AggregateActivityTracker } from "./ws/activityTracker";
import {
  WorkflowRuntime,
  WorkflowSubmitProxy,
  ClaudeProducer,
  CodexProducer,
  ClaudePhaseSubagent,
  CodexPhaseSubagent,
  makeSubmitIdGenerator,
} from "./workflow/index";

export type ServerConfig = Readonly<{
  host: string;
  port: number;
  webOutdir: string;
  cwd: string;
  dbPath: string;
  logger: Logger;
}>;

export type RunningServer = {
  stop(): void | Promise<void>;
  /** Prevent new WebSocket upgrades (called at start of graceful shutdown). */
  markDraining(): void;
  /** Close all tracked WebSocket connections with code 1012 (service restart). */
  closeAllSockets(code: number, reason: string): void;
  /** The Bridge instance managing the active SDK query. */
  readonly bridge: Bridge;
  /** The WorkflowRuntime managing the `/plan` dispatch lane. */
  readonly workflow: WorkflowRuntime;
  /** The Persistence adapter (needed for close() in shutdown). */
  readonly persistence: SqlitePersistence;
  /**
   * URL the spawned cq-mcp uses to dial the internal channel. Built
   * from the bound port (NOT the requested port — Bun's `port: 0`
   * picks an ephemeral one).
   */
  readonly internalWsUrl: string;
  /** Token to pass to spawned cq-mcp via env. */
  readonly internalWsToken: string;
};

type WsData = WsSessionData | InternalWsConnData;

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const { host, port, webOutdir, cwd, dbPath, logger } = config;

  // Shared registry and bridge (pool=1 across all connections).
  const registry = new SessionRegistry();
  // Ensure the parent directory exists for file-backed databases.
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const persistence = new SqlitePersistence(dbPath, undefined, logger);
  // Internal WS service runs alongside the browser WS handler; it
  // owns a per-process token used to authenticate spawned cq-mcp
  // subprocesses. Constructed before the ledger store so we can wire
  // its broadcast into `onMutation`.
  const internalWs = new InternalWsService({ logger });
  // Ledger store rooted at the same cwd so docs/<ledger>.md sit next to
  // the agent's working tree. init() loads docs/ledgers.yaml and every
  // registered ledger; missing files are created with empty content.
  // onMutation broadcasts every successful write to all connected
  // cq-mcp clients so they invalidate their caches (D-COHERENCE).
  const ledgerStore = new FsLedgerStore({
    root: cwd,
    onMutation: (ledgerId, op) => {
      internalWs.broadcast({
        type: "ledger.changed",
        ledgerId,
        op,
        sourcePid: internalWs.selfPid(),
      });
    },
  });
  // Humane startup: a BootstrapViolationError (on-disk ledger schema diverged
  // from the current build) is re-presented as an actionable `cq reset`
  // instruction instead of a raw stack trace; other errors propagate.
  await initLedgerStoreOrExit(ledgerStore);
  // Inbound `ledger.changed` from any cq-mcp triggers a local
  // invalidate. Loop-detection (sourcePid === our pid) is enforced
  // inside the service before the handler runs.
  internalWs.registerHandler("ledger.changed", async (msg) => {
    try {
      await ledgerStore.invalidate(msg.ledgerId);
    } catch (err: unknown) {
      logger.warn("ledger.invalidate_failed", {
        ledgerId: msg.ledgerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  // The internal WS URL depends on the bound port, which we only learn
  // after Bun.serve(...) returns. Wire the bridge with a placeholder
  // for now; we MUST refresh it before the first Codex session starts.
  // Approach: a one-shot pre-bind handler that sets it on Bridge. See
  // below — we mutate the bridge.opts after `server.url` resolves.
  // ACTIVITY-01: aggregate compute-activity tracker. Declared before the lanes
  // so the lanes' change callbacks can reference it; assigned after the lanes
  // exist (its read closures need `bridge` + `workflow`). The callbacks are only
  // INVOKED on a lane transition, long after construction, so the late binding
  // is safe. Observe-only: it never routes the workflow through the Bridge and
  // never changes pool=1.
  let activityTracker: AggregateActivityTracker | undefined = undefined;
  const bridge = new Bridge({
    logger,
    registry,
    cwd,
    persistence,
    ledgerStore,
    internalWsToken: internalWs.tokenForChild(),
    // askproxy / outer-14: ask.reply travels upstream via broadcast (askId
    // discriminates across connected cq-mcp children).
    sendAskReply: (msg) => internalWs.broadcast(msg),
    // ACTIVITY-01: every chat-lane busy transition (turn start/end) recomputes
    // and pushes the aggregate running count.
    onBusyChange: () => activityTracker?.onLaneChange(),
  });
  // WorkflowSubmitProxy (codexwf) — server side of the Codex /plan structured-
  // output relay. A headless-Codex phase dispatch registers a submitId here;
  // the cq-mcp child relays the model's payload as `workflow.submit`; this
  // proxy validates it against the phase schema and resolves the dispatch. The
  // HARNESS (WorkflowRuntime) then writes the ledgers — cq-mcp relays only.
  const submitProxy = new WorkflowSubmitProxy({
    logger,
    sendAck: (submitId, ok, error) =>
      internalWs.broadcast({
        type: "workflow.submit_ack",
        submitId,
        ok,
        ...(error !== undefined ? { error } : {}),
        sourcePid: internalWs.selfPid(),
      }),
  });
  // The internal-WS URL is known only after Bun.serve binds (port: 0 ⇒
  // ephemeral). The Codex headless lane reads it lazily per dispatch, so a
  // mutable holder set after bind suffices (mirrors bridge.setInternalWsUrl).
  let internalWsUrlHolder = "";
  const internalWsToken = internalWs.tokenForChild();
  const nextSubmitId = makeSubmitIdGenerator(internalWs.selfPid());

  // WorkflowRuntime (`/plan`) — own dispatch lane, separate from the pool=1
  // interactive Bridge. The headless producer constructs its own SDK query
  // (Claude path) or spawns a headless Codex thread + cq-mcp relay (Codex
  // path, codexwf); it never touches Bridge.active. The runtime is the HARNESS
  // that writes the ledgers.
  const workflow = new WorkflowRuntime({
    logger,
    store: ledgerStore,
    // wfhist: record each `/plan` run as its own History entry (workflow-kind
    // session + root + per-phase child invocations), written DIRECTLY via the
    // Persistence adapter — never through the interactive Bridge (pool=1 holds).
    persistence,
    cwd,
    selectProducer: (platform) =>
      platform === "codex"
        ? new CodexProducer({
            logger,
            cwd,
            submitProxy,
            internalWsUrl: internalWsUrlHolder,
            internalWsToken,
            nextSubmitId,
          })
        : new ClaudeProducer({ logger, cwd }),
    selectPhaseSubagent: (platform) =>
      platform === "codex"
        ? new CodexPhaseSubagent({
            logger,
            cwd,
            submitProxy,
            internalWsUrl: internalWsUrlHolder,
            internalWsToken,
            nextSubmitId,
          })
        : new ClaudePhaseSubagent({ logger, cwd }),
  });
  // Inbound `workflow.submit` from a Codex workflow's cq-mcp child → validate +
  // resolve the waiting dispatch (codexwf). The proxy acks the child either way.
  internalWs.registerHandler("workflow.submit", async (msg) => {
    submitProxy.onSubmit({ submitId: msg.submitId, phase: msg.phase, payload: msg.payload });
  });
  // ACTIVITY-01: construct the aggregate tracker now that both lanes exist, and
  // wire the workflow lane's activity callback. running = chat-busy (0/1) +
  // workflow active phase-dispatch count. The chat lane's callback was wired in
  // the Bridge ctor above (it reads `activityTracker` lazily through the closure).
  activityTracker = new AggregateActivityTracker({
    // ACTIVITY-01: the chat lane contributes 1 only while a TURN is streaming
    // (the model is working), NOT for the whole multi-turn session lifetime —
    // `isTurnInFlight()` is false between turns, so the badge returns to IDLE.
    isChatBusy: () => bridge.isTurnInFlight(),
    workflowActiveDispatchCount: () => workflow.activeDispatchCount(),
  });
  workflow.onActivityChange(() => activityTracker?.onLaneChange());

  // Resume any goal mid-loop from ledger state (closes WF-D02). Goals waiting on
  // open questions sit idle until a `question.answer` arrives.
  await workflow.reconcile();

  // Inbound `ask.request` from a Codex session's cq-mcp drives the browser
  // ask UI for that session and proxies the answer back (askproxy / outer-14).
  internalWs.registerHandler("ask.request", async (msg) => {
    bridge.handleAskRequest({
      askId: msg.askId,
      toolUseId: msg.toolUseId,
      sessionId: msg.sessionId,
      questions: msg.questions,
    });
  });

  // Track all open WS sockets for graceful close-with-code.
  type WsHandle = { close(code?: number, reason?: string): void };
  const openSockets = new Set<WsHandle>();
  let draining = false;

  const server = Bun.serve<WsData>({
    hostname: host,
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // ── Internal WS upgrade ───────────────────────────────────────── //
      // The cq-mcp subprocess dials `/__internal/cq-mcp` with a token
      // in `Sec-WebSocket-Protocol`. NOT subject to the same-origin
      // check (Node/Bun WS clients send no Origin header). Token check
      // is constant-time. Refuses 503 while draining like /ws.
      if (pathname === INTERNAL_WS_PATH) {
        if (draining) return new Response("Service Unavailable", { status: 503 });
        return internalWs.handleUpgrade(req, srv) ?? new Response("Upgrade required", { status: 426 });
      }

      // ── E2E test hook ────────────────────────────────────────────────── //
      // POST /__e2e/interrupt: force-clears bridge.active so the next test
      // starts with a clean slate. Only enabled when CQ_E2E_HOOKS=1 (set by
      // the Playwright globalSetup), refusing the route in production. This
      // is the minimum surface Playwright needs for reliable test teardown
      // when the SDK subprocess takes long to drain.
      if (pathname === "/__e2e/interrupt" && process.env["CQ_E2E_HOOKS"] === "1") {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        try {
          // Abort any in-flight workflow producer first so its headless SDK
          // subprocess cannot leak into the next test, then clear the chat.
          workflow.abortActive();
          bridge.interruptActive();
          await bridge.shutdown();
          // Await actual workflow-subprocess teardown so no draining child
          // leaks into the next serial spec (WFL-D02). abortActive() only
          // signals the abort; whenDrained() blocks until the child is reaped.
          await workflow.whenDrained();
          return new Response("ok", { status: 200 });
        } catch (err) {
          logger.warn("e2e.interrupt_failed", { err: String(err) });
          return new Response("interrupt failed", { status: 500 });
        }
      }

      // ── E2E test hook ────────────────────────────────────────────────── //
      // GET /__e2e/workflow-idle: report whether the workflow lane is idle, so a
      // workflow-heavy spec can wait for its subprocesses to drain before the
      // next spec starts (reduces cross-spec subprocess contention).
      if (pathname === "/__e2e/workflow-idle" && process.env["CQ_E2E_HOOKS"] === "1") {
        return new Response(JSON.stringify({ busy: workflow.isBusy() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // ── E2E test hook ────────────────────────────────────────────────── //
      // POST /__e2e/workflow-drain: await full teardown of every workflow SDK
      // subprocess (producer + loop phases) so a workflow-heavy spec leaves NO
      // lingering child processes before the next serial spec runs. Unlike the
      // workflow-idle busy flag — which clears at submit-time, before
      // query().close() finishes reaping the child — this blocks until the
      // subprocesses are actually gone (WFL-D02). Only when CQ_E2E_HOOKS=1.
      if (pathname === "/__e2e/workflow-drain" && process.env["CQ_E2E_HOOKS"] === "1") {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        try {
          await workflow.whenDrained();
          return new Response(JSON.stringify({ drained: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          logger.warn("e2e.workflow_drain_failed", { err: String(err) });
          return new Response("drain failed", { status: 500 });
        }
      }

      // ── E2E test hook ────────────────────────────────────────────────── //
      // POST /__e2e/answer: answer one open question (with `questionId`), or —
      // with no questionId — every open question belonging to the LATEST goal
      // (highest G-id), sequentially, via the WorkflowRuntime so the
      // clarify/plan/review loop auto-advances. Scoping to the latest goal keeps
      // shared-cwd e2e runs from cross-answering an earlier test's goal. This is
      // the cycle-3 stand-in for the Goals-tab `question.answer` frame (cycle 4).
      // Body: { questionId?: string, answer?: string }.
      if (pathname === "/__e2e/answer" && process.env["CQ_E2E_HOOKS"] === "1") {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        try {
          const body = (await req.json().catch(() => ({}))) as { questionId?: string; answer?: string };
          const answer = body.answer ?? "yes (e2e)";
          let ids: string[];
          if (body.questionId !== undefined) {
            ids = [body.questionId];
          } else {
            // Latest goal = highest numeric G-id; its open questions only.
            const goals = ledgerStore.fetch("goals").milestones.flatMap((g) => g.items);
            const latest = goals.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).at(-1);
            const milestoneIds =
              latest !== undefined && Array.isArray(latest.fields["milestones"])
                ? (latest.fields["milestones"] as string[])
                : [];
            ids = ledgerStore
              .fetch("questions")
              .milestones.filter((g) => milestoneIds.includes(g.id))
              .flatMap((g) => g.items)
              .filter((i) => i.status === "open")
              .map((i) => i.id);
          }
          for (const id of ids) {
            await workflow.submitAnswer(id, answer);
          }
          return new Response(JSON.stringify({ answered: ids }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          logger.warn("e2e.answer_failed", { err: String(err) });
          return new Response("answer failed", { status: 500 });
        }
      }

      // ── E2E test hook ────────────────────────────────────────────────── //
      // POST /__e2e/settings: synchronously sets ui_settings.{model,
      // permissionMode, hideSdkEvents}. Mirrors the `settings.set` WS frame
      // but lets test setup pre-stage server-side defaults BEFORE opening
      // the cq page, so the very first auto-start chat.start carries the
      // intended routing (e.g. Codex specs that need model=gpt-5.5 server-
      // side so the auto-start picks it up via settings.get_result before
      // the deferred chat.start fires). Body shape:
      //   { model?: string|null, permissionMode?: string|null,
      //     hideSdkEvents?: boolean }
      if (pathname === "/__e2e/settings" && process.env["CQ_E2E_HOOKS"] === "1") {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        try {
          const body = (await req.json()) as {
            model?: string | null;
            permissionMode?: string | null;
            hideSdkEvents?: boolean;
          };
          const patch: Partial<{ model: string | null; permissionMode: string | null; hideSdkEvents: boolean }> = {};
          if (body.model !== undefined) patch.model = body.model;
          if (body.permissionMode !== undefined) patch.permissionMode = body.permissionMode;
          if (body.hideSdkEvents !== undefined) patch.hideSdkEvents = body.hideSdkEvents;
          persistence.settings.set(patch);
          return new Response("ok", { status: 200 });
        } catch (err) {
          logger.warn("e2e.settings_failed", { err: String(err) });
          return new Response("settings failed", { status: 500 });
        }
      }

      // WebSocket upgrade — only on /ws
      if (pathname === "/ws") {
        // Refuse new upgrades when draining.
        if (draining) {
          return new Response("Service Unavailable", { status: 503 });
        }

        if (!isOriginAllowed(req)) {
          logger.info("ws.origin_rejected", {
            origin: req.headers.get("Origin") ?? "(none)",
            host,
            port,
          });
          return new Response(null, { status: 403 });
        }

        const sessionId = crypto.randomUUID();
        const session = new WsSession(sessionId, logger, registry, bridge, persistence, workflow, activityTracker);
        const upgraded = srv.upgrade(req, { data: { sessionId, session } });
        if (!upgraded) {
          // Bun returns false when the upgrade fails for non-WS requests
          return new Response("Upgrade required", { status: 426 });
        }
        // upgrade() succeeded — must return undefined so Bun takes over.
        return undefined;
      }

      // Static asset cache policy: cq rebuilds the web bundle on every
      // server start (buildWeb → fixed filename main.js / main.css), but
      // without Cache-Control browsers happily serve the old bundle from
      // memory/disk cache and the user never sees fresh UI code. For a
      // local dev tool the safe default is no-store on every static asset.
      const noStore = { "Cache-Control": "no-store, no-cache, must-revalidate" };

      // Serve index.html for root or unknown paths
      if (pathname === "/" || pathname === "") {
        const indexPath = path.join(webOutdir, "index.html");
        try {
          const content = await fs.readFile(indexPath, "utf8");
          return new Response(content, {
            headers: { "Content-Type": "text/html; charset=utf-8", ...noStore },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      }

      // Serve static files from webOutdir
      const filePath = path.join(webOutdir, pathname.replace(/^\//, ""));
      try {
        const file = Bun.file(filePath);
        const exists = await file.exists();
        if (!exists) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(file, { headers: noStore });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },

    websocket: {
      open(ws) {
        if ("kind" in ws.data && ws.data.kind === "internal") {
          internalWs.open(ws as never);
          return;
        }
        openSockets.add(ws);
        (ws.data as WsSessionData).session.open(ws as never);
      },
      message(ws, raw) {
        if ("kind" in ws.data && ws.data.kind === "internal") {
          internalWs.message(ws as never, raw);
          return;
        }
        (ws.data as WsSessionData).session.message(ws as never, raw);
      },
      close(ws, code, reason) {
        if ("kind" in ws.data && ws.data.kind === "internal") {
          internalWs.close(ws as never);
          return;
        }
        openSockets.delete(ws);
        (ws.data as WsSessionData).session.close(ws as never, code, reason);
      },
    },
  });

  // Bind URL reflects the bound port; `Bun.serve` may pick an
  // ephemeral one when port=0.
  const boundPort = server.port;
  const internalWsUrl = `ws://127.0.0.1:${boundPort}${INTERNAL_WS_PATH}`;
  bridge.setInternalWsUrl(internalWsUrl);
  // The Codex workflow lane reads this lazily per dispatch (see selectors).
  internalWsUrlHolder = internalWsUrl;
  logger.info("cq listening", { host, port: boundPort, cwd, dbPath, internalWsUrl });

  return {
    bridge,
    workflow,
    persistence,
    internalWsUrl,
    internalWsToken: internalWs.tokenForChild(),

    markDraining() {
      draining = true;
    },

    closeAllSockets(code: number, reason: string) {
      for (const ws of openSockets) {
        try {
          ws.close(code, reason);
        } catch {
          // Already closed — ignore.
        }
      }
      openSockets.clear();
    },

    stop() {
      server.stop();
      persistence.close();
    },
  };
}
