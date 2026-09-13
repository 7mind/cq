import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LiveManager, type LiveState } from "@cq/ledger-live";
import { attachMcpHttp, changedFrame, LEDGER_TOPIC } from "@cq/ledger-mcp";
import {
  SqliteLedgerStore,
  startXdgCoherenceWatcher,
  assertSqliteAccessContract,
  createInMemoryImplementationEvidenceStore,
  protectLedgerStoreWithImplementationEvidence,
  type SqliteAccessRecord,
  type SqliteOperationRecord,
} from "@cq/ledger";
import { openLedgerDb } from "../../ledger/src/store/sqlite/connection.js";
import { FaultableWorkerProjection } from "../../ledger/test/searchProjectionFaultFixture.js";
import type { SearchProjectionHealth } from "../../ledger/src/search/SearchProjection.js";

const STALE_MS = 4_000;
const CONTROL_DEADLINE_MS = 30_000;
const PING_INTERVAL_MS = 50;
const REPLACEMENTS = 1_001;
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

interface ProbeReport {
  elapsedMs: number;
  scheduled: number;
  sent: number;
  received: number;
  missing: number;
  duplicates: number;
  lateness: number[];
  cadence: number[];
  rtt: number[];
  states: LiveState[];
  maxReconciliations: number;
  reconciliations: number;
  latest: string;
}

interface ServerReport {
  operations: SqliteOperationRecord[];
  accessKeys: string[];
  rows: number;
  deltas: number;
  snapshots: number;
  bucketRefreshes: number;
  notifications: string[];
  health: SearchProjectionHealth;
}

type Packet =
  | { kind: "server-ready"; port: number }
  | { kind: "probe-ready" }
  | { kind: "peer-complete" }
  | { kind: "disconnected" }
  | { kind: "probe-report"; report: ProbeReport };

function now(): number {
  return Bun.nanoseconds() / 1e6;
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = now() + CONTROL_DEADLINE_MS;
  while (!predicate()) {
    if (now() >= deadline) throw new Error("Timed out: " + label);
    await Bun.sleep(5);
  }
}

function send(packet: Packet): void {
  if (process.send === undefined) throw new Error("Gate child requires IPC");
  process.send(packet);
}

function childFailure(error: unknown): never {
  process.stderr.write(String(error) + "\n");
  process.exit(1);
}

class GateChild {
  private readonly queue: unknown[] = [];
  private readonly child: Bun.Subprocess;

  constructor(role: string, argument: string) {
    this.child = Bun.spawn({
      cmd: [process.execPath, import.meta.path, role, argument],
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      ipc: (message: unknown) => {
        this.queue.push(message);
      },
    });
  }

  command(command: string): void {
    this.child.send(command);
  }

  async receive<Kind extends Packet["kind"]>(kind: Kind): Promise<Extract<Packet, { kind: Kind }>> {
    await until(() => this.queue.length > 0 || this.child.exitCode !== null, "child " + kind);
    const message = this.queue.shift();
    assert(message !== null && typeof message === "object" && "kind" in message);
    assert.equal(message.kind, kind);
    return message as Extract<Packet, { kind: Kind }>;
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null) this.child.send("close");
    try {
      await until(() => this.child.exitCode !== null, "child shutdown");
      assert.equal(await this.child.exited, 0);
    } finally {
      if (this.child.exitCode === null) {
        this.child.kill();
        await this.child.exited;
      }
    }
  }
}

function checkCleanup(results: PromiseSettledResult<void>[]): void {
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Gate child cleanup failed",
    );
}

async function mcpClient(port: number): Promise<Client> {
  const client = new Client({ name: "sqlite-responsiveness-gate", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp"));
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  assert(Array.isArray(result.content));
  const first = result.content[0];
  assert(first !== undefined && first.type === "text" && typeof first.text === "string");
  assert.notEqual(result.isError, true, first.text);
  return JSON.parse(first.text) as unknown;
}

async function seed(dbPath: string, size: number): Promise<void> {
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  try {
    await store.createMilestone({ id: "M1", title: "background" });
    const db = openLedgerDb(dbPath);
    try {
      db.transaction(() => {
        db.query(
          "INSERT INTO groups (ledger, id, title, description) VALUES ('tasks', 'M1', 'background', '')",
        ).run();
        db.query(
          "INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at) VALUES ('tasks', 'M90', 'background', 'background', 'done', ?)",
        ).run(FIXED_TIME);
        const active = db.query(
          "INSERT INTO items (ledger,id,milestone_id,status,fields_json,created_at,updated_at) VALUES ('tasks',?,'M1','planned',?,?,?)",
        );
        const archived = db.query(
          "INSERT INTO archived_items (ledger,pointer_id,id,milestone_id,status,fields_json,created_at,updated_at) VALUES ('tasks','M90',?,'M90','done',?,?,?)",
        );
        for (let index = 1; index <= size; index += 1) {
          active.run(
            "T" + index,
            JSON.stringify({ headline: "background " + index }),
            FIXED_TIME,
            FIXED_TIME,
          );
          archived.run(
            "T" + (50_000 + index),
            JSON.stringify({ headline: "archived " + index }),
            FIXED_TIME,
            FIXED_TIME,
          );
        }
        db.query("UPDATE ledgers SET item_counter = ? WHERE name = 'tasks'").run(50_000 + size);
      })();
    } finally {
      db.close();
    }
  } finally {
    await store.dispose();
  }
}

async function serve(dbPath: string): Promise<void> {
  const operations: SqliteOperationRecord[] = [];
  const accesses: SqliteAccessRecord[] = [];
  const notifications: string[] = [];
  const worker = new FaultableWorkerProjection();
  const raw = new SqliteLedgerStore({
    dbPath,
    searchProjectionFactory: () => worker.projection,
    monotonicNow: now,
    operationObserver: { record: (record) => operations.push(record) },
    accessObserver: {
      record: (record) => {
        assertSqliteAccessContract(record);
        accesses.push(record);
      },
    },
  });
  await raw.init();
  worker.commands.length = 0;
  const store = protectLedgerStoreWithImplementationEvidence(
    raw,
    createInMemoryImplementationEvidenceStore(),
  );
  const handlers = attachMcpHttp(store, "responsiveness");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request, host) {
      const route = new URL(request.url).pathname;
      if (route === "/ws")
        return host.upgrade(request, { data: undefined })
          ? undefined
          : new Response(null, { status: 426 });
      if (route === "/mcp") return handlers.handle(request);
      if (route === "/gate/crash" || route === "/gate/timeout") {
        worker.fault = route === "/gate/crash" ? "crash" : "timeout";
        return new Response("armed");
      }
      if (route === "/gate/health") return Response.json(raw.searchProjectionHealth());
      if (route === "/gate/report") {
        const report: ServerReport = {
          operations: [...operations],
          accessKeys: accesses
            .flatMap((record) =>
              record.keyedPredicate.keys.map(
                (key) =>
                  record.operation +
                  ":" +
                  record.table +
                  ":" +
                  record.mode +
                  ":" +
                  record.keyedPredicate.kind +
                  ":" +
                  key,
              ),
            )
            .sort(),
          rows: accesses.reduce((sum, record) => sum + record.count, 0),
          deltas: worker.commands.reduce(
            (sum, command) => sum + (command.kind === "delta" ? command.changes.length : 0),
            0,
          ),
          snapshots: worker.commands.filter((command) => command.kind === "snapshot").length,
          bucketRefreshes: worker.commands.reduce(
            (sum, command) =>
              sum +
              (command.kind === "delta"
                ? command.changes.filter((change) => change.kind === "replace-bucket").length
                : 0),
            0,
          ),
          notifications: [...notifications],
          health: raw.searchProjectionHealth(),
        };
        operations.length = 0;
        accesses.length = 0;
        notifications.length = 0;
        worker.commands.length = 0;
        return Response.json(report);
      }
      return new Response(null, { status: 404 });
    },
    websocket: { open: handlers.onWsOpen, message: handlers.onWsMessage },
  });
  const watcher = startXdgCoherenceWatcher(raw, dbPath, 20, (ledger) => {
    assert(ledger !== null);
    assert.equal(worker.projection.health().state, "current");
    assert.equal(worker.projection.health().pendingCommands, 0);
    notifications.push(ledger);
    server.publish(LEDGER_TOPIC, changedFrame(ledger));
  });
  process.on("message", (message: unknown) => {
    void (async () => {
      assert.equal(message, "close");
      watcher.close();
      await server.stop(true);
      await raw.dispose();
      process.exit(0);
    })().catch(childFailure);
  });
  assert(server.port !== undefined);
  send({ kind: "server-ready", port: server.port });
}

async function probe(port: number): Promise<void> {
  const client = await mcpClient(port);
  const report: ProbeReport = {
    elapsedMs: 0,
    scheduled: 0,
    sent: 0,
    received: 0,
    missing: 0,
    duplicates: 0,
    lateness: [],
    cadence: [],
    rtt: [],
    states: [],
    maxReconciliations: 0,
    reconciliations: 0,
    latest: "",
  };
  let liveSocket: WebSocket | null = null;
  let concurrent = 0;
  const rememberSocket = (socket: WebSocket): void => {
    liveSocket = socket;
  };
  class ObservedSocket extends WebSocket {
    constructor(url: string) {
      super(url);
      rememberSocket(this);
    }
  }
  const live = new LiveManager({
    url: "ws://127.0.0.1:" + port + "/ws",
    WebSocketCtor: ObservedSocket,
    now,
    pingIntervalMs: PING_INTERVAL_MS,
    pongTimeoutMs: STALE_MS,
    baseBackoffMs: 10,
    maxBackoffMs: 50,
    onUpdate: (stats) => report.states.push(stats.state),
    onChanged: async () => {
      concurrent += 1;
      report.maxReconciliations = Math.max(report.maxReconciliations, concurrent);
      report.reconciliations += 1;
      try {
        const result = (await call(client, "fetch_item", {
          ledger_id: "tasks",
          item_id: "T3",
          projection: "compact",
        })) as { item: { fields: { headline: string } } };
        report.latest = result.item.fields.headline;
      } finally {
        concurrent -= 1;
      }
    },
  });
  live.start();
  const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws");
  const pending = new Map<string, number>();
  const acknowledged = new Set<string>();
  const runNonce = crypto.randomUUID();
  let start = 0;
  let previous: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as { type: string; nonce: string };
    if (frame.type !== "pong") return;
    const sentAt = pending.get(frame.nonce);
    if (sentAt === undefined || acknowledged.has(frame.nonce)) {
      report.duplicates += 1;
      return;
    }
    report.rtt.push(now() - sentAt);
    pending.delete(frame.nonce);
    acknowledged.add(frame.nonce);
    report.received += 1;
  };
  const ping = (): void => {
    if (stopped) return;
    const scheduled = start + report.sent * PING_INTERVAL_MS;
    const sentAt = now();
    if (sentAt < scheduled) {
      timer = setTimeout(ping, scheduled - sentAt);
      return;
    }
    report.lateness.push(sentAt - scheduled);
    if (previous !== null) report.cadence.push(sentAt - previous);
    previous = sentAt;
    const nonce = runNonce + ":" + report.sent;
    pending.set(nonce, sentAt);
    socket.send(JSON.stringify({ type: "ping", nonce, ts: sentAt }));
    report.sent += 1;
    timer = setTimeout(ping, Math.max(0, start + report.sent * PING_INTERVAL_MS - now()));
  };
  await until(
    () => socket.readyState === WebSocket.OPEN && live.getStats().state === "alive",
    "probe connection and reconciliation",
  );
  start = now();
  ping();
  send({ kind: "probe-ready" });
  process.on("message", (message: unknown) => {
    void (async () => {
      if (message === "disconnect") {
        assert(liveSocket !== null);
        liveSocket.close();
        send({ kind: "disconnected" });
      } else if (message === "report") {
        await until(
          () => live.getStats().state === "alive" && report.latest === "disconnect sentinel",
          "missed-state reconciliation",
        );
        await until(() => {
          const elapsed = now() - start;
          if (Math.floor(elapsed / PING_INTERVAL_MS) + 1 !== report.sent) return false;
          report.elapsedMs = elapsed;
          report.scheduled = Math.floor(elapsed / PING_INTERVAL_MS) + 1;
          return true;
        }, "all due ping slots sent");
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        await until(() => pending.size === 0, "all scheduled pongs");
        report.missing = report.sent - report.received;
        send({ kind: "probe-report", report });
      } else {
        assert.equal(message, "close");
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        live.destroy();
        socket.close();
        await client.close();
        process.exit(0);
      }
    })().catch(childFailure);
  });
}

function percentiles(samples: readonly number[]): {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  assert(samples.length > 0, "Percentiles require nonempty samples");
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = (fraction: number): number =>
    Number(sorted[Math.ceil(sorted.length * fraction) - 1]!.toFixed(3));
  return { count: sorted.length, p50: rank(0.5), p95: rank(0.95), p99: rank(0.99), max: rank(1) };
}

async function control(port: number, route: string): Promise<Response> {
  const response = await fetch("http://127.0.0.1:" + port + "/gate/" + route, {
    signal: AbortSignal.timeout(CONTROL_DEADLINE_MS),
  });
  assert(response.ok, "Gate control " + route + " failed");
  return response;
}

async function reportPhase(port: number, size: number, phase: string): Promise<ServerReport> {
  const report = (await (await control(port, "report")).json()) as ServerReport;
  const durations = [
    "queueDelayMs",
    "lockWaitMs",
    "transactionMs",
    "projectionMs",
    "notificationMs",
    "telemetryMs",
    "totalMs",
  ] as const;
  const mutations = report.operations.filter(
    (record) => record.endpoint !== "fetch_item" && record.endpoint !== "fts_search",
  );
  assert(report.operations.every((record) => record.outcome === "success"));
  console.log(
    JSON.stringify({
      fixture: { activeBackground: size, archivedBackground: size },
      phase,
      operations: Object.fromEntries(
        [...new Set(report.operations.map((record) => record.endpoint))].map((endpoint) => [
          endpoint,
          report.operations.filter((record) => record.endpoint === endpoint).length,
        ]),
      ),
      mutations: mutations.length,
      rows: report.rows,
      deltas: report.deltas,
      snapshots: report.snapshots,
      bucketRefreshes: report.bucketRefreshes,
      notifications: report.notifications.length,
      projectionHealth: report.health,
      mutationDurations: Object.fromEntries(
        durations.map((field) => [
          field,
          mutations.length === 0 ? null : percentiles(mutations.map((record) => record[field])),
        ]),
      ),
    }),
  );
  return report;
}

async function runFixture(
  size: number,
): Promise<{ ordinary: ServerReport; terminal: ServerReport; archive: ServerReport }> {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-responsiveness-"));
  const dbPath = path.join(root, "ledger.db");
  const children: GateChild[] = [];
  let client: Client | null = null;
  try {
    await seed(dbPath, size);
    const server = new GateChild("server", dbPath);
    children.push(server);
    const { port } = await server.receive("server-ready");
    const connectedClient = await mcpClient(port);
    client = connectedClient;
    const transportProbe = new GateChild("probe", String(port));
    children.push(transportProbe);
    await transportProbe.receive("probe-ready");
    const update = (id: string, headline: string) =>
      call(connectedClient, "update_item", {
        ledger_id: "tasks",
        item_id: id,
        fields: { headline },
      });
    const search = async (query: string, expected: string): Promise<void> => {
      const result = (await call(connectedClient, "fts_search", {
        query,
        projection: "compact",
        ledger: "tasks",
      })) as { results: Array<{ item: { id: string } }> };
      assert.deepEqual(
        result.results.map((hit) => hit.item.id),
        [expected],
      );
    };
    await update("T1", "warmup");
    await control(port, "report");

    await call(client, "create_item", {
      ledger_id: "tasks",
      milestone_id: "M1",
      id: "T900001",
      status: "planned",
      fields: { headline: "ordinary create" },
    });
    await update("T900001", "ordinary update");
    await call(client, "update_item", { ledger_id: "tasks", item_id: "T900001", status: "done" });
    await call(client, "reopen_item", {
      ledger_id: "tasks",
      item_id: "T900001",
      to_status: "planned",
    });
    await search("ordinary", "T900001");
    const ordinary = await reportPhase(port, size, "ordinary");
    assert(ordinary.operations.length > 0);
    assert.equal(ordinary.bucketRefreshes, 0);
    assert.equal(ordinary.snapshots, 0);

    for (let index = 0; index < REPLACEMENTS; index += 1)
      await update("T1", "replacement " + index);
    await search("replacement", "T1");
    const reclaim = await reportPhase(port, size, "reclaim");
    assert.equal(reclaim.deltas, REPLACEMENTS);
    assert.equal(reclaim.snapshots, 0);
    assert.equal(reclaim.bucketRefreshes, 0);

    await call(client, "create_item", {
      ledger_id: "milestones",
      id: "M900",
      status: "open",
      fields: { title: "archive qualification" },
    });
    await call(client, "create_item", {
      ledger_id: "tasks",
      milestone_id: "M900",
      id: "T900002",
      status: "done",
      fields: { headline: "terminal sweep" },
    });
    await control(port, "report");
    await call(client, "archive_terminal_items", {
      ledger_ids: ["tasks"],
      summary: "qualified",
      gate_policy: "fail-on-active-gate",
    });
    const terminal = await reportPhase(port, size, "archive-terminal-items");
    assert.equal(terminal.deltas, 2);
    assert.equal(terminal.bucketRefreshes, 0);
    await call(client, "update_item", { ledger_id: "milestones", item_id: "M900", status: "done" });
    await control(port, "report");
    await call(client, "archive_milestone", { milestone_id: "M900", summary: "qualified" });
    const archive = await reportPhase(port, size, "archive-milestone");
    assert(archive.deltas >= 2);
    assert.equal(archive.bucketRefreshes, 0);

    const peer = new GateChild("peer", dbPath);
    children.push(peer);
    await peer.receive("peer-complete");
    await search("peervisible", "T2");
    const peerReport = await reportPhase(port, size, "peer");
    assert.equal(peerReport.deltas, 1);
    assert.deepEqual(peerReport.notifications, ["tasks"]);
    assert.equal(peerReport.bucketRefreshes, 0);

    await control(port, "crash");
    await update("T1", "recoveryvisible");
    await search("recoveryvisible", "T1");
    const recovery = await reportPhase(port, size, "worker-recovery");
    assert.equal(recovery.snapshots, 1);
    assert.equal(recovery.health.generation, 2);

    await control(port, "timeout");
    let mutationSettled = false;
    const mutation = update("T3", "disconnect sentinel").finally(() => {
      mutationSettled = true;
    });
    const pendingDeadline = now() + CONTROL_DEADLINE_MS;
    while (true) {
      const health = (await (await control(port, "health")).json()) as SearchProjectionHealth;
      if (health.pendingCommands > 0) break;
      assert(now() < pendingDeadline, "Mutation never reached its pending projection");
      await Bun.sleep(5);
    }
    transportProbe.command("disconnect");
    await transportProbe.receive("disconnected");
    assert.equal(mutationSettled, false, "Disconnect must overlap the pending mutation");
    await mutation;
    await search("disconnect", "T3");
    await reportPhase(port, size, "disconnect-reconciliation");
    transportProbe.command("report");
    const heartbeat = (await transportProbe.receive("probe-report")).report;
    assert(heartbeat.sent > 1);
    assert.equal(heartbeat.sent, heartbeat.scheduled);
    assert.equal(heartbeat.sent, heartbeat.received);
    assert.equal(heartbeat.missing, 0);
    assert.equal(heartbeat.duplicates, 0);
    for (const samples of [heartbeat.lateness, heartbeat.cadence, heartbeat.rtt]) {
      assert(samples.length > 0);
      assert(
        samples.every((sample) => sample >= 0 && sample < STALE_MS),
        "Heartbeat exceeded stale threshold",
      );
    }
    assert.equal(heartbeat.states.filter((state) => state === "stale").length, 0);
    assert.equal(heartbeat.maxReconciliations, 1);
    assert(heartbeat.reconciliations > 1);
    assert.equal(heartbeat.latest, "disconnect sentinel");
    console.log(
      JSON.stringify({
        phase: "heartbeat",
        fixture: size,
        thresholdMs: STALE_MS,
        intervalMs: PING_INTERVAL_MS,
        elapsedMs: Number(heartbeat.elapsedMs.toFixed(3)),
        scheduled: heartbeat.scheduled,
        sent: heartbeat.sent,
        received: heartbeat.received,
        missing: heartbeat.missing,
        duplicates: heartbeat.duplicates,
        scheduledSendLateness: percentiles(heartbeat.lateness),
        interSendCadence: percentiles(heartbeat.cadence),
        pongRtt: percentiles(heartbeat.rtt),
        states: Object.fromEntries(
          [...new Set(heartbeat.states)].map((state) => [
            state,
            heartbeat.states.filter((sample) => sample === state).length,
          ]),
        ),
        finalState: heartbeat.states.at(-1),
        maxConcurrentReconciliations: heartbeat.maxReconciliations,
        reconciliations: heartbeat.reconciliations,
        missedStateRecovered: heartbeat.latest,
      }),
    );
    return { ordinary, terminal, archive };
  } finally {
    if (client !== null) await client.close();
    const cleanup = await Promise.allSettled(children.reverse().map((child) => child.close()));
    rmSync(root, { recursive: true, force: true });
    checkCleanup(cleanup);
  }
}

async function peer(dbPath: string): Promise<void> {
  const store = new SqliteLedgerStore({ dbPath });
  await store.init();
  await store.updateItem("tasks", "T2", { fields: { headline: "peervisible" } });
  await store.dispose();
  process.on("message", (message: unknown) => {
    assert.equal(message, "close");
    process.exit(0);
  });
  send({ kind: "peer-complete" });
}

async function main(): Promise<void> {
  const role = process.argv[2];
  const argument = process.argv[3];
  if (role !== undefined) {
    assert(argument !== undefined);
    if (role === "server") await serve(argument);
    else if (role === "peer") await peer(argument);
    else if (role === "probe") {
      const port = Number(argument);
      assert(Number.isInteger(port) && port > 0);
      await probe(port);
    } else throw new Error("Unknown gate role: " + role);
    return;
  }
  const cpu = cpus()[0];
  assert(cpu !== undefined, "Machine CPU information required");
  console.log(
    JSON.stringify({
      gate: "sqlite-responsiveness",
      classification: "Performance-Effectual Good-Communication",
      runtime: Bun.version,
      machine: { platform: platform(), arch: arch(), cpu: cpu.model },
      warmup: 1,
      replacements: REPLACEMENTS,
    }),
  );
  const small = await runFixture(10);
  const large = await runFixture(10_000);
  for (const phase of ["ordinary", "terminal", "archive"] as const) {
    assert.deepEqual(
      large[phase].accessKeys,
      small[phase].accessKeys,
      phase + " keyed access must be background-size invariant",
    );
    assert.equal(large[phase].rows, small[phase].rows);
  }
  console.log(
    JSON.stringify({
      gate: "sqlite-responsiveness",
      result: "pass",
      fixtures: 2,
      ordinaryAccessKeys: large.ordinary.accessKeys.length,
      ordinaryRows: large.ordinary.rows,
    }),
  );
}

if (import.meta.main) await main();
