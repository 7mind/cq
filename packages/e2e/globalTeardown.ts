/**
 * globalTeardown.ts — Playwright global teardown.
 *
 * Kills the mock server and cq server child processes started in globalSetup.
 */

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";

declare global {
  var __e2e_mock_proc: ChildProcess | undefined;
  var __e2e_cq_proc: ChildProcess | undefined;
  var __e2e_tmp_home: string | undefined;
  var __e2e_tmp_cwd: string | undefined;
}

function kill(proc: ChildProcess | undefined): Promise<void> {
  if (!proc) return Promise.resolve();
  return new Promise<void>((resolve) => {
    proc.on("exit", () => resolve());
    proc.kill("SIGTERM");
    // Force-kill if it doesn't exit within 5 s.
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      resolve();
    }, 5_000);
  });
}

export default async function globalTeardown(): Promise<void> {
  await Promise.all([
    kill(globalThis.__e2e_mock_proc),
    kill(globalThis.__e2e_cq_proc),
  ]);

  // Copy SDK debug logs from hermetic HOME before cleaning up.
  if (globalThis.__e2e_tmp_home) {
    const debugDir = fs.existsSync(`${globalThis.__e2e_tmp_home}/.claude/debug`)
      ? `${globalThis.__e2e_tmp_home}/.claude/debug`
      : null;
    if (debugDir) {
      try {
        const files = fs.readdirSync(debugDir);
        for (const f of files) {
          const content = fs.readFileSync(`${debugDir}/${f}`, "utf-8");
          process.stderr.write(`[sdk-debug:${f}]\n${content}\n`);
        }
      } catch {
        // Non-fatal.
      }
    }
  }

  // Clean up the hermetic HOME created in globalSetup.
  if (globalThis.__e2e_tmp_home) {
    try {
      fs.rmSync(globalThis.__e2e_tmp_home, { recursive: true, force: true });
    } catch {
      // Non-fatal cleanup failure.
    }
  }

  // Clean up the per-run cwd (where docs/ledgers.yaml lives).
  if (globalThis.__e2e_tmp_cwd) {
    try {
      fs.rmSync(globalThis.__e2e_tmp_cwd, { recursive: true, force: true });
    } catch {
      // Non-fatal cleanup failure.
    }
  }
}
