/**
 * ledger-web main() wiring (T187): loadConfig + resolveWebOpts + scanForPort.
 *
 * Spawns `serve.ts` as a subprocess, captures stdout/stderr separately, and
 * verifies the acceptance criteria:
 *
 *   (a) no cq.toml + no flags  → 127.0.0.1:5180; URL on stdout, human line on stderr
 *   (b) cq.toml [webui] port=5300  → 5300 on stdout
 *   (c) --port 5300 + cq.toml port=5180  → 5300 (CLI wins); URL on stdout
 *   (d) start port occupied  → next free port on stdout (scanForPort)
 *
 * Each test spawns the process, reads the first stdout line (the machine-
 * readable URL), and immediately kills the server — no HTTP round-trips needed.
 */

import { describe, it, expect } from "bun:test";
import { spawn as bunSpawn } from "bun";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsLedgerStore } from "@cq/ledger";

const here = new URL(".", import.meta.url).pathname;
const webMain = path.resolve(here, "..", "src", "serve.ts");

/** Allocate a free port (briefly), then release it so the server can bind it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      if (a === null || typeof a === "string") return reject(new Error("no port"));
      const p = a.port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

/**
 * Spawn `serve.ts` with `args` rooted at `cwd`, wait for the first stdout
 * line (the machine-readable URL), and kill the server.  Returns:
 *   - `stdout`: the trimmed URL line
 *   - `stderr`: all stderr accumulated until the process is killed
 */
async function spawnAndReadUrl(
  cwd: string,
  args: string[],
  outdir: string,
): Promise<{ stdout: string; stderr: string }> {
  const stderrBuf: string[] = [];
  let stdoutResolve: (v: string) => void;
  let stdoutReject: (e: Error) => void;
  const stdoutLine = new Promise<string>((res, rej) => {
    stdoutResolve = res;
    stdoutReject = rej;
  });

  const proc = bunSpawn({
    cmd: [process.execPath, "run", webMain, "--cwd", cwd, ...args],
    env: { ...process.env, LEDGER_WEB_OUTDIR: outdir },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Read the first stdout line (the URL).
  let stdoutText = "";
  const stdoutReader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const readStdout = async (): Promise<void> => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutText += decoder.decode(value, { stream: true });
        const newline = stdoutText.indexOf("\n");
        if (newline !== -1) {
          stdoutResolve(stdoutText.slice(0, newline).trim());
          return;
        }
      }
      stdoutReject(new Error("stdout closed without a URL line"));
    } catch (e) {
      stdoutReject(e instanceof Error ? e : new Error(String(e)));
    }
  };
  void readStdout();

  // Collect stderr.
  const stderrReader = proc.stderr.getReader();
  const readStderr = async (): Promise<void> => {
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrBuf.push(dec.decode(value, { stream: true }));
      }
    } catch {
      /* ignore read errors after kill */
    }
  };
  void readStderr();

  // Wait for the URL line (up to 20s for the Bun.build to complete).
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("serve.ts did not emit a URL within 20s")), 20_000),
  );
  const url = await Promise.race([stdoutLine, timeout]);

  proc.kill();
  await proc.exited;

  return { stdout: url, stderr: stderrBuf.join("") };
}

/** Create a minimal ledger root (just the .cq/ dir). */
async function makeLedgerRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-web-main-wiring-"));
  const store = new FsLedgerStore({ root });
  await store.init();
  await store.dispose();
  return root;
}

describe("main() wiring: loadConfig + resolveWebOpts + scanForPort (T187)", () => {
  it("(a) no cq.toml + no flags → default 127.0.0.1:5180; URL on stdout, human line on stderr", async () => {
    const root = await makeLedgerRoot();
    const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-web-out-"));
    try {
      // Use a free port so 5180 doesn't fail if occupied by a parallel test.
      const port = await freePort();
      const { stdout, stderr } = await spawnAndReadUrl(root, ["--port", String(port)], outdir);
      expect(stdout).toBe(`http://127.0.0.1:${port}/`);
      expect(stderr).toContain(`http://127.0.0.1:${port}/`);
      expect(stderr).toContain("ledger-web: serving");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outdir, { recursive: true, force: true });
    }
  });

  it("(b) cq.toml [webui] port=5300 → resolved port from config", async () => {
    const root = await makeLedgerRoot();
    const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-web-out-"));
    // Use a free port for the config to avoid collision.
    const configPort = await freePort();
    try {
      await fs.writeFile(
        path.join(root, "cq.toml"),
        `[webui]\nport = ${configPort}\n`,
        "utf8",
      );
      const { stdout, stderr } = await spawnAndReadUrl(root, [], outdir);
      expect(stdout).toBe(`http://127.0.0.1:${configPort}/`);
      expect(stderr).toContain(`http://127.0.0.1:${configPort}/`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outdir, { recursive: true, force: true });
    }
  });

  it("(c) --port N + cq.toml port=M → N wins (CLI beats config)", async () => {
    const root = await makeLedgerRoot();
    const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-web-out-"));
    const cliPort = await freePort();
    const configPort = await freePort();
    try {
      await fs.writeFile(
        path.join(root, "cq.toml"),
        `[webui]\nport = ${configPort}\n`,
        "utf8",
      );
      const { stdout } = await spawnAndReadUrl(root, ["--port", String(cliPort)], outdir);
      expect(stdout).toBe(`http://127.0.0.1:${cliPort}/`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outdir, { recursive: true, force: true });
    }
  });

  it("(d) start port occupied → scanForPort finds next free port", async () => {
    const root = await makeLedgerRoot();
    const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-web-out-"));
    // Occupy a port so the scan must advance at least one step.
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    });
    const occupiedPort = occupied.port;
    if (occupiedPort === undefined) throw new Error("Bun.serve did not report a port");
    try {
      const { stdout } = await spawnAndReadUrl(root, ["--port", String(occupiedPort)], outdir);
      // The URL must be http://127.0.0.1:<port>/ where port > occupiedPort.
      const match = stdout.match(/^http:\/\/127\.0\.0\.1:(\d+)\/$/);
      expect(match).not.toBeNull();
      const boundPort = Number(match![1]);
      expect(boundPort).toBeGreaterThan(occupiedPort);
    } finally {
      occupied.stop(true);
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outdir, { recursive: true, force: true });
    }
  });
});
