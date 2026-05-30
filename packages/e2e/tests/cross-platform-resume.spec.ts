/**
 * cross-platform-resume.spec.ts — e2e-2: cross-platform Resume guard.
 *
 * Scenario:
 *   1. Open the page; run a short Claude turn to seed a persisted main
 *      invocation row.
 *   2. Open the SettingsPopup and switch the model to a Codex id
 *      (gpt-5.5). localStorage updates synchronously.
 *   3. Navigate to the History tab; the Claude row's Resume button must
 *      now be hidden because the row's platform != currentPlatform.
 *   4. Programmatically open a second WebSocket from the page and send
 *      a malformed chat.start that asks to resume the Claude invocation
 *      with platform='codex'. Assert the server responds with
 *      chat.error{code:'platform-mismatch'} on that WS.
 */

import { test, expect } from "../fixtures/base.ts";
import { makeTextSSEEvents } from "../fixtures/adminMock.ts";

test("cross-platform-resume: Resume hidden across platforms + server refuses with platform-mismatch", async ({ cq, mock, page }) => {
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  // ----- 1. seed a Claude session row -----
  const seedReply = "cross-platform-seed";
  await mock.script(makeTextSSEEvents(seedReply));
  // Unique-per-run user text so the row title is identifiable across the
  // shared in-memory DB.
  const seedUserText = `cross-platform seed ${Date.now()}`;
  await cq.sendMessage(seedUserText);
  await cq.waitForTextInStream(seedReply, 25_000);
  await expect(cq.textarea).toBeEnabled({ timeout: 25_000 });

  // End the active session so its row appears as "finished" in History
  // (endedAt != null is the predicate the Resume button checks).
  await page.locator("button[data-testid='new-session-btn']").click();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });
  await page.waitForTimeout(300);

  // Capture the invocation id of the now-finished seed row by going to
  // the History tab and matching the unique title.
  await cq.goToHistory();
  // Find the seed row by its unique user text (echoed into the Haiku title
  // via the mock's "mock title: <prompt>" fixture).
  const expectedTitle = `mock title: ${seedUserText.slice(0, 40)}`;
  const seedRow = page.locator("table tbody tr", { hasText: expectedTitle });
  await expect(seedRow).toBeVisible({ timeout: 15_000 });
  const rowTestId = await seedRow.getAttribute("data-testid");
  expect(rowTestId).toMatch(/^history-row-/);
  const invocationId = rowTestId!.replace("history-row-", "");

  // Initially the Claude row's Resume button is visible (current model
  // defaults to claude-opus-4-7[1m] from localStorage). Confirm before
  // switching platform.
  await expect(
    page.locator(`[data-testid='resume-row-${invocationId}']`),
  ).toBeVisible({ timeout: 3_000 });

  // ----- 2. switch to a Codex model via the gear popup -----
  await cq.goToChat();
  await page.locator("[data-testid='settings-gear-btn']").click();
  await expect(page.locator("[data-testid='settings-popup']")).toBeVisible();
  await page.locator("[data-testid='model-select']").selectOption("gpt-5.5");
  // Close the popup (Esc) and go back to history.
  await page.keyboard.press("Escape");
  await cq.goToHistory();

  // ----- 3. assert the Resume button on the Claude row is now hidden -----
  await expect(
    page.locator(`[data-testid='resume-row-${invocationId}']`),
  ).toHaveCount(0, { timeout: 3_000 });

  // ----- 4. programmatic WS: send malformed resume; expect refusal -----
  const refusal = await page.evaluate<{ code: string; message: string } | null, string>(
    async (invId) => {
      const wsUrl = location.origin.replace(/^http/, "ws") + "/ws";
      const ws = new WebSocket(wsUrl);
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          try { ws.close(); } catch { /* ignore */ }
          resolve(null);
        }, 10_000);
        ws.onopen = () => {
          const frame = {
            type: "chat.start",
            seq: 1,
            ts: Date.now(),
            model: "gpt-5.5",
            platform: "codex",
            resumeFromInvocationId: invId,
          };
          ws.send(JSON.stringify(frame));
        };
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(ev.data as string) as { type?: string; code?: string; message?: string };
            if (parsed.type === "chat.error" && typeof parsed.code === "string" && parsed.code === "platform-mismatch") {
              clearTimeout(timeout);
              try { ws.close(); } catch { /* ignore */ }
              resolve({ code: parsed.code, message: parsed.message ?? "" });
            }
          } catch {
            // ignore non-JSON / unrelated frames
          }
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          resolve(null);
        };
      });
    },
    invocationId,
  );

  expect(refusal).not.toBeNull();
  expect(refusal!.code).toBe("platform-mismatch");
  expect(refusal!.message.length).toBeGreaterThan(0);

  // Cleanup: the shared cq-server persists `ui_settings.model`. If we leave
  // it set to a Codex model, subsequent tests will inherit it and their
  // auto-start chat.start{platform:'codex'} will fail with
  // codex-not-authenticated. Restore a Claude model before the test ends.
  await cq.goToChat();
  await page.locator("[data-testid='settings-gear-btn']").click();
  await expect(page.locator("[data-testid='settings-popup']")).toBeVisible();
  await page.locator("[data-testid='model-select']").selectOption("claude-opus-4-7[1m]");
  await page.keyboard.press("Escape");
  // Give the settings.set frame a moment to land.
  await page.waitForTimeout(300);
});
