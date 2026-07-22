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

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn as bunSpawn } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { openPgPool, ensureSchema, PostgresLedgerStore } from "@cq/ledger";
import {
  parseHubArgs,
  resolveHubDsn,
  HubDsnResolutionError,
  HUB_DEFAULT_HOST,
  HUB_DEFAULT_PORT,
  isLoopbackHost,
  assertTokenIfNonLoopback,
  HubTokenRequiredError,
} from "../src/hubServe.js";

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

/** Spawn hubServe.ts with `env` overrides; resolves once the process exits. */
async function runHub(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = bunSpawn({
    cmd: [process.execPath, "run", hubMain, ...args],
    env: { ...process.env, ...env },
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

describe.skipIf(!process.env["CQ_TEST_PG_URL"])("cq serve — live boot (T586)", () => {
  const PG_URL = process.env["CQ_TEST_PG_URL"];
  let outdir: string;
  let tag: string;
  let projectKey: string;
  let displayName: string;

  beforeAll(async () => {
    outdir = await fs.mkdtemp(path.join(os.tmpdir(), "cq-serve-out-"));
    tag = `t586-${randomUUID()}`;
    projectKey = `${tag}-proj`;
    displayName = `T586 Hub Test ${tag}`;
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
  });

  it("boots with --pg-url --port 0, no repo cwd; serves the bundle + the projects listing", async () => {
    const proc = bunSpawn({
      cmd: [process.execPath, "run", hubMain, "--pg-url", PG_URL!, "--host", "127.0.0.1", "--port", "0"],
      cwd: os.tmpdir(), // NO repo cwd / cq.toml anywhere near this dir
      env: { ...process.env, LEDGER_WEB_OUTDIR: outdir },
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
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
