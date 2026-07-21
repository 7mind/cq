/**
 * T575: `cq log put` — postgres backend write path + store.readLog round-trip.
 *
 * Covers the task acceptance directly:
 *  - `cq log put` (postgres branch, via the exported `runLogPut` handler)
 *    writes a markdown AND a JSONL artifact into the tenant-keyed `logs`
 *    table (T572 schema);
 *  - `PostgresLedgerStore.readLog` (constructed independently, same
 *    project_key) returns that content byte-identical to what was written;
 *  - malformed JSONL is still rejected (exit non-zero, nothing written,
 *    nothing readable via `readLog`) — the SAME redaction + strict-JSONL-
 *    validation pipeline every other backend runs (logPut.ts's shared
 *    pre-branch checks).
 *
 * Env-gated on CQ_TEST_PG_URL (same gate as the @cq/ledger postgres suites):
 * no Postgres server in this sandbox/CI, so this file SKIPS cleanly offline.
 *
 * `CQ_LEDGER_PG_URL` (highest DSN-resolution precedence, dsn.ts) is pointed at
 * CQ_TEST_PG_URL for the duration of each test rather than writing a
 * credential-bearing `[ledger].url` into cq.toml.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { openPgPool, ensureSchema, PostgresLedgerStore } from "@cq/ledger";
import { runLogPut, parseLogPutArgs, type LogPutIo } from "../src/logPut.js";

const exec = promisify(execFile);
const PG_URL = process.env.CQ_TEST_PG_URL;
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/** A throwaway initialised git repo (for a stable projectKey) with cq.toml selecting postgres. */
async function postgresRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-log-put-pg-"));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  // Unique content per repo: two same-second commits over an identical tree
  // by the same author yield the SAME commit SHA — i.e. the same projectKey —
  // which would leak tenant state between tests.
  await writeFile(path.join(dir, "README.md"), `# repo ${randomUUID()}\n`);
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  await writeFile(path.join(dir, "cq.toml"), '[ledger]\nbackend = "postgres"\n', "utf8");
  return dir;
}

async function projectKeyOf(dir: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  });
  return stdout.trim();
}

function makeIo(stdinContent: string): LogPutIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return {
    outs,
    errs,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    readStdin: async () => stdinContent,
  };
}

describe.skipIf(!PG_URL)("cq log put postgres — write path + readLog round-trip (T575)", () => {
  let originalPgUrl: string | undefined;

  beforeEach(() => {
    originalPgUrl = process.env["CQ_LEDGER_PG_URL"];
    process.env["CQ_LEDGER_PG_URL"] = PG_URL;
  });

  afterEach(() => {
    if (originalPgUrl === undefined) {
      delete process.env["CQ_LEDGER_PG_URL"];
    } else {
      process.env["CQ_LEDGER_PG_URL"] = originalPgUrl;
    }
  });

  it("writes a markdown + a JSONL artifact; store.readLog returns byte-identical content", async () => {
    const root = await postgresRepo();
    const projectKey = await projectKeyOf(root);

    const mdContent = "# session\n\nsome notes\n";
    const mdIo = makeIo(mdContent);
    const mdArgs = parseLogPutArgs(root, ["--stdin", "--dest", "logs/20260101-abc.md"]);
    const mdOutcome = await runLogPut(mdArgs, mdIo);
    expect(mdOutcome.exitCode).toBe(0);
    expect(mdIo.errs).toEqual([]);
    expect(mdIo.outs).toEqual([`postgres:${projectKey}/logs/20260101-abc.md`]);

    const jsonlRaw = [`{"event":"start","ts":1}`, `{"event":"end","ts":2}`].join("\n") + "\n";
    const jsonlIo = makeIo(jsonlRaw);
    const jsonlArgs = parseLogPutArgs(root, [
      "--stdin",
      "--dest",
      "logs/raw/20260101-abc.jsonl",
    ]);
    const jsonlOutcome = await runLogPut(jsonlArgs, jsonlIo);
    expect(jsonlOutcome.exitCode).toBe(0);
    expect(jsonlIo.errs).toEqual([]);

    const pool = openPgPool(PG_URL!);
    await ensureSchema(pool);
    const store = new PostgresLedgerStore({ pool, projectKey });
    await store.init();
    try {
      const mdRes = await store.readLog("20260101-abc.md");
      expect(mdRes.content).toBe(mdContent);
      expect(mdRes.truncated).toBeUndefined();

      const jsonlRes = await store.readLog("raw/20260101-abc.jsonl");
      expect(jsonlRes.content).toBe(jsonlRaw);

      // Also resolvable via the repo-relative ".cq/logs/<rel>" form
      // (the strip-prefix convention shared across every backend).
      const viaRepoRel = await store.readLog(".cq/logs/20260101-abc.md");
      expect(viaRepoRel.content).toBe(mdContent);
    } finally {
      await store.dispose();
    }
  });

  it("rejects malformed JSONL: exits non-zero, writes NOTHING (JSONL validation runs BEFORE any backend dispatch)", async () => {
    const root = await postgresRepo();
    const projectKey = await projectKeyOf(root);

    // Pretty-printed JSON is not valid JSONL (multi-line value).
    const prettyPrinted = '{\n  "event": "bad"\n}\n';
    const io = makeIo(prettyPrinted);
    const args = parseLogPutArgs(root, ["--stdin", "--dest", "logs/raw/bad.jsonl"]);
    const outcome = await runLogPut(args, io);

    expect(outcome.exitCode).not.toBe(0);
    expect(io.errs.join("\n")).toMatch(/line \d+/);
    expect(io.errs.join("\n")).toContain("malformed JSONL");

    // JSONL validation runs BEFORE the backend branch (runLogPut, shared
    // pre-branch checks), so the postgres branch never ran: no tenant was
    // registered and no `logs` row exists for this project_key at all.
    const pool = openPgPool(PG_URL!);
    await ensureSchema(pool);
    try {
      const projectRows = await pool<Array<{ project_key: string }>>`
        SELECT project_key FROM projects WHERE project_key = ${projectKey}
      `;
      expect(projectRows).toHaveLength(0);
      const logRows = await pool<Array<{ path: string }>>`
        SELECT path FROM logs WHERE project_key = ${projectKey} AND path = 'raw/bad.jsonl'
      `;
      expect(logRows).toHaveLength(0);
    } finally {
      await pool.close();
    }
  });
});
