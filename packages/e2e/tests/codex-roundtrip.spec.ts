/**
 * codex-roundtrip.spec.ts — e2e-3: REAL Codex API roundtrip.
 *
 * Skips cleanly when neither codex-login state (~/.codex/auth.json) nor
 * `OPENAI_API_KEY` is available in the sandbox. When auth is present,
 * runs a minimal turn through @openai/codex-sdk and asserts:
 *   - the assistant bubble appears
 *   - the History tab shows the resulting row with platform=codex and
 *     effort populated
 *
 * The codex CLI is gated by the user's auth tier — ChatGPT-account auth
 * rejects most explicit `--model <id>` values. We therefore read the
 * user's `~/.codex/config.toml` to discover an accepted model id and set
 * `localStorage.cq.model` directly (bypassing the popup dropdown, which
 * only offers the cq registry's pre-declared model ids). See
 * `../fixtures/codexAuth.ts` for the picker.
 *
 * Timeout: 120 s per the brief, since the codex CLI is slower than
 * Claude (especially on first invocation).
 *
 * afterEach resets the server-side `ui_settings.model` to a Claude id so
 * subsequent specs in the same cq-server lifecycle do not inherit a
 * Codex routing default they cannot satisfy.
 */

import { test, expect } from "../fixtures/base.ts";
import { hasCodexAuth, pickCodexModel } from "../fixtures/codexAuth.ts";

const CODEX_MODEL = pickCodexModel();
const RESET_MODEL = "claude-opus-4-7[1m]";

test.afterEach(async () => {
  // Reset server-side ui_settings so the next test does not auto-start
  // codex chats with leftover state. The /__e2e/settings admin endpoint
  // (server.ts) writes to ui_settings synchronously. Failures here are
  // non-fatal — at worst the next test runs with stale state and
  // surfaces its own failure.
  const cqUrl = process.env["CQ_BASE_URL"] ?? "http://127.0.0.1:5173";
  try {
    await fetch(`${cqUrl}/__e2e/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: RESET_MODEL, permissionMode: null }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch { /* ignore — best-effort cleanup */ }
});

test("codex-roundtrip: real Codex SDK answers 'say hello' and persists with platform=codex", async ({ cq, page }) => {
  test.skip(
    !hasCodexAuth(),
    "codex login state (~/.codex/auth.json) not present and OPENAI_API_KEY unset",
  );
  test.setTimeout(120_000);

  // Stage the server-side ui_settings BEFORE the page boots. The auto-
  // start chat.start path is deferred until settings.get_result lands
  // (ChatTab.tsx:516), and at that point the server's ui_settings.model
  // OVERRIDES the client's localStorage if non-null. So setting only
  // localStorage is insufficient — we must stage the server-side row.
  const cqUrl = process.env["CQ_BASE_URL"] ?? "http://127.0.0.1:5173";
  await fetch(`${cqUrl}/__e2e/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: CODEX_MODEL }),
    signal: AbortSignal.timeout(3_000),
  });
  // Also seed localStorage so cq.effort flows into the first chat.start
  // (server-side ui_settings does NOT track effort — only model,
  // permissionMode, hideSdkEvents — so localStorage IS authoritative for
  // effort).
  await page.addInitScript(
    ({ model }) => {
      localStorage.setItem("cq.model", model);
      localStorage.setItem("cq.effort", "low");
    },
    { model: CODEX_MODEL },
  );

  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 30_000 });

  // Send a trivial prompt and wait for any assistant text.
  await cq.sendMessage("say hello");

  // We do not pin the assistant's exact wording — wait for any non-empty
  // assistant bubble.
  await page.waitForFunction(
    () => {
      const root = document.querySelector("[data-testid='stream-root']");
      if (root === null) return false;
      // At least one assistant bubble with non-trivial text.
      const bubbles = root.querySelectorAll("[data-testid^='stream-message-']");
      for (const b of bubbles) {
        const t = (b.textContent ?? "").trim();
        if (t.length > 0) return true;
      }
      return false;
    },
    { timeout: 100_000 },
  );

  // Wait for the textarea to be enabled again — the Codex turn has
  // emitted chat.done.
  await expect(cq.textarea).toBeEnabled({ timeout: 30_000 });

  // Switch to History and assert the new row has platform='codex' and
  // a non-empty Effort cell.
  await cq.goToHistory();
  const firstRow = page.locator("[data-testid^='history-row-']").first();
  await expect(firstRow).toBeVisible({ timeout: 5_000 });
  const rowTestId = await firstRow.getAttribute("data-testid");
  const invocationId = rowTestId!.replace("history-row-", "");

  const platformCell = page.locator(`[data-testid='platform-cell-${invocationId}']`);
  await expect(platformCell).toHaveText("codex", { timeout: 3_000 });

  const effortCell = page.locator(`[data-testid='effort-cell-${invocationId}']`);
  await expect(effortCell).toHaveText("low", { timeout: 3_000 });
});
