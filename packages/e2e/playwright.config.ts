/**
 * playwright.config.ts — Playwright test runner configuration.
 *
 * Key points:
 * - Uses globalSetup/Teardown to boot mock server + cq server as child
 *   Bun processes. Both URLs are communicated via env vars.
 * - baseURL comes from CQ_BASE_URL (set by globalSetup).
 * - Browser: Chromium only. Headed mode via --headed flag or HEADED=1 env.
 * - Browser binary: uses PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH if set (populated
 *   by the Nix devShell from playwright-driver.browsers), otherwise falls back
 *   to the default browser discovery.
 * - PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 prevents npm-level browser downloads.
 * - Each test should run in < 15 s; total suite < 3 min.
 */

import { defineConfig, devices } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Allow override of chromium binary for Nix / CI environments.
// Falls back to probing known Nix store playwright-browsers paths when the env
// var is not set (e.g. running outside the Nix devShell).
function resolveChromiumExecutablePath(): string | undefined {
  const envPath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"];
  if (envPath) return envPath;

  // Probe known Nix store playwright-browsers locations. The hash prefix
  // changes with each nixpkgs update, so we scan /nix/store for entries
  // that match the playwright-browsers naming convention.
  const nixStore = "/nix/store";
  if (!fs.existsSync(nixStore)) return undefined;
  try {
    for (const entry of fs.readdirSync(nixStore)) {
      if (!entry.endsWith("-playwright-browsers")) continue;
      const chromiumDir = path.join(nixStore, entry);
      for (const sub of fs.readdirSync(chromiumDir)) {
        if (!sub.startsWith("chromium-")) continue;
        const candidate = path.join(chromiumDir, sub, "chrome-linux64", "chrome");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // Ignore read errors — Nix store may not be accessible.
  }
  return undefined;
}

const chromiumExecutablePath = resolveChromiumExecutablePath();

export default defineConfig({
  testDir: "./tests",
  // Per-test budget. The bottleneck is the real SDK subprocess: startup +
  // first round-trip through MockAnthropicHTTP takes ~15–25 s (matches the
  // unit-test `sdk-stub.test.ts` budget at 25 s). 60 s per test gives headroom
  // for assertion timeouts + teardown.
  timeout: 60_000,
  // Per-assertion budget. Most assertions are fast (<1 s); the slow ones wait
  // for SDK output (chat.event after chat.input) and need ~20 s headroom.
  expect: { timeout: 20_000 },
  fullyParallel: false,    // tests share a single server instance
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,              // serialise tests to avoid mock state races

  globalSetup: path.join(__dirname, "globalSetup.ts"),
  globalTeardown: path.join(__dirname, "globalTeardown.ts"),

  use: {
    baseURL: process.env["CQ_BASE_URL"] ?? "http://127.0.0.1:5173",
    headless: !process.env["HEADED"],
    screenshot: "only-on-failure",
    video: "off",

    // Allow clipboard operations for the markdown copy-button test.
    permissions: ["clipboard-read", "clipboard-write"],

    launchOptions: {
      ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
    },
  },

  // Two ordered projects (WFL-D02). A Codex spec drives a real Codex model that
  // spawns a long-lived `cq-mcp` child (owned by the Codex CLI). Two distinct
  // contention sources flow from that child and outlive the Codex spec for the
  // shared server's lifetime:
  //
  //   1. Cross-process ledger lock race. The cq-mcp child opens its OWN
  //      FsLedgerStore on the shared --cwd and issues ledger writes, holding
  //      cross-process advisory lockfiles. A later `/plan` workflow producer
  //      writes the goals ledger from the cq SERVER process; the two writers
  //      race, and the lockfile fails fast with LedgerBusyError (no wait/retry)
  //      → producer errors → questions_ready banner never appears → timeout.
  //   2. Sustained CPU load. The lingering Codex CLI + cq-mcp child keep
  //      consuming CPU, which tips the timing-sensitive `stop.spec`
  //      (MutationObserver microtask race + a tight 5 s "Stop disabled after
  //      drain" budget; see E2E-D03) into spurious failure.
  //
  // Running the two `/plan` workflow specs AND `stop.spec` FIRST — before any
  // Codex spec exists — removes both: the cq server is the sole ledger writer
  // at producer time, and stop.spec runs against a fresh, unloaded server.
  // `dependencies` + workers:1 guarantees `prelude` finishes before `main`.
  projects: [
    {
      name: "prelude",
      testMatch: /(plan-workflow(-loop)?|stop)\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "main",
      testIgnore: /(plan-workflow(-loop)?|stop)\.spec\.ts$/,
      dependencies: ["prelude"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  reporter: process.env["CI"]
    ? [["dot"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],

  outputDir: path.join(__dirname, "test-results"),
});
