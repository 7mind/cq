/**
 * hide-sdk-events.spec.ts — T1: "Hide SDK events" toggle.
 *
 * Scenario:
 *   1. Open the page.
 *   2. Send a message and wait for the assistant response.
 *      The SDK emits a `result:success` message after every turn; the bridge
 *      forwards it as a chat.event; the Stream renders it as an UnknownCard
 *      (a <details> element with <summary>result: success</summary>).
 *   3. Assert that the "result: success" summary is visible in the stream.
 *   4. Click the "Hide SDK events" checkbox.
 *   5. Assert the unknown card is no longer visible.
 *   6. Uncheck the toggle.
 *   7. Assert the unknown card reappears.
 */

import { test, expect } from "../fixtures/base.ts";
import { makeTextSSEEvents } from "../fixtures/adminMock.ts";

test("hide-sdk-events: toggle hides and restores unknown SDK event cards", async ({ cq, mock }) => {
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  // Script a simple reply so the turn completes and the SDK emits result:success.
  const replyText = "hide-sdk-events-reply";
  await mock.script(makeTextSSEEvents(replyText));
  await cq.sendMessage("ping");

  // Wait for the assistant reply to appear (confirms turn is done).
  await cq.waitForTextInStream(replyText, 25_000);
  await expect(cq.textarea).toBeEnabled({ timeout: 25_000 });

  // The SDK emits `result:success` after each turn. The bridge forwards it as
  // a chat.event; Stream renders it as a <details> with summary "result: success".
  const sdkEventCard = cq.page.locator("details").filter({ hasText: "result: success" }).first();
  await expect(sdkEventCard).toBeVisible({ timeout: 5_000 });

  // gear-3: the "Hide SDK events" toggle now lives inside the SettingsPopup.
  // Open the popup via the gear button first, then check the toggle.
  await cq.page.locator("[data-testid='settings-gear-btn']").click();
  await expect(cq.page.locator("[data-testid='settings-popup']")).toBeVisible();
  const toggle = cq.page.locator("[data-testid='hide-sdk-events-toggle']");
  await toggle.check();
  await expect(sdkEventCard).not.toBeVisible({ timeout: 3_000 });

  // Uncheck — the card should reappear.
  await toggle.uncheck();
  await expect(sdkEventCard).toBeVisible({ timeout: 3_000 });
});
