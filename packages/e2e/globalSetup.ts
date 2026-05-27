/**
 * globalSetup.ts — Playwright global setup.
 *
 * Boots two child processes:
 *   1. The admin-enabled Anthropic HTTP mock (mock-server.ts, via Bun).
 *   2. The cq server (packages/server/src/main.ts, via Bun) with
 *      ANTHROPIC_BASE_URL pointing at the mock.
 *
 * Env vars set for test workers (Playwright inherits globalSetup's process.env):
 *   MOCK_ADMIN_URL   — base URL of the admin mock (e.g. http://127.0.0.1:PORT)
 *   CQ_BASE_URL      — base URL of the cq server (e.g. http://127.0.0.1:PORT)
 *
 * Process handles are stored on globalThis for globalTeardown.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("unexpected address type"));
        return;
      }
      const p = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
    srv.on("error", reject);
  });
}

function findBun(): string {
  return process.env["BUN_BIN"] ?? "bun";
}

/**
 * Poll a URL until it returns any response (2xx or otherwise) or times out.
 */
async function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise<void>((r) => setTimeout(r, 300));
  }

  throw new Error(`Server at ${url} did not respond within ${timeoutMs} ms: ${lastErr}`);
}

// ---------------------------------------------------------------------------
// Global handles
// ---------------------------------------------------------------------------

declare global {
  var __e2e_mock_proc: ChildProcess | undefined;
  var __e2e_cq_proc: ChildProcess | undefined;
  var __e2e_tmp_home: string | undefined;
  var __e2e_tmp_cwd: string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers: build a hermetic HOME for the CQ server subprocess
// ---------------------------------------------------------------------------

/**
 * Create a temporary HOME directory with a minimal ~/.claude/settings.json
 * that has NO hooks configured. The real HOME may contain user hooks (e.g.
 * SessionStart scripts) that intercept the SDK subprocess and interfere with
 * E2E test responses from the mock Anthropic HTTP server.
 *
 * The temp HOME is deleted in globalTeardown.
 */
function createHermeticHome(): string {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cq-e2e-home-"));
  const claudeDir = path.join(tmpHome, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  // Minimal settings: no hooks, bypass confirmation prompts, allow test cwd.
  const settings = {
    hooks: {},
    permissions: { allow: ["Bash(*)", "Edit(*)", "Write(*)", "Read(*)", "WebFetch(*)", "WebSearch(*)"] },
  };
  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf-8",
  );

  // Copy ~/.claude.json from the real HOME if it exists. The SDK subprocess
  // uses this file for OAuth token storage / account identification. Without
  // it, some SDK versions may refuse to start or fail to authenticate even
  // when ANTHROPIC_API_KEY is set in the environment.
  const realClaudeJson = path.join(os.homedir(), ".claude.json");
  if (fs.existsSync(realClaudeJson)) {
    fs.copyFileSync(realClaudeJson, path.join(tmpHome, ".claude.json"));
  }

  return tmpHome;
}

// ---------------------------------------------------------------------------
// globalSetup
// ---------------------------------------------------------------------------

export default async function globalSetup(): Promise<void> {
  const bun = findBun();
  const mockScript = path.join(__dirname, "mock-server.ts");
  const cqScript = path.join(rootDir, "packages/server/src/main.ts");

  // Build a hermetic HOME so the CQ server's SDK subprocess does not inherit
  // any user hooks (SessionStart, Stop, etc.) from the real ~/.claude/settings.json.
  // Those hooks run external commands that may not be available in the test
  // environment and may interfere with mock HTTP responses.
  const hermeticHome = createHermeticHome();
  globalThis.__e2e_tmp_home = hermeticHome;

  // ---- 1. Start the admin mock server ----

  const mockProc = spawn(bun, ["run", mockScript], {
    env: { ...process.env, ANTHROPIC_API_KEY: "sk-e2e-fake" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Read mock port from first stdout line ("MOCK_PORT=<n>").
  const mockPort = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      mockProc.stdout?.off("data", onData);
      const line = buf.slice(0, nl).trim();
      const m = /MOCK_PORT=(\d+)/.exec(line);
      if (!m) { reject(new Error(`Bad mock stdout: ${line}`)); return; }
      resolve(parseInt(m[1]!, 10));
    };
    mockProc.stdout?.on("data", onData);
    mockProc.on("error", reject);
    mockProc.on("exit", (code) => reject(new Error(`mock-server exited early (code ${code})`)));
  });

  const mockUrl = `http://127.0.0.1:${mockPort}`;
  await waitForUrl(`${mockUrl}/__admin/log`);

  // ---- 2. Start the cq server ----

  const cqPort = await getFreePort();
  const cqUrl = `http://127.0.0.1:${cqPort}`;
  const webDist = path.join(rootDir, "packages/web/dist");

  // Build a tmp cwd for the cq server so it writes docs/ledgers.yaml etc.
  // into an isolated directory we can inspect from tests (e.g. the ledger
  // create_ledger E2E spec).
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cq-e2e-cwd-"));
  globalThis.__e2e_tmp_cwd = tmpCwd;

  const cqProc = spawn(
    bun,
    ["run", cqScript, "--", "--port", String(cqPort), "--db", ":memory:", "--cwd", tmpCwd],
    {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: mockUrl,
        ANTHROPIC_API_KEY: "sk-e2e-fake",
        CQ_WEB_OUTDIR: webDist,
        // Enable the /__e2e/interrupt admin endpoint so per-test teardown
        // can reset bridge.active without waiting for the SDK to drain.
        CQ_E2E_HOOKS: "1",
        // Forward SDK subprocess stderr through the cq logger for diagnosis.
        DEBUG: "claude-code-sdk:*",
        CQ_LOG_LEVEL: "debug",
        // Use a hermetic HOME so the SDK subprocess does not read user hooks
        // from ~/.claude/settings.json in the real HOME directory. Those hooks
        // run external scripts that may fail or interfere with mock responses.
        // The hermetic HOME's settings.json has "hooks": {} (empty), so no
        // hooks fire even without CLAUDE_CODE_SIMPLE. This is intentional:
        // CLAUDE_CODE_SIMPLE=1 skips the bidirectional MCP transport setup,
        // which causes the subprocess to hang when sdkMcpServers is non-empty.
        HOME: hermeticHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  cqProc.stderr?.on("data", (chunk: Buffer) => { process.stderr.write(`[cq-server] ${chunk}`); });
  cqProc.stdout?.on("data", (chunk: Buffer) => { process.stdout.write(`[cq-server] ${chunk}`); });
  cqProc.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`[globalSetup] cq server exited unexpectedly (code=${code} signal=${signal})`);
    }
  });

  // cq builds the web bundle on first boot — allow up to 60 s.
  await waitForUrl(cqUrl, 60_000);

  // ---- 3. Expose to test workers ----

  process.env["MOCK_ADMIN_URL"] = mockUrl;
  process.env["CQ_BASE_URL"] = cqUrl;
  process.env["CQ_E2E_CWD"] = tmpCwd;

  globalThis.__e2e_mock_proc = mockProc;
  globalThis.__e2e_cq_proc = cqProc;
}
