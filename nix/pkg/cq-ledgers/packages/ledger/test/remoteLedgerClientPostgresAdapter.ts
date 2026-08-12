/**
 * The PRODUCTION leg of the T727 RemoteLedgerClient dual contract: a REAL
 * `cq serve` hub subprocess (ledger-web/src/hubServe.ts — spawned exactly
 * like hubServe.test.ts/hubRouting.test.ts do) over a REAL PostgreSQL
 * database.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, the same gate as every other
 * postgres-backend suite): with no server reachable the whole leg is an
 * EXPLICIT `describe.skip` (`skip: true`), never a silent pass. One hub
 * subprocess is shared across the leg's cases (`sharedSetup`, booted with
 * `--port 0` + a `--token`); `build()` isolates each case behind a fresh
 * throwaway tenant projectKey, mirroring the per-test tenant isolation of
 * store-postgres.test.ts.
 *
 * Explicit production limitations (the contract reads these as
 * `it.skipIf`-gated cases): the REAL server cannot be made to negotiate an
 * unsupported protocol version, nor to emit a malformed tool result — those
 * two wire behaviours are pinned on the in-memory leg only.
 */

import { spawn as bunSpawn } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureSchema, MILESTONES_AMBIENT_ID, openPgPool } from "../src/index.js";
import type {
  RemoteContractService,
  RemoteLedgerClientContractFactory,
} from "./remoteLedgerClientContract.js";

const PG_URL_ENV = "CQ_TEST_PG_URL";
const PG_URL = process.env[PG_URL_ENV];

const here = new URL(".", import.meta.url).pathname;
/** The real `cq serve` entrypoint (packages/ledger-web/src/hubServe.ts). */
const hubMain = path.resolve(here, "..", "..", "ledger-web", "src", "hubServe.ts");

interface SharedHub {
  readonly serverUrl: string;
  readonly token: string;
  readonly outdir: string;
  readonly proc: HubProc;
  readonly pool: ReturnType<typeof openPgPool>;
}

/** The slice of the spawned hub process this adapter drives. */
interface HubProc {
  readonly stdout: ReadableStream<Uint8Array>;
  kill(): void;
  readonly exited: Promise<number>;
}

let shared: SharedHub | null = null;

/** Read the hub's machine-readable `http://host:port/` stdout line. */
async function readUrlLine(proc: HubProc): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error("cq serve did not emit a URL within 60s"));
    }, 60_000);
  });
  return await Promise.race([
    (async (): Promise<string> => {
      while (!buf.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) throw new Error("cq serve stdout closed without a URL line");
        buf += decoder.decode(value, { stream: true });
      }
      return buf.slice(0, buf.indexOf("\n")).trim();
    })(),
    timeout,
  ]);
}

async function bootSharedHub(): Promise<void> {
  if (PG_URL === undefined || PG_URL === "") {
    throw new Error(`postgresRemoteClientFactory: ${PG_URL_ENV} is not set`);
  }
  const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "t727-hub-out-"));
  const token = `t727-hub-${randomUUID()}`;
  const proc = bunSpawn({
    cmd: [
      process.execPath,
      "run",
      hubMain,
      "--pg-url",
      PG_URL,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--token",
      token,
    ],
    cwd: os.tmpdir(), // NO repo cwd / cq.toml anywhere near this dir
    env: {
      ...process.env,
      LEDGER_WEB_OUTDIR: outdir,
      // Prompt-agnostic leg: no ambient prompt root leaks into the hub.
      CQ_PROMPT_ROOT: undefined,
      CQ_PROMPT_SURFACE: undefined,
      CQ_PROMPT_SURFACES_ROOT: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const urlLine = await readUrlLine(proc as HubProc);
    const match = /^http:\/\/127\.0\.0\.1:(\d+)\/$/.exec(urlLine);
    if (match === null) {
      throw new Error(`cq serve emitted an unexpected URL line: ${urlLine}`);
    }
    const pool = openPgPool(PG_URL);
    await ensureSchema(pool);
    shared = {
      serverUrl: `http://127.0.0.1:${match[1] ?? ""}/`,
      token,
      outdir,
      proc,
      pool,
    };
  } catch (err) {
    proc.kill();
    await proc.exited;
    await fs.rm(outdir, { recursive: true, force: true });
    throw err;
  }
}

async function stopSharedHub(): Promise<void> {
  const current = shared;
  shared = null;
  if (current === null) return;
  current.proc.kill();
  await current.proc.exited;
  await current.pool.close();
  await fs.rm(current.outdir, { recursive: true, force: true });
}

function requireShared(): SharedHub {
  if (shared === null) {
    throw new Error("postgresRemoteClientFactory: shared hub is not booted");
  }
  return shared;
}

/** The production (real `cq serve`/PostgreSQL) leg — env-gated, explicit skip. */
export const postgresRemoteClientFactory: RemoteLedgerClientContractFactory = {
  name: "real cq serve/PostgreSQL hub",
  classification: "Behavioral-Active Blackbox-GoodCommunication",
  skip: PG_URL === undefined || PG_URL === "",
  capabilities: { bogusProtocolVersion: false, malformedResponses: false },
  sharedSetup: bootSharedHub,
  sharedTeardown: stopSharedHub,
  build(): Promise<RemoteContractService> {
    const hub = requireShared();
    const projectKey = `t727-pg-${randomUUID()}`;
    const displayName = `T727 PG ${projectKey}`;
    return Promise.resolve({
      serverUrl: hub.serverUrl,
      validToken: hub.token,
      invalidToken: `t727-invalid-${randomUUID()}`,
      projectKey,
      displayName,
      seedLog: async (relPath, content) => {
        // The store-side write path's raw-SQL equivalent (PostgresLedgerStore
        // .putLog upserts (project_key, path)); the tenant row is upserted
        // first so the insert holds regardless of any FK. The hub's read_log
        // is a fresh SELECT per call, so no cache invalidation is needed.
        await hub.pool`
          INSERT INTO projects (project_key, display_name)
          VALUES (${projectKey}, ${displayName})
          ON CONFLICT (project_key) DO NOTHING
        `;
        await hub.pool`
          INSERT INTO logs (project_key, path, content)
          VALUES (${projectKey}, ${relPath}, ${content})
          ON CONFLICT (project_key, path) DO UPDATE SET content = EXCLUDED.content
        `;
      },
      seedUnsafeOperatorActionLinkedState: async (actionId, state) => {
        const taskId = `T${actionId.slice(2)}`;
        const handoffId = `HO${actionId.slice(2)}`;
        const updated =
          state === "task-status"
            ? await hub.pool<Array<{ id: string }>>`
                UPDATE items SET status = 'wip'
                WHERE project_key = ${projectKey} AND ledger = 'tasks' AND id = ${taskId}
                RETURNING id
              `
            : state === "handoff-status"
              ? await hub.pool<Array<{ id: string }>>`
                  UPDATE items SET status = 'drained'
                  WHERE project_key = ${projectKey} AND ledger = 'handoffs' AND id = ${handoffId}
                  RETURNING id
                `
              : state === "action-milestone-mismatch"
                ? await hub.pool<Array<{ id: string }>>`
                    UPDATE items SET milestone_id = ${MILESTONES_AMBIENT_ID}
                    WHERE project_key = ${projectKey} AND ledger = 'operatorActions' AND id = ${actionId}
                    RETURNING id
                  `
                : await hub.pool<Array<{ id: string }>>`
                    UPDATE items SET milestone_id = ${MILESTONES_AMBIENT_ID}
                    WHERE project_key = ${projectKey} AND ledger = 'handoffs' AND id = ${handoffId}
                    RETURNING id
                  `;
        if (updated.length !== 1) {
          throw new Error(`expected one ${state} corruption target for ${actionId}`);
        }
      },
      // Tenant rows are throwaway (unique projectKey per case); the shared hub
      // subprocess + pool are released by sharedTeardown.
      dispose: () => Promise.resolve(),
    });
  },
};
