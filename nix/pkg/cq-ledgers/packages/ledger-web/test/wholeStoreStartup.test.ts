/**
 * T838 — whole-store cq web startup composition, process-level.
 *
 * Behavioral-Active × Blackbox-Process suite: every test spawns the real
 * `serve.ts` entry point as a subprocess and observes only its stdout/stderr,
 * exit code, bound ports, and the MCP/HTTP wire surface. Covered:
 *
 *   - explicit mode (--backend=xdg --store …): discovery of readable stores,
 *     rejection diagnostics, bounded identity backfill + refreshed labels,
 *     checkout-hint preselection, bootstrap-only inclusion, default port
 *     5191, startup output, SIGINT cleanup, no auth challenge, no PostgreSQL;
 *   - implicit mode (non-repository cwd): default $XDG_STATE_HOME root,
 *     deterministic first-project fallback, SIGTERM cleanup;
 *   - port scanning upward from 5191 and the rollback when all 64 ports are
 *     occupied (clean non-zero exit, nothing left bound);
 *   - empty / fully-invalid / missing projects roots (fatal, rejections
 *     emitted, no bundle build needed);
 *   - unchanged embedded and proxy wiring for repository and --mcp-url
 *     launches.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { spawn as bunSpawn, type Subprocess } from "bun";
import { execFileSync } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SqliteLedgerStore, SqliteXdgProjectIdentityAccess } from "@cq/ledger";

const here = new URL(".", import.meta.url).pathname;
const webMain = path.resolve(here, "..", "src", "serve.ts");

const WHOLE_STORE_PORT = 5191;
const PORT_SCAN_ATTEMPTS = 64;
const PROCESS_TIMEOUT_MS = 60_000;

const temporaryRoots: string[] = [];
const spawned: Subprocess[] = [];

afterEach(async () => {
  for (const proc of spawned.splice(0)) {
    proc.kill();
    await proc.exited;
  }
});

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDirectory(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(dir);
  return dir;
}

/**
 * Seed one XDG project store directly at `projectsRoot/<key>` (bypassing the
 * repo-rooted factory so a custom store root needs no env juggling). The
 * store starts bootstrap-only; `substantive` adds one milestone. Identity
 * metadata is written only when `displayName` is given.
 */
async function seedProject(
  projectsRoot: string,
  key: string,
  opts: { displayName?: string; repositoryPath?: string; substantive?: boolean } = {},
): Promise<void> {
  const stateDir = path.join(projectsRoot, key, "state");
  await fs.mkdir(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, "ledger.db");
  const store = new SqliteLedgerStore({
    dbPath,
    logsDir: path.join(projectsRoot, key, "logs"),
  });
  await store.init();
  if (opts.substantive === true) {
    await store.createMilestone({ title: `seeded milestone in ${key}` });
  }
  await store.dispose();
  if (opts.displayName !== undefined) {
    const db = new Database(dbPath);
    try {
      new SqliteXdgProjectIdentityAccess(db).upsertProjectIdentity({
        repositoryPath: opts.repositoryPath ?? `/definitely-not-a-checkout/${key}`,
        displayName: opts.displayName,
      });
    } finally {
      db.close();
    }
  }
}

/** A git repository (no commits) whose project key is pinned by projectId. */
async function makeHintRepository(opts: {
  projectId: string;
  name?: string;
  backend?: string;
  url?: string;
}): Promise<string> {
  const root = await makeDirectory("ledger-web-whole-repo-");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const lines = [
    ...(opts.name === undefined ? [] : ["[project]", `name = "${opts.name}"`, ""]),
    "[ledger]",
    `backend = "${opts.backend ?? "xdg"}"`,
    `projectId = "${opts.projectId}"`,
    ...(opts.url === undefined ? [] : [`url = "${opts.url}"`]),
  ];
  await fs.writeFile(path.join(root, "cq.toml"), `${lines.join("\n")}\n`, "utf8");
  return root;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        return reject(new Error("no port"));
      }
      const port = address.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Find a run of `length` consecutive ports with nothing listening, so the
 * test can occupy the ENTIRE scan range regardless of what else runs on the
 * host (the fixed 5191..5254 range is not guaranteed free on a dev machine).
 */
async function findFreePortRun(length: number): Promise<number> {
  for (let base = 20000; base + length <= 65000; base++) {
    let blockedAt = -1;
    for (let port = base; port < base + length; port++) {
      if (await isPortOpen(port)) {
        blockedAt = port;
        break;
      }
    }
    if (blockedAt === -1) return base;
    base = blockedAt; // resume just past the occupied port
  }
  throw new Error("no free consecutive port run found");
}

async function assertPortClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.end();
      reject(new Error(`port ${port} is still open`));
    });
    socket.once("error", () => resolve());
  });
}

interface SpawnedWeb {
  readonly proc: Subprocess;
  readonly url: string;
  stderrText(): string;
}

/** Spawn serve.ts and wait for the machine-readable URL on stdout. */
async function spawnWeb(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<SpawnedWeb> {
  const stderrBuf: string[] = [];
  let resolveUrl: (value: string) => void;
  let rejectUrl: (error: Error) => void;
  const urlLine = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const proc = bunSpawn({
    cmd: [process.execPath, "run", webMain, ...args],
    env: {
      ...process.env,
      // Prompt-agnostic: no ambient prompt root leaks into the spawned server.
      CQ_PROMPT_ROOT: undefined,
      CQ_PROMPT_SURFACE: undefined,
      CQ_PROMPT_SURFACES_ROOT: undefined,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  spawned.push(proc);

  let stdoutText = "";
  const stdoutReader = proc.stdout.getReader();
  const readStdout = async (): Promise<void> => {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutText += decoder.decode(value, { stream: true });
        const newline = stdoutText.indexOf("\n");
        if (newline !== -1) {
          resolveUrl(stdoutText.slice(0, newline).trim());
          return;
        }
      }
      rejectUrl(new Error(`stdout closed without a URL line; stderr: ${stderrBuf.join("")}`));
    } catch (error) {
      rejectUrl(error instanceof Error ? error : new Error(String(error)));
    }
  };
  void readStdout();

  const stderrReader = proc.stderr.getReader();
  const readStderr = async (): Promise<void> => {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrBuf.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* ignore read errors after kill */
    }
  };
  void readStderr();

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(new Error(`serve.ts did not emit a URL within 30s; stderr: ${stderrBuf.join("")}`)),
      30_000,
    ),
  );
  const url = await Promise.race([urlLine, timeout]);
  return { proc, url, stderrText: () => stderrBuf.join("") };
}

/** Spawn serve.ts expecting a startup failure: capture the exit code + stderr. */
async function spawnExpectFailure(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ code: number | null; stderr: string }> {
  const proc = bunSpawn({
    cmd: [process.execPath, "run", webMain, ...args],
    env: {
      ...process.env,
      CQ_PROMPT_ROOT: undefined,
      CQ_PROMPT_SURFACE: undefined,
      CQ_PROMPT_SURFACES_ROOT: undefined,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  spawned.push(proc);
  const stderrPromise = Bun.readableStreamToText(proc.stderr);
  const stdoutPromise = Bun.readableStreamToText(proc.stdout);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("serve.ts did not exit within 30s")), 30_000),
  );
  await Promise.race([proc.exited, timeout]);
  const [stderr] = await Promise.all([stderrPromise, stdoutPromise]);
  return { code: proc.exitCode, stderr };
}

async function connectMcp(base: string, route: string, name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${route}`));
  const client = new Client({ name, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport as unknown as Transport);
  return client;
}

function textOf(result: unknown): string {
  const first = (result as { content: Array<{ type: string; text?: string }> }).content[0];
  if (first === undefined || first.type !== "text" || first.text === undefined) {
    throw new Error("expected one text result");
  }
  return first.text;
}

function decode<T>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

describe("cq web whole-store startup composition (T838)", () => {
  it(
    "explicit mode composes discovery, backfill, labels, preselection, and SIGINT cleanup with no auth or PostgreSQL",
    async () => {
      const storeRoot = await makeDirectory("ledger-web-whole-store-");
      // The checkout hint's project: seeded WITHOUT identity metadata — the
      // startup backfill must persist it and the refresh must surface the
      // backfilled display name.
      await seedProject(storeRoot, "zzz-hint", { substantive: true });
      // A bootstrap-only foreign project WITH identity: included, labelled.
      await seedProject(storeRoot, "aaa-other", { displayName: "alpha-first" });
      // Invalid candidates → rejection diagnostics, startup continues.
      await fs.mkdir(path.join(storeRoot, "broken-missing-db"));
      await fs.writeFile(path.join(storeRoot, "loose-file"), "not a project\n");
      await fs.symlink("zzz-hint", path.join(storeRoot, "link-candidate"));
      // The hint repo pins backend="postgres" with an unusable DSN: explicit
      // XDG mode must never read the repository's backend/PostgreSQL settings.
      const hintRepo = await makeHintRepository({
        projectId: "zzz-hint",
        name: "omega-hint",
        backend: "postgres",
        url: "postgres://must-not-be-read.invalid/cq",
      });
      const xdgHome = await makeDirectory("ledger-web-whole-xdg-");
      const outdir = await makeDirectory("ledger-web-whole-out-");

      const web = await spawnWeb(["--backend=xdg", "--store", storeRoot, "--cwd", hintRepo], {
        XDG_STATE_HOME: xdgHome,
        LEDGER_WEB_OUTDIR: outdir,
        // Poisoned auth/PostgreSQL environment: any read of these would
        // challenge or fail the startup — startup must succeed regardless.
        CQ_SERVE_TOKEN: "must-not-be-read",
        CQ_LEDGER_PG_URL: "postgres://must-not-be-read.invalid/env",
        DATABASE_URL: "postgres://must-not-be-read.invalid/database",
      });
      expect(web.url).toBe(`http://127.0.0.1:${WHOLE_STORE_PORT}/`);

      // No auth challenge on the MCP surface (Q335: no authentication, as in
      // embedded cq web).
      const probe = await fetch(`${web.url}mcp`, { method: "POST" });
      expect(probe.status).not.toBe(401);
      await probe.text();

      // Labels + bootstrap-only inclusion over the wire (startup-static list).
      const alias = await connectMcp(web.url, "/mcp", "alias");
      try {
        const listing = decode<{ projects: Array<{ key: string; displayName: string }> }>(
          await alias.callTool({ name: "list_projects", arguments: {} }),
        );
        expect(listing).toEqual({
          projects: [
            { key: "aaa-other", displayName: "alpha-first" },
            { key: "zzz-hint", displayName: "omega-hint" },
          ],
        });
      } finally {
        await alias.close();
      }

      // The preselected project serves read-write runtimes per project.
      const hinted = await connectMcp(web.url, "/p/zzz-hint/mcp", "hinted");
      try {
        await hinted.callTool({
          name: "create_item",
          arguments: {
            ledger_id: "milestones",
            id: "M900",
            status: "open",
            fields: { title: "via whole-store" },
          },
        });
        const ledgers = decode<{ ledgers: string[] }>(
          await hinted.callTool({ name: "enumerate_ledgers", arguments: {} }),
        );
        expect(ledgers.ledgers).toContain("tasks");
      } finally {
        await hinted.close();
      }

      // SIGINT cleanup: exit 0, port released, initialized runtimes disposed.
      web.proc.kill("SIGINT");
      await web.proc.exited;
      expect(web.proc.exitCode).toBe(0);
      await assertPortClosed(WHOLE_STORE_PORT);

      const stderr = web.stderrText();
      expect(stderr).toContain(
        "ledger-web: rejected XDG project broken-missing-db: missing-database:",
      );
      expect(stderr).toContain("ledger-web: rejected XDG project link-candidate: symlink:");
      expect(stderr).toContain("ledger-web: rejected XDG project loose-file: not-directory:");
      expect(stderr).toContain(
        "ledger-web: serving 2 project(s): aaa-other (alpha-first), zzz-hint (omega-hint)",
      );
      expect(stderr).toContain(`→ XDG store ${storeRoot} (initial project: zzz-hint (omega-hint))`);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "implicit mode resolves the default root, falls back to the first project, and cleans up on SIGTERM",
    async () => {
      const xdgHome = await makeDirectory("ledger-web-implicit-xdg-");
      const projectsRoot = path.join(xdgHome, "cq", "projects");
      await seedProject(projectsRoot, "bbb-second", {
        displayName: "beta-second",
        substantive: true,
      });
      await seedProject(projectsRoot, "aaa-first", { displayName: "alpha-first" });
      // A non-repository cwd selects implicit whole-store mode (T834).
      const cwd = await makeDirectory("ledger-web-implicit-cwd-");
      const outdir = await makeDirectory("ledger-web-implicit-out-");
      const port = await freePort();

      const web = await spawnWeb(["--cwd", cwd, "--port", String(port)], {
        XDG_STATE_HOME: xdgHome,
        LEDGER_WEB_OUTDIR: outdir,
      });
      expect(web.url).toBe(`http://127.0.0.1:${port}/`);

      const client = await connectMcp(web.url, "/mcp", "implicit");
      try {
        const listing = decode<{ projects: Array<{ key: string; displayName: string }> }>(
          await client.callTool({ name: "list_projects", arguments: {} }),
        );
        expect(listing.projects).toEqual([
          { key: "aaa-first", displayName: "alpha-first" },
          { key: "bbb-second", displayName: "beta-second" },
        ]);
      } finally {
        await client.close();
      }

      web.proc.kill("SIGTERM");
      await web.proc.exited;
      expect(web.proc.exitCode).toBe(0);
      await assertPortClosed(port);

      const stderr = web.stderrText();
      expect(stderr).toContain(
        "ledger-web: serving 2 project(s): aaa-first (alpha-first), bbb-second (beta-second)",
      );
      expect(stderr).toContain(
        `→ XDG store ${projectsRoot} (initial project: aaa-first (alpha-first))`,
      );
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "scans upward from the whole-store default port 5191",
    async () => {
      const xdgHome = await makeDirectory("ledger-web-scan-xdg-");
      const projectsRoot = path.join(xdgHome, "cq", "projects");
      await seedProject(projectsRoot, "only", { displayName: "only-project" });
      const cwd = await makeDirectory("ledger-web-scan-cwd-");
      const outdir = await makeDirectory("ledger-web-scan-out-");
      const occupier = Bun.serve({
        hostname: "127.0.0.1",
        port: WHOLE_STORE_PORT,
        fetch: () => new Response("occupied"),
      });
      try {
        const web = await spawnWeb(["--backend=xdg", "--store", projectsRoot, "--cwd", cwd], {
          XDG_STATE_HOME: xdgHome,
          LEDGER_WEB_OUTDIR: outdir,
        });
        expect(web.url).toBe(`http://127.0.0.1:${WHOLE_STORE_PORT + 1}/`);
        web.proc.kill();
        await web.proc.exited;
      } finally {
        await occupier.stop(true);
      }
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "rolls back cleanly when the whole 64-port scan range is occupied, leaving nothing bound",
    async () => {
      const xdgHome = await makeDirectory("ledger-web-rollback-xdg-");
      const projectsRoot = path.join(xdgHome, "cq", "projects");
      await seedProject(projectsRoot, "only", { displayName: "only-project" });
      const cwd = await makeDirectory("ledger-web-rollback-cwd-");
      const outdir = await makeDirectory("ledger-web-rollback-out-");
      // Drive the scan over a fully-occupied range we control (the default
      // 5191-range is covered by the scan test above and is not guaranteed
      // free on every host).
      const basePort = await findFreePortRun(PORT_SCAN_ATTEMPTS);
      const lastPort = basePort + PORT_SCAN_ATTEMPTS - 1;
      const occupiers: Array<ReturnType<typeof Bun.serve>> = [];
      for (let port = basePort; port <= lastPort; port++) {
        occupiers.push(
          Bun.serve({
            hostname: "127.0.0.1",
            port,
            fetch: () => new Response("occupied"),
          }),
        );
      }
      try {
        const result = await spawnExpectFailure(
          ["--backend=xdg", "--store", projectsRoot, "--cwd", cwd, "--port", String(basePort)],
          { XDG_STATE_HOME: xdgHome, LEDGER_WEB_OUTDIR: outdir },
        );
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
          `no free port in ${basePort}..${lastPort} (${PORT_SCAN_ATTEMPTS} attempts`,
        );
        expect(result.stderr).toContain("ledger-web: fatal:");
      } finally {
        await Promise.all(occupiers.map((server) => server.stop(true)));
      }
      // Nothing lingered: the range is bindable again immediately.
      const probe = Bun.serve({
        hostname: "127.0.0.1",
        port: basePort,
        fetch: () => new Response("probe"),
      });
      await probe.stop(true);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "fails fast on an empty or fully-invalid projects root, emitting rejections before the fatal line",
    async () => {
      const cwd = await makeDirectory("ledger-web-empty-cwd-");

      const emptyRoot = await makeDirectory("ledger-web-empty-store-");
      const emptyOutdir = await makeDirectory("ledger-web-empty-out-");
      const empty = await spawnExpectFailure(
        ["--backend=xdg", "--store", emptyRoot, "--cwd", cwd],
        { LEDGER_WEB_OUTDIR: emptyOutdir },
      );
      expect(empty.code).toBe(1);
      expect(empty.stderr).toContain(
        `ledger-web: fatal: no readable XDG projects under ${emptyRoot} (0 candidate(s) rejected)`,
      );

      const invalidRoot = await makeDirectory("ledger-web-invalid-store-");
      await fs.mkdir(path.join(invalidRoot, "broken-missing-db"));
      await fs.writeFile(path.join(invalidRoot, "loose-file"), "not a project\n");
      const invalidOutdir = await makeDirectory("ledger-web-invalid-out-");
      const invalid = await spawnExpectFailure(
        ["--backend=xdg", "--store", invalidRoot, "--cwd", cwd],
        { LEDGER_WEB_OUTDIR: invalidOutdir },
      );
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain(
        "ledger-web: rejected XDG project broken-missing-db: missing-database:",
      );
      expect(invalid.stderr).toContain(
        "ledger-web: rejected XDG project loose-file: not-directory:",
      );
      expect(invalid.stderr).toContain(
        `ledger-web: fatal: no readable XDG projects under ${invalidRoot} (2 candidate(s) rejected)`,
      );
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "fails fast when the projects root does not exist",
    async () => {
      const parent = await makeDirectory("ledger-web-missing-parent-");
      const missingRoot = path.join(parent, "no-such-root");
      const cwd = await makeDirectory("ledger-web-missing-cwd-");
      const outdir = await makeDirectory("ledger-web-missing-out-");
      const result = await spawnExpectFailure(
        ["--backend=xdg", "--store", missingRoot, "--cwd", cwd],
        { LEDGER_WEB_OUTDIR: outdir },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("does not exist or is unreadable");
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "keeps the embedded mode wiring unchanged inside a repository",
    async () => {
      const repo = await makeHintRepository({ projectId: "embedded-check" });
      const xdgHome = await makeDirectory("ledger-web-embedded-xdg-");
      const outdir = await makeDirectory("ledger-web-embedded-out-");
      const port = await freePort();
      const web = await spawnWeb(["--cwd", repo, "--port", String(port)], {
        XDG_STATE_HOME: xdgHome,
        LEDGER_WEB_OUTDIR: outdir,
      });
      expect(web.url).toBe(`http://127.0.0.1:${port}/`);
      const index = await fetch(web.url);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('window.__LEDGER_MCP_URL__ = "/mcp"');
      web.proc.kill();
      await web.proc.exited;
      expect(web.stderrText()).toContain(`→ embedded MCP (cwd=${repo})`);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "keeps the proxy mode wiring unchanged when --mcp-url is given",
    async () => {
      const repo = await makeHintRepository({ projectId: "proxy-check" });
      const outdir = await makeDirectory("ledger-web-proxy-out-");
      const port = await freePort();
      const upstreamPort = await freePort(); // nothing listens: proxy must 502
      const upstream = `http://127.0.0.1:${upstreamPort}/mcp`;
      const web = await spawnWeb(["--mcp-url", upstream, "--cwd", repo, "--port", String(port)], {
        LEDGER_WEB_OUTDIR: outdir,
      });
      expect(web.url).toBe(`http://127.0.0.1:${port}/`);
      const index = await fetch(web.url);
      expect(index.status).toBe(200);
      const proxied = await fetch(`${web.url}mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(proxied.status).toBe(502);
      await proxied.text();
      web.proc.kill();
      await web.proc.exited;
      expect(web.stderrText()).toContain(`→ MCP upstream ${upstream}`);
    },
    PROCESS_TIMEOUT_MS,
  );
});
