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
 * This module is the SKELETON (T586): argv parsing, DSN resolution + fail-fast,
 * schema bootstrap under the advisory lock, a whole-registry projects listing,
 * and static web-bundle serving on ONE bound port. Per-project routing (a
 * `/p/<projectKey>/mcp` style mount per tenant, reusing `attachMcpHttp`) is
 * EXPLICITLY DEFERRED to T587, and `--token` enforcement to T588 — this module
 * parses and threads the flag through but does not yet gate any request on it.
 *
 * Reuses ledger-web's existing bundle-serving internals (`buildBundle`,
 * `prepare`, `serveStatic`, `scanForPort`, `DEFAULT_OUTDIR`) from serve.ts —
 * the SAME browser bundle `cq web` serves, since the hub's `GET /` is the
 * identical React app (T587 will teach it to talk to the right per-project
 * endpoint once those exist).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openPgPool, ensureSchema, type ProjectEntry } from "@cq/ledger";
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
   * `--token <secret>`, parsed and threaded through to {@link HubServeOpts} but
   * NOT YET ENFORCED — auth gating on this value is T588's job. `null` when
   * the flag is absent.
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

/** Resolved options for {@link serveHub}, after DSN resolution + argv parsing. */
export interface HubServeOpts {
  host: string;
  port: number;
  /** Parsed from `--token` but NOT YET ENFORCED anywhere — see the module doc; T588 wires auth. */
  token: string | null;
  outdir: string;
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
 * Bind ONE `Bun.serve` port hosting the web bundle (`GET /` + assets, via
 * `serveStatic`) and the whole-registry projects listing (`GET /api/projects`).
 * Per-project routing (a `/mcp` mount per tenant) and `opts.token` enforcement
 * are EXPLICITLY OUT OF SCOPE here — T587/T588 respectively; this skeleton
 * answers only the two routes named in T586's acceptance criterion.
 */
export function serveHub(
  opts: HubServeOpts,
  pool: ReturnType<typeof openPgPool>,
  indexPath: string,
): ReturnType<typeof Bun.serve> {
  return scanForPort(opts.port, (p) =>
    Bun.serve({
      hostname: opts.host,
      port: p,
      async fetch(req): Promise<Response> {
        const url = new URL(req.url);
        if (url.pathname === "/api/projects") {
          const projects = await fetchRegisteredProjects(pool);
          const body: ProjectsResponse = { projects };
          return new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
          });
        }
        return serveStatic(url, opts.outdir, indexPath);
      },
    }),
  );
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseHubArgs(argv);
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
  const server = serveHub(opts, pool, indexPath);

  const shutdown = (): void => {
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
      (args.token !== null ? "(--token set; enforcement lands in T588)\n" : "(no --token; auth deferred to T588)\n"),
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
