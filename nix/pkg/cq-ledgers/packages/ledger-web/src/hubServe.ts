#!/usr/bin/env -S bun run
/**
 * hubServe.ts — the `cq serve` HUB server (T586, G81 pure-CLI serve mode).
 *
 * `cq serve` boots ONE long-running process meant to host EVERY project
 * registered in a shared multi-tenant Postgres database (T572/T577), with NO
 * dependency on a ledger-root cwd or a `cq.toml` — unlike every other MODE
 * (`mcp`/`tui`/`web`), which resolve a ledger root via `--cwd > $LEDGER_ROOT >
 * process CWD` and read `cq.toml`. Config here is PURE CLI (+ env fallback):
 *
 *   cq serve --pg-url postgres://... [--host <h>] [--port <p>] [--token <t>]
 *
 * T586 landed the SKELETON: argv parsing, DSN resolution + fail-fast, schema
 * bootstrap under the advisory lock, a whole-registry projects listing, and
 * static web-bundle serving on ONE bound port. T587 adds PER-PROJECT ROUTING
 * (Q283 lock: URL-path addressing, zero tool-schema churn): `/p/<projectKey>/mcp`
 * mounts a per-tenant {@link attachMcpHttp} over a LAZILY-constructed
 * `PostgresLedgerStore` (one per tenant, all sharing the hub pool), and
 * `/p/<projectKey>/ws` upgrades to a socket on a per-tenant pub/sub topic, fed
 * by ONE hub-level LISTEN connection that dispatches every NOTIFY by payload
 * `project_key`. Unknown `projectKey` → 404.
 *
 * T588 (Q273 lock) enforces `--token`: a non-loopback `--host` (anything
 * outside 127.0.0.0/8 / `::1` / `localhost`) is REFUSED at startup unless
 * `--token <secret>` is also given ({@link assertTokenIfNonLoopback}) — a
 * clear, actionable error naming the flag, checked BEFORE DSN resolution so
 * a misconfigured bind never even touches Postgres. When a token IS set,
 * every data route requires it: `/api/projects` and `/p/<key>/mcp` read an
 * `Authorization: Bearer <token>` header; `/p/<key>/ws` reads a `?token=`
 * query param (browsers cannot set headers on a WebSocket handshake, so the
 * query-param form is the one the web client sends — see main.tsx). A
 * mismatch or missing credential answers 401 with NO token echoed back in
 * the body. The static bundle (`GET /` + assets, `serveStatic`) stays
 * unauthenticated either way — the UI itself surfaces the token as a
 * `?token=` page param it forwards to `/ws` and as the `/mcp` Authorization
 * header (T588). Comparison is constant-time ({@link tokensMatch}): both
 * sides are SHA-256-hashed to a fixed 32-byte digest before
 * `crypto.timingSafeEqual`, so neither raw-length nor byte-position timing
 * leaks the secret. A loopback bind with no `--token` keeps T586/T587's open
 * behavior unchanged.
 *
 * Reuses ledger-web's existing bundle-serving internals (`buildBundle`,
 * `prepare`, `serveStatic`, `scanForPort`, `DEFAULT_OUTDIR`) from serve.ts —
 * the SAME browser bundle `cq web` serves, since the hub's `GET /` is the
 * identical React app.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import {
  openPgPool,
  ensureSchema,
  PostgresLedgerStore,
  startPostgresHubCoherenceWatcher,
  type ProjectEntry,
  type PostgresCoherenceWatcher,
} from "@cq/ledger";
import {
  attachMcpHttp,
  changedFrame,
  wsHeartbeat,
  type McpHttpHandlers,
} from "@cq/ledger-mcp";
import { prepare, serveStatic, scanForPort, DEFAULT_OUTDIR } from "./serve.js";

/** Default bind host for `cq serve` (mirrors ledger-web's DEFAULT_HOST). */
export const HUB_DEFAULT_HOST = "127.0.0.1";

/**
 * Default bind port for `cq serve` — DELIBERATELY DISTINCT from `cq web`'s
 * default (5180, serve.ts `DEFAULT_PORT`) so both modes can run side by side
 * on one host with no flag needed to avoid a clash.
 */
export const HUB_DEFAULT_PORT = 5190;

/** Parsed `cq serve` argv, pre-DSN-resolution. */
export interface HubServeArgs {
  host: string;
  port: number;
  /** `--pg-url <dsn>`; `undefined` when omitted (env fallback applies — see {@link resolveHubDsn}). */
  pgUrlArg: string | undefined;
  /**
   * `--token <secret>`, threaded through to {@link HubServeOpts} and enforced
   * (T588 / Q273) on every data route once set: see {@link assertTokenIfNonLoopback}
   * for the startup gate and {@link checkBearerAuth}/{@link checkWsAuth} for the
   * per-request gate. `null` when the flag is absent.
   */
  token: string | null;
}

/**
 * Parse `cq serve`'s argv. Unlike `cq web`'s `parseArgs` (serve.ts), there is
 * NO `--cwd` here — the pure-CLI goal means no ledger-root resolution at all.
 * `--port 0` is explicitly allowed (OS-assigned ephemeral port, e.g. for
 * tests), unlike `cq web`'s validator which rejects it.
 */
export function parseHubArgs(argv: readonly string[]): HubServeArgs {
  let host = HUB_DEFAULT_HOST;
  let port = HUB_DEFAULT_PORT;
  let pgUrlArg: string | undefined;
  let token: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") host = argv[++i] ?? host;
    else if (a?.startsWith("--host=")) host = a.slice("--host=".length);
    else if (a === "--port") port = Number(argv[++i]);
    else if (a?.startsWith("--port=")) port = Number(a.slice("--port=".length));
    else if (a === "--pg-url") pgUrlArg = argv[++i];
    else if (a?.startsWith("--pg-url=")) pgUrlArg = a.slice("--pg-url=".length);
    else if (a === "--token") token = argv[++i] ?? token;
    else if (a?.startsWith("--token=")) token = a.slice("--token=".length);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`cq serve: --port must be 0..65535; got: ${String(port)}`);
  }
  return { host, port, pgUrlArg, token };
}

/** Env vars consulted for the DSN when `--pg-url` is absent, in precedence order. */
const HUB_DSN_ENV_VARS = ["CQ_LEDGER_PG_URL", "DATABASE_URL"] as const;

/**
 * Thrown when NONE of `--pg-url`, `CQ_LEDGER_PG_URL`, or `DATABASE_URL`
 * resolves a DSN — `cq serve`'s fail-fast, actionable startup error (mirrors
 * `PostgresDsnResolutionError`'s style, but pure-CLI: no `cq.toml [ledger].url`
 * fallback, since this mode reads no config file).
 */
export class HubDsnResolutionError extends Error {
  constructor() {
    super(
      "cq serve: no Postgres connection info was found. Pass --pg-url <dsn>, or set the " +
        "CQ_LEDGER_PG_URL environment variable (highest-precedence env fallback), or DATABASE_URL.",
    );
    this.name = "HubDsnResolutionError";
  }
}

/**
 * Resolve the hub's DSN: `--pg-url` (explicit CLI flag, highest precedence) >
 * `CQ_LEDGER_PG_URL` > `DATABASE_URL`. Reads NEITHER `cq.toml` NOR the process
 * cwd — `cq serve` boots from anywhere, with no ledger-root resolution
 * (unlike `resolvePostgresDsn`, which is cq.toml-config-shaped for the
 * per-repo `mcp`/`tui`/`web` modes).
 */
export function resolveHubDsn(
  pgUrlArg: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (pgUrlArg !== undefined && pgUrlArg.trim() !== "") return pgUrlArg;
  for (const varName of HUB_DSN_ENV_VARS) {
    const value = env[varName];
    if (value !== undefined && value.trim() !== "") return value;
  }
  throw new HubDsnResolutionError();
}

/**
 * True when `host` is a loopback bind (Q273): `localhost`, `::1`, or anything
 * in `127.0.0.0/8`. Anything else — `0.0.0.0`/`::` (all interfaces), a LAN IP,
 * or a hostname that isn't the literal `localhost` — is NON-loopback and
 * requires `--token` (see {@link assertTokenIfNonLoopback}).
 */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  return [m[1]!, m[2]!, m[3]!].every((octet) => Number(octet) <= 255);
}

/**
 * Thrown when `--host` is non-loopback and `--token` is absent — `cq serve`'s
 * other fail-fast startup error (Q273 lock), naming the flag so the fix is
 * obvious.
 */
export class HubTokenRequiredError extends Error {
  constructor(host: string) {
    super(
      `cq serve: --host ${host} is not loopback; a --token <secret> is REQUIRED when binding a ` +
        "non-loopback host (Q273) — pass --token, or bind a loopback host (127.0.0.1 / localhost / ::1) " +
        "to keep the open loopback behavior.",
    );
    this.name = "HubTokenRequiredError";
  }
}

/**
 * Startup gate (Q273): refuse a non-loopback `--host` with no `--token`. Runs
 * BEFORE DSN resolution in {@link main} so a misconfigured bind never touches
 * Postgres. A loopback host is unaffected whether or not `--token` is given.
 */
export function assertTokenIfNonLoopback(host: string, token: string | null): void {
  if (token === null && !isLoopbackHost(host)) {
    throw new HubTokenRequiredError(host);
  }
}

/** `GET /api/projects` response body. */
export interface ProjectsResponse {
  projects: ProjectEntry[];
}

/**
 * Enumerate the `projects` registry directly via the pool — a raw SELECT
 * mirroring `PostgresLedgerStore.listProjects()` (T585), which this skeleton
 * deliberately does NOT instantiate: that store is constructed per-project
 * (it needs a `projectKey`), and no per-project store construction lands
 * until T587 wires per-project routing. For a WHOLE-REGISTRY listing with no
 * single tenant in scope, this raw query is the honest minimal read.
 */
export async function fetchRegisteredProjects(pool: ReturnType<typeof openPgPool>): Promise<ProjectEntry[]> {
  const rows = await pool<Array<{ project_key: string; display_name: string; created_at: string }>>`
    SELECT project_key, display_name, created_at::text AS created_at
    FROM projects
    ORDER BY display_name
  `;
  return rows.map((row) => ({
    key: row.project_key,
    displayName: row.display_name,
    createdAt: row.created_at,
  }));
}

/**
 * Look up ONE tenant's display name by `projectKey` — the per-request registry
 * validation for the per-project routes (T587). Returns the `display_name` when
 * the tenant is registered, else `null` (→ the route answers 404). A raw
 * single-row SELECT (like {@link fetchRegisteredProjects}), NOT a
 * `PostgresLedgerStore.listProjects()` scan, since routing only needs the one
 * row and the store is what we are deciding whether to construct.
 */
export async function fetchProjectDisplayName(
  pool: ReturnType<typeof openPgPool>,
  projectKey: string,
): Promise<string | null> {
  const rows = await pool<Array<{ display_name: string }>>`
    SELECT display_name FROM projects WHERE project_key = ${projectKey}
  `;
  const row = rows[0];
  return row !== undefined ? row.display_name : null;
}

/** URL prefix under which every per-project endpoint is mounted: `/p/<key>/…`. */
export const PROJECT_ROUTE_PREFIX = "/p/";

/**
 * Match a per-project route pathname `/p/<projectKey>/<leaf>` where `<leaf>` is
 * `mcp` or `ws`. Returns the decoded `projectKey` + `leaf`, or `null` when the
 * pathname is not a per-project route. `<projectKey>` is a single path segment
 * (no embedded `/`), URL-decoded so a key with reserved characters round-trips.
 */
export function matchProjectRoute(
  pathname: string,
): { projectKey: string; leaf: "mcp" | "ws" } | null {
  const m = /^\/p\/([^/]+)\/(mcp|ws)$/.exec(pathname);
  if (m === null) return null;
  return { projectKey: decodeURIComponent(m[1]!), leaf: m[2] as "mcp" | "ws" };
}

/**
 * The Bun pub/sub topic a project's live-change frames are published to — one
 * topic PER TENANT (`ledger:<projectKey>`), so a `/p/A/ws` socket subscribed to
 * A's topic never sees B's writes. Distinct from ledger-mcp's single-project
 * {@link import("@cq/ledger-mcp").LEDGER_TOPIC} (`"ledger"`).
 */
export function hubTopic(projectKey: string): string {
  return `ledger:${projectKey}`;
}

/** Bun.serve per-socket data for the hub's WebSocket: which tenant it belongs to. */
interface HubWsData {
  projectKey: string;
}

/**
 * A lazily-constructed per-tenant runtime: the tenant's own
 * {@link PostgresLedgerStore} (sharing the hub pool), the
 * {@link attachMcpHttp} handlers bound to it, and a coalesced `refresh` that
 * bulk-invalidates the store and publishes a change frame to the tenant's
 * topic. Cached for the hub's lifetime (one per tenant that is ever addressed).
 */
interface ProjectRuntime {
  store: PostgresLedgerStore;
  handlers: McpHttpHandlers;
  /** Coalesced full invalidate of this store + publish a change frame to its topic. */
  refresh: () => void;
}

/** Resolved options for {@link serveHub}, after DSN resolution + argv parsing. */
export interface HubServeOpts {
  host: string;
  port: number;
  /** Parsed from `--token`; `null` disables auth (only legal on a loopback bind — see the module doc). */
  token: string | null;
  outdir: string;
}

/** Parses the `Authorization: Bearer <token>` header, or `null` if absent/malformed. */
function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const m = /^Bearer\s+(.+)$/.exec(header);
  return m !== null ? m[1]! : null;
}

/**
 * Constant-time token comparison (Q273): both sides are SHA-256-hashed to a
 * fixed 32-byte digest FIRST, then compared with `crypto.timingSafeEqual` —
 * hashing first means unequal-length secrets never leak length via an early
 * `timingSafeEqual` length check, and the raw secret bytes are never compared
 * directly.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** 401 with a fixed body — NEVER echoes the provided/expected token back. */
function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

/**
 * Bearer-header auth gate for `/api/projects` and `/p/<key>/mcp` (Q273).
 * `token === null` means auth is off (loopback-only, per the startup gate) —
 * every request passes.
 */
function checkBearerAuth(req: Request, token: string | null): boolean {
  if (token === null) return true;
  const provided = extractBearerToken(req);
  return provided !== null && tokensMatch(provided, token);
}

/**
 * `?token=` query-param auth gate for `/p/<key>/ws` (Q273): browsers cannot
 * set custom headers on a WebSocket handshake, so the query param is the
 * mechanism the web client uses (see main.tsx's `liveWsUrl`). `token === null`
 * means auth is off; every upgrade passes.
 */
function checkWsAuth(url: URL, token: string | null): boolean {
  if (token === null) return true;
  const provided = url.searchParams.get("token");
  return provided !== null && tokensMatch(provided, token);
}

/**
 * Open the pool, ensure schema (idempotent DDL under the `pg_advisory_lock`,
 * T572/Q271), and read back the projects registry. Does not bind a port.
 */
export async function bootHub(
  dsn: string,
): Promise<{ pool: ReturnType<typeof openPgPool>; projects: ProjectEntry[] }> {
  const pool = openPgPool(dsn);
  await ensureSchema(pool);
  const projects = await fetchRegisteredProjects(pool);
  return { pool, projects };
}

/**
 * Bind ONE `Bun.serve` port hosting: the web bundle (`GET /` + assets, via
 * `serveStatic`); the whole-registry projects listing (`GET /api/projects`);
 * and — the T587 addition — per-tenant MCP + live-change routes under
 * `/p/<projectKey>/{mcp,ws}` (Q283 lock: URL-path addressing, zero tool-schema
 * churn).
 *
 * Per-project wiring (T587):
 *  - Each addressed tenant gets a LAZILY-constructed {@link PostgresLedgerStore}
 *    (one per project, all SHARING the hub's `pool`), cached on first request.
 *    An unknown `projectKey` (no `projects` row) → 404.
 *  - `/p/<k>/mcp` routes to that tenant's {@link attachMcpHttp} handlers —
 *    per-(session, project) session management exactly as `attachMcpHttp`
 *    provides per instance.
 *  - `/p/<k>/ws` upgrades to a socket subscribed to the tenant's OWN pub/sub
 *    topic ({@link hubTopic}), so cross-tenant frames never leak.
 *  - ONE hub-level LISTEN connection ({@link startPostgresHubCoherenceWatcher})
 *    dispatches every NOTIFY by payload `project_key`: invalidate that tenant's
 *    store (if constructed) and publish a change frame to its topic — reusing
 *    the coherence-watcher porsager internals rather than N per-store LISTEN
 *    connections. A tenant's own write, a peer hub, and an EXTERNAL store
 *    process all reach subscribed sockets by this one path.
 *
 * The per-project stores share `pool`, so their `dispose()` (which closes the
 * pool) is intentionally NOT called per tenant on shutdown — that would close
 * the shared pool out from under every other tenant. The single shared pool is
 * closed ONCE by the caller (`main`) after `server.stop()`; the returned
 * server's `stop` is wrapped to close ONLY the hub LISTEN connection. The
 * per-store in-memory caches are released with the process.
 *
 * `dsn` is threaded in (alongside the already-open `pool`) because the porsager
 * LISTEN connection needs its OWN connection from the DSN — `Bun.sql` (the pool)
 * implements no LISTEN/NOTIFY (RS1). `opts.token` enforcement remains T588.
 */
export function serveHub(
  opts: HubServeOpts,
  pool: ReturnType<typeof openPgPool>,
  dsn: string,
  indexPath: string,
): ReturnType<typeof Bun.serve> {
  // Lazily-constructed per-tenant runtimes, keyed by projectKey. Stored as a
  // PROMISE so two concurrent first-requests for the same tenant share ONE
  // construction (no double-construct racing the same pool). A failed or
  // unknown-project construction is evicted so a later request can retry.
  const runtimes = new Map<string, Promise<ProjectRuntime | null>>();

  /** Coalesced full-invalidate + publish for one store/topic (mirrors the single-store watcher). */
  function makeRefresh(store: PostgresLedgerStore, projectKey: string): () => void {
    let running = false;
    let pending = false;
    return () => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      void (async () => {
        try {
          do {
            pending = false;
            for (const ledgerId of store.enumerate()) {
              await store.invalidate(ledgerId);
            }
            server.publish(hubTopic(projectKey), changedFrame(null));
          } while (pending);
        } finally {
          running = false;
        }
      })();
    };
  }

  /**
   * Resolve (constructing + caching on first use) the runtime for `projectKey`,
   * or `null` when the tenant is not registered (→ 404). Construction is fully
   * inside the cached promise so concurrent callers never double-construct.
   */
  function getRuntime(projectKey: string): Promise<ProjectRuntime | null> {
    const existing = runtimes.get(projectKey);
    if (existing !== undefined) return existing;
    const built: Promise<ProjectRuntime | null> = (async () => {
      const displayName = await fetchProjectDisplayName(pool, projectKey);
      if (displayName === null) return null; // unknown tenant → 404
      const store = new PostgresLedgerStore({ pool, projectKey, displayName });
      await store.init();
      const handlers = attachMcpHttp(store, displayName, "", undefined, projectKey);
      return { store, handlers, refresh: makeRefresh(store, projectKey) };
    })();
    runtimes.set(projectKey, built);
    // Do not cache a negative/failed result: evict so a tenant registered later
    // (or a transient construction error) is retried on the next request.
    void built
      .then((rt) => {
        if (rt === null) runtimes.delete(projectKey);
      })
      .catch(() => runtimes.delete(projectKey));
    return built;
  }

  // `makeRefresh` / `getRuntime` / the watcher callbacks below close over
  // `server`; all such uses are DEFERRED (request handlers, notification
  // callbacks), and `scanForPort` binds the server synchronously before any of
  // them can fire — so referencing the `const` from the earlier closures is
  // safe (no use before initialization at runtime).
  const server = scanForPort(opts.port, (p) =>
    Bun.serve<HubWsData>({
      hostname: opts.host,
      port: p,
      idleTimeout: 0, // long-lived SSE / WS streams must not time out
      async fetch(req, srv): Promise<Response | undefined> {
        const url = new URL(req.url);
        if (url.pathname === "/api/projects") {
          if (!checkBearerAuth(req, opts.token)) return unauthorized();
          const projects = await fetchRegisteredProjects(pool);
          const body: ProjectsResponse = { projects };
          return new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
          });
        }
        const route = matchProjectRoute(url.pathname);
        if (route !== null) {
          // Auth gate (Q273) BEFORE any tenant lookup/construction: an
          // unauthenticated caller gets a uniform 401 regardless of whether the
          // projectKey is even registered.
          if (route.leaf === "mcp") {
            if (!checkBearerAuth(req, opts.token)) return unauthorized();
          } else if (!checkWsAuth(url, opts.token)) {
            return unauthorized();
          }
          const runtime = await getRuntime(route.projectKey);
          if (runtime === null) {
            return new Response("unknown project", { status: 404 });
          }
          if (route.leaf === "mcp") {
            return runtime.handlers.handle(req);
          }
          // route.leaf === "ws": upgrade, tagging the socket with its tenant so
          // `websocket.open` subscribes it to the right per-project topic.
          if (srv.upgrade(req, { data: { projectKey: route.projectKey } })) return undefined;
          return new Response("expected a websocket upgrade", { status: 426 });
        }
        // Static bundle + assets stay unauthenticated even when --token is set
        // (Q273) — the UI needs to load before it can surface the token input.
        return serveStatic(url, opts.outdir, indexPath);
      },
      websocket: {
        open(ws: ServerWebSocket<HubWsData>): void {
          ws.subscribe(hubTopic(ws.data.projectKey));
        },
        message(ws: ServerWebSocket<HubWsData>, raw: string | Buffer): void {
          wsHeartbeat((s) => ws.send(s), raw);
        },
      },
    }),
  );

  // ONE hub-level LISTEN connection dispatching every tenant's NOTIFY by its
  // payload project_key. onProjectChange: invalidate that tenant's store (if
  // constructed) and publish to its topic; when the store is NOT yet
  // constructed there is no cache to invalidate, but subscribed sockets still
  // want the frame, so publish directly. onListen (reconnect safety):
  // re-invalidate + publish for every constructed tenant.
  const watcher: PostgresCoherenceWatcher = startPostgresHubCoherenceWatcher(dsn, {
    onProjectChange: (projectKey: string): void => {
      const rt = runtimes.get(projectKey);
      if (rt !== undefined) {
        void rt.then((r) => r?.refresh()).catch(() => undefined);
      } else {
        server.publish(hubTopic(projectKey), changedFrame(null));
      }
    },
    onListen: (): void => {
      for (const rt of runtimes.values()) {
        void rt.then((r) => r?.refresh()).catch(() => undefined);
      }
    },
  });

  // Tear down the hub LISTEN connection when the server stops (main()/tests call
  // server.stop()). The shared pool is closed by the caller AFTER stop — never
  // per-store here (a store's dispose() closes the shared pool). Return type
  // stays the Bun server.
  const origStop = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean): Promise<void> => {
    watcher.close();
    return origStop(closeActiveConnections);
  };

  return server;
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseHubArgs(argv);
  // Q273 startup gate: a non-loopback --host with no --token is refused
  // BEFORE DSN resolution, so a misconfigured bind never touches Postgres.
  try {
    assertTokenIfNonLoopback(args.host, args.token);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cq: fatal: ${msg}\n`);
    process.exit(1);
    return;
  }
  let dsn: string;
  try {
    dsn = resolveHubDsn(args.pgUrlArg, process.env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cq: fatal: ${msg}\n`);
    process.exit(1);
    return;
  }
  const { pool, projects } = await bootHub(dsn);
  const projectList =
    projects.length > 0 ? projects.map((p) => `${p.key} (${p.displayName})`).join(", ") : "(none registered yet)";
  process.stderr.write(`cq serve: serving ${String(projects.length)} project(s): ${projectList}\n`);

  const outdir = process.env["LEDGER_WEB_OUTDIR"] ?? DEFAULT_OUTDIR;
  await fs.mkdir(outdir, { recursive: true });
  await prepare(outdir);
  const indexPath = path.join(outdir, "index.html");

  const opts: HubServeOpts = { host: args.host, port: args.port, token: args.token, outdir };
  const server = serveHub(opts, pool, dsn, indexPath);

  const shutdown = (): void => {
    // serveHub's wrapped stop() closes the hub LISTEN connection; the shared
    // pool is closed here, ONCE, afterwards (never per-store — that would close
    // the pool shared across every tenant).
    server.stop(true);
    void pool.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const actualPort = server.port;
  // Machine-readable URL on stdout (for scripts/orchestrators), mirroring `cq web`.
  process.stdout.write(`http://${args.host}:${actualPort}/\n`);
  process.stderr.write(
    `cq serve: serving http://${args.host}:${actualPort}/ ` +
      (args.token !== null
        ? "(--token set; Authorization: Bearer <token> required on /mcp + /api/projects, ?token= on /ws)\n"
        : "(no --token; loopback bind, auth open)\n"),
  );
}

// Only run main() when executed directly (not when imported by the test suite
// or dynamically imported by cq-cli's dispatcher). `import.meta.main` is
// bun-specific.
const meta = import.meta as unknown as { main?: boolean };
if (meta.main === true) {
  void main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cq serve: fatal: ${msg}\n`);
    process.exit(1);
  });
}
