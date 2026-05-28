/**
 * settings-persist-refresh.spec.ts — D41 + D47: UI settings survive page reload.
 *
 * Scenario:
 *   1. Open page, wait for ALIVE + idle.
 *   2. Change the model select to "claude-sonnet-4-6".
 *   3. Toggle "Hide SDK events" on.
 *   4. page.reload().
 *   5. After reload and waitForAlive, assert:
 *        - model select shows "claude-sonnet-4-6"
 *        - "Hide SDK events" checkbox is checked
 *
 * The server persists settings via settings.set frames and restores them via
 * settings.get_result on each ALIVE edge. The Q6 fix defers chat.start until
 * after settings.get_result, ensuring the restored values are applied first.
 */

import { test, expect } from "../fixtures/base.ts";
import { makeTextSSEEvents } from "../fixtures/adminMock.ts";

test("settings-persist-refresh: model and hideSdkEvents survive page reload", async ({ cq, mock, page }) => {
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  // Do a quick round-trip to ensure settingsLoadedRef becomes true before
  // we change settings, so the settings.set frames are actually sent.
  await mock.script(makeTextSSEEvents("settings-warmup"));
  await cq.sendMessage("settings-warmup");
  await cq.waitForTextInStream("settings-warmup", 25_000);
  await expect(cq.textarea).toBeEnabled({ timeout: 25_000 });

  // gear-3: model / hide-sdk-events live in the SettingsPopup. Open it first.
  const gearBtn = page.locator("[data-testid='settings-gear-btn']");
  await gearBtn.click();
  await expect(page.locator("[data-testid='settings-popup']")).toBeVisible();

  // Change the model to "claude-sonnet-4-6".
  const modelSelect = page.locator("[data-testid='model-select']");
  await modelSelect.selectOption("claude-sonnet-4-6");

  // Turn on "Hide SDK events".
  const hideSdkCheckbox = page.locator("[data-testid='hide-sdk-events-toggle']");
  const isCheckedBefore = await hideSdkCheckbox.isChecked();
  if (!isCheckedBefore) {
    await hideSdkCheckbox.check();
  }
  await expect(hideSdkCheckbox).toBeChecked({ timeout: 2_000 });

  // Give the settings.set frame a moment to be sent and persisted.
  await page.waitForTimeout(500);

  // Reload the page.
  await page.reload();
  await cq.waitForAlive(15_000);

  // Wait for settings.get_result to be applied (deferred chat.start uses this).
  // After settings.get_result, chat.start fires — wait for the textarea to become enabled.
  await expect(cq.textarea).toBeEnabled({ timeout: 15_000 });

  // Reopen the popup to inspect the restored values.
  await page.locator("[data-testid='settings-gear-btn']").click();
  await expect(page.locator("[data-testid='settings-popup']")).toBeVisible();

  // Assert: model select shows the saved value.
  await expect(modelSelect).toHaveValue("claude-sonnet-4-6", { timeout: 5_000 });

  // Assert: Hide SDK events is still checked.
  await expect(hideSdkCheckbox).toBeChecked({ timeout: 5_000 });
});
