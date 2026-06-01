/**
 * node-pty scenario driver for the ledger-tui PTY e2e test.
 *
 * Runs under **node** (not bun): node-pty's forkpty is reliable from node's
 * single-threaded runtime, whereas spawning a pty child from bun's
 * multithreaded runtime drops the child's output. The pty CHILD is the bun
 * `ledger-tui` process, so ink still runs under bun in a genuine TTY.
 *
 * Invoked by pty.e2e.test.ts as:
 *   node ptyHarness.mjs --bun <bunPath> --tui <main.tsx> --url <mcpUrl>
 *
 * Drives: connect → `/` search "warp core breach" → open hit → `s` status
 * picker → ↓ → Enter (set "done") → quit. Prints step trace to stderr and a
 * final `RESULT:PASS|FAIL` to stdout; exits 0 on success, 1 otherwise. The
 * caller verifies on-disk persistence separately.
 */

import * as pty from "node-pty";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const bunPath = arg("--bun");
const tuiMain = arg("--tui");
const url = arg("--url");
if (!bunPath || !tuiMain || !url) {
  console.error("usage: ptyHarness.mjs --bun <bun> --tui <main.tsx> --url <url>");
  process.exit(2);
}

const term = pty.spawn(bunPath, ["run", tuiMain, "--mcp-url", url], {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  env: process.env,
});

let buf = "";
term.onData((d) => {
  buf += d;
});

const stripAnsi = (s) =>
  s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][AB0]/g, "");
const frame = () => stripAnsi(buf);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(text, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (frame().includes(text)) return true;
    await sleep(50);
  }
  return false;
}
async function send(s, settleMs = 200) {
  term.write(s);
  await sleep(settleMs);
}

function fail(step) {
  console.error(`FAIL at: ${step}`);
  console.error("--- frame tail ---\n" + frame().slice(-600));
  try {
    term.kill();
  } catch {
    /* ignore */
  }
  console.log("RESULT:FAIL");
  process.exit(1);
}

const steps = [];
try {
  if (!(await waitFor("ops"))) fail("ledger list render");
  steps.push("ledger list");

  await send("/", 300);
  if (!(await waitFor("search:"))) fail("search prompt");
  for (const ch of "warp core breach") await send(ch, 20);
  await send("\r", 400);
  if (!(await waitFor("ops/O1"))) fail("search results");
  steps.push("search hit");

  await send("\r", 400);
  if (!(await waitFor("warp core breach"))) fail("detail view");
  steps.push("detail");

  await send("s", 300);
  if (!(await waitFor("done"))) fail("status picker");
  await send("\x1b[B", 200); // down -> "done"
  await send("\r", 600); // apply
  if (!(await waitFor("O1 → done"))) fail("status applied flash");
  steps.push("status edited");

  await send("\x1b", 150); // back to ledgers
  await send("q", 300); // quit
  console.error("STEPS OK:", steps.join(" -> "));
  console.log("RESULT:PASS");
  try {
    term.kill();
  } catch {
    /* ignore */
  }
  process.exit(0);
} catch (e) {
  console.error("harness error:", e);
  fail("exception");
}
