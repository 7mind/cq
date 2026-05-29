import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import net from "node:net";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const MAIN_TS = path.resolve(import.meta.dir, "../src/main.ts");

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("unexpected address type"));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

describe("smoke: server boot, static assets, SIGINT exit", () => {
  let proc: ReturnType<typeof Bun.spawn>;
  let port: number;
  let baseUrl: string;
  let tmpCwd: string;

  beforeAll(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    // Per-test fresh cwd: the server bootstraps ledgers under <cwd>/docs/ on
    // boot. Without an explicit --cwd it would use process.cwd() (the repo
    // root) and either trip the schema-divergence guard against a stale
    // docs/ledgers.yaml or pollute the repo with bootstrap files. (TESTHYG-D01)
    tmpCwd = await mkdtemp(path.join(tmpdir(), "cq-smoke-"));

    proc = Bun.spawn(
      ["bun", "run", MAIN_TS, "--port", String(port), "--host", "127.0.0.1", "--cwd", tmpCwd],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    // Wait for the "cq listening on …" line with a 10s timeout
    const stdout = proc.stdout;
    if (!(stdout instanceof ReadableStream)) {
      proc.kill();
      throw new Error("proc.stdout is not a ReadableStream");
    }
    const decoder = new TextDecoder();
    const reader = stdout.getReader();
    let output = "";
    const deadline = Date.now() + 10_000;

    outer: while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
      if (output.includes(`"cq listening"`)) {
        reader.releaseLock();
        break outer;
      }
    }

    if (!output.includes('"cq listening"')) {
      proc.kill();
      throw new Error(`Server did not start within 10 s. stdout: ${output}`);
    }
  }, 20_000);

  afterAll(async () => {
    // Ensure child is killed even if test fails
    try {
      proc.kill();
    } catch {
      // already dead
    }
    await rm(tmpCwd, { recursive: true, force: true });
  });

  it("GET / returns 200 with <div id=\"root\">", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<div id="root">`);
  });

  it("GET / contains a <script type=\"module\" src=\"...\"> tag", async () => {
    const res = await fetch(`${baseUrl}/`);
    const body = await res.text();
    expect(body).toMatch(/<script type="module" src="[^"]+"/);
  });

  it("the JS bundle referenced in <script src> returns 200 with JS content-type", async () => {
    const res = await fetch(`${baseUrl}/`);
    const body = await res.text();

    const match = body.match(/<script type="module" src="([^"]+)"/);
    expect(match).not.toBeNull();
    const scriptSrc = match![1]!;

    const jsRes = await fetch(`${baseUrl}${scriptSrc}`);
    expect(jsRes.status).toBe(200);
    const ct = jsRes.headers.get("content-type") ?? "";
    expect(ct).toMatch(/javascript/);
  });

  it("server exits 0 on SIGINT within 3 s", async () => {
    proc.kill("SIGINT");
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SIGINT did not exit within 3 s")), 3_000),
      ),
    ]);
    expect(exitCode).toBe(0);
  }, 5_000);
});
