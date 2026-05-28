/**
 * codex-mcp-roundtrip.spec.ts — D-CQMCP-E2E: drive cq-mcp via Codex.
 *
 * Closes the deferred follow-up from outer-9: prove that when a Codex
 * session is started, the cq server passes a per-session
 * `CodexOptions.config.mcp_servers.cq = { command: <cq-mcp>, args:
 * [..., "--cwd", <CQ_E2E_CWD>] }` to the Codex CLI, and the CLI in
 * turn spawns cq-mcp and routes `mcp__cq__*` tool calls to it.
 *
 * The assertion is on-disk effect — the strongest possible signal that
 * cq-mcp is genuinely being spawned and is genuinely executing tool
 * calls inside `${CQ_E2E_CWD}`:
 *
 *   1. Boot the page with `localStorage.cq.model` pre-set to a codex
 *      model id the user's CLI accepts (read from ~/.codex/config.toml).
 *   2. Send a prompt instructing the agent to call mcp__cq__create_ledger
 *      with name='codex-e2e-ledger' and a minimal schema.
 *   3. Wait for the on-disk ledger file to appear (the authoritative
 *      signal); then for the turn to complete.
 *   4. Assert ${CQ_E2E_CWD}/docs/codex-e2e-ledger.md exists with
 *      ledger-shaped frontmatter; assert ${CQ_E2E_CWD}/docs/ledgers.yaml
 *      lists the ledger.
 *
 * Same auth gate as codex-roundtrip.spec.ts: skips when neither real
 * codex login state (~/.codex/auth.json) nor OPENAI_API_KEY is
 * available. The cq server inherits codex auth from globalSetup's
 * `CODEX_HOME=${realHome}/.codex` env var.
 *
 * Timeout: 240 s. The codex CLI is slower than Claude (first invocation
 * pays cold-start cost; the tool-use round-trip adds another model turn
 * after the tool result returns).
 *
 * afterAll cleanup removes the on-disk ledger file and registry entry
 * so repeated runs of the suite stay green. afterEach resets the
 * server-side ui_settings model so the next spec does not inherit the
 * codex routing default.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { test, expect } from "../fixtures/base.ts";
import { hasCodexAuth, pickCodexModel } from "../fixtures/codexAuth.ts";

const LEDGER_NAME = "codex-e2e-ledger";
const CODEX_MODEL = pickCodexModel();
const RESET_MODEL = "claude-opus-4-7[1m]";

test.afterEach(async () => {
  // Reset server-side ui_settings so the next test does not auto-start
  // codex chats with leftover state.
  const cqUrl = process.env["CQ_BASE_URL"] ?? "http://127.0.0.1:5173";
  try {
    await fetch(`${cqUrl}/__e2e/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: RESET_MODEL, permissionMode: null }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch { /* ignore */ }
});

test.afterAll(async () => {
  // Best-effort cleanup so repeated runs stay green. We do this whether
  // the test passed or skipped — if the ledger was never created (skip
  // path) the unlink calls no-op.
  const cqCwd = process.env["CQ_E2E_CWD"];
  if (cqCwd === undefined) return;
  const ledgerMd = path.join(cqCwd, "docs", `${LEDGER_NAME}.md`);
  const registryYaml = path.join(cqCwd, "docs", "ledgers.yaml");
  try {
    await fsp.unlink(ledgerMd);
  } catch { /* not present */ }
  try {
    const txt = await fsp.readFile(registryYaml, "utf8");
    const lines = txt.split("\n");
    const out: string[] = [];
    let skipping = false;
    let skipIndent = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (skipping) {
        const indent = line.length - line.trimStart().length;
        if (line.trim() === "" || indent > skipIndent) continue;
        skipping = false;
      }
      if (line.includes(`name: ${LEDGER_NAME}`)) {
        if (out.length > 0 && out[out.length - 1]!.trim().startsWith("-")) {
          out.pop();
        }
        skipping = true;
        skipIndent = line.length - line.trimStart().length;
        continue;
      }
      out.push(line);
    }
    await fsp.writeFile(registryYaml, out.join("\n"), "utf8");
  } catch { /* registry missing — nothing to clean */ }
});

test("codex-mcp-roundtrip: Codex calls mcp__cq__create_ledger; ledger appears on disk", async ({ cq, page }) => {
  test.skip(
    !hasCodexAuth(),
    "codex login state (~/.codex/auth.json) not present and OPENAI_API_KEY unset",
  );
  test.setTimeout(240_000);

  // Stage server-side ui_settings BEFORE the page boots so the auto-
  // start chat.start path (which is deferred until settings.get_result
  // lands — ChatTab.tsx:516) sees the codex model AND the
  // sandbox/approval combination that lets the codex CLI execute MCP
  // tools without prompting. The codex CLI's default approval policy
  // gates `mcp__cq__*` tool calls; "never" + "codex-danger-full-access"
  // gives the CLI carte-blanche to invoke our cq-mcp tools.
  const cqUrl = process.env["CQ_BASE_URL"] ?? "http://127.0.0.1:5173";
  await fetch(`${cqUrl}/__e2e/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: CODEX_MODEL,
      permissionMode: "codex-danger-full-access",
    }),
    signal: AbortSignal.timeout(3_000),
  });
  // Effort and approvalPolicy are NOT in ui_settings — only model,
  // permissionMode, and hideSdkEvents persist server-side. So
  // localStorage IS authoritative for effort and approvalPolicy. The
  // codex API rejects `reasoning.effort=minimal` (cq's "none" → codex
  // "minimal") combined with the default CLI tools (image_gen,
  // web_search), so we force `cq.effort=low`.
  await page.addInitScript(
    ({ model }) => {
      localStorage.setItem("cq.model", model);
      localStorage.setItem("cq.effort", "low");
      localStorage.setItem("cq.permissionMode", "codex-danger-full-access");
      localStorage.setItem("cq.codex.approvalPolicy", "never");
    },
    { model: CODEX_MODEL },
  );

  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 30_000 });

  // Instruct the agent to call mcp__cq__create_ledger directly. We pin
  // the JSON-encoded arguments in the prompt so the model has minimal
  // room to invent a different shape.
  const ledgerSchemaJson = JSON.stringify({
    statusValues: ["open", "done"],
    terminalStatuses: ["done"],
    fields: {},
  });
  const prompt =
    `Use the mcp__cq__create_ledger tool now. Call it with EXACTLY these arguments:\n` +
    `  name: ${LEDGER_NAME}\n` +
    `  schema: ${ledgerSchemaJson}\n` +
    `Do not ask for confirmation; just call the tool.`;

  await cq.sendMessage(prompt);

  // Wait until the on-disk ledger file appears (the authoritative signal
  // that cq-mcp was actually spawned by Codex and that the tool call
  // executed inside ${CQ_E2E_CWD}).
  const cqCwd = process.env["CQ_E2E_CWD"];
  expect(cqCwd, "CQ_E2E_CWD must be set by globalSetup").toBeTruthy();
  const ledgerMd = path.join(cqCwd!, "docs", `${LEDGER_NAME}.md`);
  const registryYaml = path.join(cqCwd!, "docs", "ledgers.yaml");

  await expect
    .poll(() => fs.existsSync(ledgerMd), {
      timeout: 200_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(true);

  // Wait for the textarea to re-enable so the assertions below run
  // against a stable end state.
  await expect(cq.textarea).toBeEnabled({ timeout: 30_000 });

  const ledgerText = await fsp.readFile(ledgerMd, "utf8");
  expect(ledgerText).toContain(`ledger: ${LEDGER_NAME}`);
  expect(ledgerText).toContain("counters:");

  const registryText = await fsp.readFile(registryYaml, "utf8");
  expect(registryText).toContain(`name: ${LEDGER_NAME}`);
});
