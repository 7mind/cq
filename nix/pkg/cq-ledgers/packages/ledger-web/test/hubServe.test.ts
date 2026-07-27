/**
 * `cq serve` hub server skeleton (T586).
 *
 * Pure-unit coverage (no Postgres needed, always run):
 *   - parseHubArgs: defaults, --host/--port/--pg-url/--token overrides,
 *     --port 0 allowed (unlike `cq web`'s validator).
 *   - resolveHubDsn: --pg-url > CQ_LEDGER_PG_URL > DATABASE_URL precedence,
 *     and the actionable HubDsnResolutionError when none resolves.
 *
 * Env-gated on CQ_TEST_PG_URL (same gate as every other postgres-backend
 * suite): the live-boot acceptance check spawns the real `hubServe.ts` binary
 * as a subprocess (its own Bun.build run, mirroring serveEmbedded.test.ts) with
 * `--port 0` and asserts it boots with NO repo cwd, `GET /` serves the web
 * bundle, and `GET /api/projects` lists every registered tenant.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawn as bunSpawn } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { openPgPool, ensureSchema, PostgresLedgerStore } from "@cq/ledger";
import {
  parseHubArgs,
  resolveHubDsn,
  resolveHubToken,
  HubDsnResolutionError,
  HUB_DEFAULT_HOST,
  HUB_DEFAULT_PORT,
  PROJECT_DISPLAY_NAME_HEADER,
  PROJECT_DISPLAY_NAME_MAX_BYTES,
  projectDisplayNameFromRequest,
  isLoopbackHost,
  assertTokenIfNonLoopback,
  HubTokenRequiredError,
} from "../src/hubServe.js";

describe("projectDisplayNameFromRequest", () => {
  it("uses trimmed authenticated request metadata, falling back to the project key", () => {
    const named = new Request("http://localhost/mcp", {
      headers: { [PROJECT_DISPLAY_NAME_HEADER]: "  Human name  " },
    });
    expect(projectDisplayNameFromRequest(named, "project-key")).toBe("Human name");

    for (const value of [undefined, "", "   "]) {
      const req =
        value === undefined
          ? new Request("http://localhost/mcp")
          : new Request("http://localhost/mcp", {
              headers: { [PROJECT_DISPLAY_NAME_HEADER]: value },
            });
      expect(
        projectDisplayNameFromRequest(req, "project-key"),
      ).toBe("project-key");
    }
  });

  it("rejects display-name metadata beyond the persisted boundary", () => {
    const req = new Request("http://localhost/mcp", {
      headers: {
        [PROJECT_DISPLAY_NAME_HEADER]: "x".repeat(PROJECT_DISPLAY_NAME_MAX_BYTES + 1),
      },
    });
    expect(() => projectDisplayNameFromRequest(req, "project-key")).toThrow(
      new RegExp(`${String(PROJECT_DISPLAY_NAME_MAX_BYTES)} bytes`),
    );
  });
});

describe("parseHubArgs", () => {
  it("defaults host/port/token/pgUrlArg when no flags are given", () => {
    expect(parseHubArgs([])).toEqual({
      host: HUB_DEFAULT_HOST,
      port: HUB_DEFAULT_PORT,
      pgUrlArg: undefined,
      token: null,
    });
  });

  it("parses --pg-url, --host, --port, --token (space form)", () => {
    const args = parseHubArgs([
      "--pg-url",
      "postgres://u:p@h:5432/db",
      "--host",
      "0.0.0.0",
      "--port",
      "9999",
      "--token",
      "secret1",
    ]);
    expect(args).toEqual({
      host: "0.0.0.0",
      port: 9999,
      pgUrlArg: "postgres://u:p@h:5432/db",
      token: "secret1",
    });
  });

  it("parses the `=` form for every flag", () => {
    const args = parseHubArgs([
      "--pg-url=postgres://u:p@h:5432/db",
      "--host=0.0.0.0",
      "--port=9999",
      "--token=secret1",
    ]);
    expect(args).toEqual({
      host: "0.0.0.0",
      port: 9999,
      pgUrlArg: "postgres://u:p@h:5432/db",
      token: "secret1",
    });
  });

  it("allows --port 0 (OS-assigned ephemeral port)", () => {
    expect(parseHubArgs(["--port", "0"]).port).toBe(0);
  });

  it("rejects an out-of-range or non-integer --port", () => {
    expect(() => parseHubArgs(["--port", "-1"])).toThrow(/--port must be 0..65535/);
    expect(() => parseHubArgs(["--port", "70000"])).toThrow(/--port must be 0..65535/);
    expect(() => parseHubArgs(["--port", "abc"])).toThrow(/--port must be 0..65535/);
  });
});

describe("resolveHubDsn", () => {
  it("prefers --pg-url over both env vars", () => {
    expect(
      resolveHubDsn("postgres://from-flag", {
        CQ_LEDGER_PG_URL: "postgres://from-cq-env",
        DATABASE_URL: "postgres://from-database-url",
      }),
    ).toBe("postgres://from-flag");
  });

  it("falls back to CQ_LEDGER_PG_URL over DATABASE_URL when --pg-url is absent", () => {
    expect(
      resolveHubDsn(undefined, {
        CQ_LEDGER_PG_URL: "postgres://from-cq-env",
        DATABASE_URL: "postgres://from-database-url",
      }),
    ).toBe("postgres://from-cq-env");
  });

  it("falls back to DATABASE_URL when --pg-url and CQ_LEDGER_PG_URL are both absent", () => {
    expect(resolveHubDsn(undefined, { DATABASE_URL: "postgres://from-database-url" })).toBe(
      "postgres://from-database-url",
    );
  });

  it("throws an actionable HubDsnResolutionError when nothing resolves", () => {
    expect(() => resolveHubDsn(undefined, {})).toThrow(HubDsnResolutionError);
    try {
      resolveHubDsn(undefined, {});
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(HubDsnResolutionError);
      expect((err as Error).message).toContain("--pg-url");
      expect((err as Error).message).toContain("CQ_LEDGER_PG_URL");
      expect((err as Error).message).toContain("DATABASE_URL");
    }
  });

  it("treats blank strings as absent", () => {
    expect(() => resolveHubDsn("  ", { CQ_LEDGER_PG_URL: "  ", DATABASE_URL: "" })).toThrow(
      HubDsnResolutionError,
    );
  });
});

describe("resolveHubToken", () => {
  it("prefers the --token flag over CQ_SERVE_TOKEN", () => {
    expect(resolveHubToken("from-flag", { CQ_SERVE_TOKEN: "from-env" })).toBe("from-flag");
  });

  it("falls back to CQ_SERVE_TOKEN when no flag is given", () => {
    expect(resolveHubToken(null, { CQ_SERVE_TOKEN: "from-env" })).toBe("from-env");
  });

  it("returns null when neither is set", () => {
    expect(resolveHubToken(null, {})).toBeNull();
  });

  it("treats blank values as unset in both positions", () => {
    expect(resolveHubToken("  ", { CQ_SERVE_TOKEN: "from-env" })).toBe("from-env");
    expect(resolveHubToken("  ", { CQ_SERVE_TOKEN: "  " })).toBeNull();
    expect(resolveHubToken(null, { CQ_SERVE_TOKEN: "" })).toBeNull();
  });
});

describe("isLoopbackHost (Q273)", () => {
  it("treats 127.0.0.0/8, ::1, and localhost as loopback", () => {
    for (const h of ["127.0.0.1", "127.0.0.53", "127.255.255.255", "localhost", "::1"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it("treats 0.0.0.0, ::, LAN IPs, and hostnames as non-loopback", () => {
    for (const h of ["0.0.0.0", "::", "10.0.0.5", "192.168.1.1", "example.com", "128.0.0.1"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("assertTokenIfNonLoopback (Q273)", () => {
  it("does not require --token for a loopback --host, with or without one", () => {
    expect(() => assertTokenIfNonLoopback("127.0.0.1", null)).not.toThrow();
    expect(() => assertTokenIfNonLoopback("localhost", null)).not.toThrow();
    expect(() => assertTokenIfNonLoopback("::1", null)).not.toThrow();
    expect(() => assertTokenIfNonLoopback("127.0.0.1", "secret")).not.toThrow();
  });

  it("requires --token for a non-loopback --host, naming the flag in the error", () => {
    expect(() => assertTokenIfNonLoopback("0.0.0.0", null)).toThrow(HubTokenRequiredError);
    expect(() => assertTokenIfNonLoopback("0.0.0.0", null)).toThrow(/--token/);
    expect(() => assertTokenIfNonLoopback("10.0.0.5", null)).toThrow(/--token/);
  });

  it("is satisfied by a non-loopback --host once --token is given", () => {
    expect(() => assertTokenIfNonLoopback("0.0.0.0", "secret")).not.toThrow();
  });
});

const here = new URL(".", import.meta.url).pathname;
const hubMain = path.resolve(here, "..", "src", "hubServe.ts");
const CQ_SERVE_OWNER_LOCK_KEY = 847_501_002;
const SCHEMA_DDL_LOCK_KEY = 847_501_001;

/** Spawn hubServe.ts with `env` overrides; resolves once the process exits. */
async function runHub(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = bunSpawn({
    cmd: [process.execPath, "run", hubMain, ...args],
    env: {
      ...process.env,
      // Prompt-agnostic tests must not inherit an ambient prompt root; tests
      // that exercise prompt selection set the variables explicitly below.
      CQ_PROMPT_ROOT: undefined,
      CQ_PROMPT_SURFACE: undefined,
      CQ_PROMPT_SURFACES_ROOT: undefined,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("cq serve — missing DSN fails fast (no live Postgres needed)", () => {
  it("exits non-zero with an actionable message when no DSN resolves", async () => {
    const { exitCode, stderr, stdout } = await runHub(["--port", "0"], {
      CQ_LEDGER_PG_URL: undefined,
      DATABASE_URL: undefined,
    });
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("--pg-url");
    expect(stderr).toContain("CQ_LEDGER_PG_URL");
  });

  it("rejects an unresolved prompt selector before DSN resolution or serving", async () => {
    const { exitCode, stderr, stdout } = await runHub(["--port", "0"], {
      CQ_PROMPT_SURFACE: "codex",
      CQ_PROMPT_ROOT: undefined,
      CQ_PROMPT_SURFACES_ROOT: undefined,
      CQ_LEDGER_PG_URL: undefined,
      DATABASE_URL: undefined,
    });
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("does not resolve a prompt artifact root");
    expect(stderr).not.toContain("CQ_LEDGER_PG_URL");
  });
});

describe("cq serve — non-loopback bind requires --token (Q273, no live Postgres needed)", () => {
  it("exits non-zero naming --token, BEFORE the DSN check, when --host is non-loopback and --token is absent", async () => {
    const { exitCode, stdout, stderr } = await runHub(["--host", "0.0.0.0", "--port", "0"], {
      CQ_LEDGER_PG_URL: undefined,
      DATABASE_URL: undefined,
    });
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("--token");
    // The token gate runs before DSN resolution, so the DSN error never fires.
    expect(stderr).not.toContain("CQ_LEDGER_PG_URL");
  });
});

describe("cq serve — CQ_SERVE_TOKEN satisfies the non-loopback gate (no live Postgres needed)", () => {
  it("passes the --token gate via CQ_SERVE_TOKEN, then reaches (and fails) DSN resolution", async () => {
    const { exitCode, stdout, stderr } = await runHub(["--host", "0.0.0.0", "--port", "0"], {
      CQ_SERVE_TOKEN: "env-secret",
      CQ_LEDGER_PG_URL: undefined,
      DATABASE_URL: undefined,
    });
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    // The env token satisfied Q273, so the token error never fires and the
    // process advances to DSN resolution (which fails here — no DSN set).
    expect(stderr).not.toContain("is not loopback");
    expect(stderr).toContain("CQ_LEDGER_PG_URL");
  });
});

describe.skipIf(!process.env["CQ_TEST_PG_URL"])("cq serve — live boot (T586)", () => {
  const PG_URL = process.env["CQ_TEST_PG_URL"];
  let outdir: string;
  let tag: string;
  let projectKey: string;
  let displayName: string;
  let promptRoot: string;
  const PROMPT_BYTES = "hub claude {{cq:literal}} and $ARGUMENTS\n";

  beforeAll(async () => {
    outdir = await fs.mkdtemp(path.join(os.tmpdir(), "cq-serve-out-"));
    tag = `t586-${randomUUID()}`;
    projectKey = `${tag}-proj`;
    displayName = `T586 Hub Test ${tag}`;
    promptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cq-serve-prompts-"));
    await fs.mkdir(path.join(promptRoot, "roles"));
    const catalogJson = JSON.stringify([
      {
        roleId: "plan-advance",
        roleKind: "dispatched-subagent",
        sidecar: { schemaRoleId: "plan-advance" },
      },
    ]);
    await fs.writeFile(path.join(promptRoot, "catalog.json"), catalogJson);
    const surfaceCore = {
      surface: "claude",
      catalogMetadataHash: createHash("sha256").update(catalogJson, "utf8").digest("hex"),
      roles: [
        {
          roleId: "plan-advance",
          version: 1,
          sha256: createHash("sha256").update(PROMPT_BYTES, "utf8").digest("hex"),
        },
      ],
    };
    await fs.writeFile(
      path.join(promptRoot, "surface.json"),
      JSON.stringify({
        ...surfaceCore,
        surfaceDigest: createHash("sha256")
          .update(JSON.stringify(surfaceCore), "utf8")
          .digest("hex"),
      }),
    );
    await fs.writeFile(path.join(promptRoot, "roles", "plan-advance.md"), PROMPT_BYTES);
    // Register a tenant directly (mirrors postgres-list-projects.test.ts) so
    // GET /api/projects has something of ours to find.
    const pool = openPgPool(PG_URL!);
    await ensureSchema(pool);
    const store = new PostgresLedgerStore({ pool, projectKey, displayName });
    await store.init();
    await store.dispose();
  });

  afterAll(async () => {
    await fs.rm(outdir, { recursive: true, force: true });
    await fs.rm(promptRoot, { recursive: true, force: true });
  });

  it("boots with --pg-url --port 0, no repo cwd; serves the bundle + the projects listing", async () => {
    const proc = bunSpawn({
      cmd: [process.execPath, "run", hubMain, "--pg-url", PG_URL!, "--host", "127.0.0.1", "--port", "0"],
      cwd: os.tmpdir(), // NO repo cwd / cq.toml anywhere near this dir
      env: {
        ...process.env,
        LEDGER_WEB_OUTDIR: outdir,
        CQ_PROMPT_SURFACE: "claude",
        CQ_PROMPT_ROOT: promptRoot,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("hubServe did not emit a URL within 20s")), 20_000),
      );
      const urlLine = await Promise.race([
        (async (): Promise<string> => {
          while (!buf.includes("\n")) {
            const { done, value } = await reader.read();
            if (done) throw new Error("stdout closed without a URL line");
            buf += decoder.decode(value, { stream: true });
          }
          return buf.slice(0, buf.indexOf("\n")).trim();
        })(),
        timeout,
      ]);
      const match = urlLine.match(/^http:\/\/127\.0\.0\.1:(\d+)\/$/);
      expect(match).not.toBeNull();
      const port = Number(match![1]);

      const rootResp = await fetch(`http://127.0.0.1:${port}/`);
      expect(rootResp.status).toBe(200);
      const rootBody = await rootResp.text();
      expect(rootBody).toContain('<div id="root">');

      const projResp = await fetch(`http://127.0.0.1:${port}/api/projects`);
      expect(projResp.status).toBe(200);
      const projJson = (await projResp.json()) as { projects: Array<{ key: string; displayName: string }> };
      const found = projJson.projects.find((p) => p.key === projectKey);
      expect(found).toBeDefined();
      expect(found!.displayName).toBe(displayName);

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${String(port)}/p/${encodeURIComponent(projectKey)}/mcp`),
      );
      const client = new Client({ name: "hub-prompt-test", version: "0.0.1" }, {
        capabilities: {},
      });
      await client.connect(transport as unknown as Transport);
      try {
        const promptResult = await client.callTool({
          name: "fetch_prompt",
          arguments: { roleId: "plan-advance" },
        });
        const prompt = JSON.parse(
          (promptResult.content as Array<{ text: string }>)[0]!.text,
        ) as { promptTemplate: string };
        expect(prompt.promptTemplate).toBe(PROMPT_BYTES);
      } finally {
        await client.close();
      }
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});

describe.skipIf(!process.env["CQ_TEST_PG_URL"])(
  "cq serve — single PostgreSQL owner (T724, Good-Communication)",
  () => {
    const PG_URL = process.env["CQ_TEST_PG_URL"];
    let outdir: string;
    const children: Array<{ kill(): void; exited: Promise<number> }> = [];
    let control: ReturnType<typeof openPgPool> | null = null;

    beforeAll(async () => {
      outdir = await fs.mkdtemp(path.join(os.tmpdir(), "cq-serve-owner-out-"));
    });

    afterAll(async () => {
      await fs.rm(outdir, { recursive: true, force: true });
    });

    afterEach(async () => {
      for (const child of children) {
        child.kill();
        await child.exited;
      }
      children.length = 0;
      if (control !== null) {
        await control.close();
        control = null;
      }
    });

    it("rejects a second owner before schema/bind, transfers ownership, and fail-stops on session loss", async () => {
      const ownerA = bunSpawn({
        cmd: [
          process.execPath,
          "run",
          hubMain,
          "--pg-url",
          PG_URL!,
          "--host",
          "127.0.0.1",
          "--port",
          "0",
        ],
        env: { ...process.env, LEDGER_WEB_OUTDIR: outdir },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(ownerA);
      const ownerAStderr = new Response(ownerA.stderr).text();
      const ownerAReader = ownerA.stdout.getReader();
      const readUrl = async (
        reader: ReadableStreamDefaultReader<Uint8Array>,
      ): Promise<string> => {
        const decoder = new TextDecoder();
        let buf = "";
        while (!buf.includes("\n")) {
          const { done, value } = await reader.read();
          if (done) throw new Error("cq serve stdout closed without a URL");
          buf += decoder.decode(value, { stream: true });
        }
        return buf.slice(0, buf.indexOf("\n")).trim();
      };
      const ownerAUrl = await Promise.race([
        readUrl(ownerAReader),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("owner A did not bind within 20s")), 20_000),
        ),
      ]);
      const ownerAPort = new URL(ownerAUrl).port;

      const controlPool = openPgPool(PG_URL!);
      control = controlPool;
      const schemaLock = await controlPool.reserve();
      try {
        await schemaLock`SELECT pg_advisory_lock(${SCHEMA_DDL_LOCK_KEY}::bigint)`;
        const beforeProjects = await controlPool<Array<{ count: string }>>`
          SELECT count(*)::text AS count FROM projects
        `;
        const ownerBContended = bunSpawn({
          cmd: [
            process.execPath,
            "run",
            hubMain,
            "--pg-url",
            PG_URL!,
            "--host",
            "127.0.0.1",
            "--port",
            ownerAPort,
          ],
          env: { ...process.env, LEDGER_WEB_OUTDIR: outdir },
          stdout: "pipe",
          stderr: "pipe",
        });
        children.push(ownerBContended);
        const contendedExit = await Promise.race([
          ownerBContended.exited.then((exitCode) => ({ timedOut: false, exitCode })),
          new Promise<{ timedOut: true; exitCode: null }>((resolve) =>
            setTimeout(() => resolve({ timedOut: true, exitCode: null }), 5_000),
          ),
        ]);
        if (contendedExit.timedOut) ownerBContended.kill();
        const [contendedStdout, contendedStderr] = await Promise.all([
          new Response(ownerBContended.stdout).text(),
          new Response(ownerBContended.stderr).text(),
          ownerBContended.exited,
        ]);
        expect(contendedExit.timedOut).toBe(false);
        expect(contendedExit.exitCode).not.toBe(0);
        expect(contendedStdout).toBe("");
        expect(contendedStderr).toContain("already has an active cq serve owner");
        const afterProjects = await controlPool<Array<{ count: string }>>`
          SELECT count(*)::text AS count FROM projects
        `;
        expect(afterProjects).toEqual(beforeProjects);
      } finally {
        await schemaLock`SELECT pg_advisory_unlock(${SCHEMA_DDL_LOCK_KEY}::bigint)`;
        schemaLock.release();
      }

      ownerA.kill();
      expect(await ownerA.exited).toBe(0);
      await ownerAReader.cancel();
      await ownerAStderr;

      const ownerB = bunSpawn({
        cmd: [
          process.execPath,
          "run",
          hubMain,
          "--pg-url",
          PG_URL!,
          "--host",
          "127.0.0.1",
          "--port",
          "0",
        ],
        env: { ...process.env, LEDGER_WEB_OUTDIR: outdir },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(ownerB);
      const ownerBStderr = new Response(ownerB.stderr).text();
      const ownerBReader = ownerB.stdout.getReader();
      const ownerBUrl = await Promise.race([
        readUrl(ownerBReader),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("owner B did not bind after owner A stopped")), 20_000),
        ),
      ]);
      expect((await fetch(ownerBUrl)).status).toBe(200);

      const terminated = await controlPool<Array<{ terminated: boolean }>>`
        SELECT pg_terminate_backend(pid) AS terminated
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid = 0
          AND objid = ${CQ_SERVE_OWNER_LOCK_KEY}
          AND granted
      `;
      expect(terminated).toEqual([{ terminated: true }]);
      const ownerBExit = await Promise.race([
        ownerB.exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("owner B kept serving after ownership-session loss")), 10_000),
        ),
      ]);
      expect(ownerBExit).not.toBe(0);
      expect(await ownerBStderr).toContain("ownership connection was lost");
      await ownerBReader.cancel();
      await expect(fetch(ownerBUrl)).rejects.toThrow();
    }, 60_000);
  },
);
