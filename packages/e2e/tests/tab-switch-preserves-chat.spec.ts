/**
 * tab-switch-preserves-chat.spec.ts — D10: switching tabs does not lose chat state.
 *
 * Scenario:
 *   1. Open page, send a message, wait for assistant reply.
 *   2. Click the History tab.
 *   3. Click the Chat tab.
 *   4. Assert: the user bubble + assistant bubble are STILL visible.
 *
 * The chat state is lifted into SessionContext (above the tab switcher) so
 * ChatTab unmount/remount does not destroy it.
 */

import { test, expect } from "../fixtures/base.ts";
import { makeTextSSEEvents } from "../fixtures/adminMock.ts";

test("tab-switch-preserves-chat: switching History→Chat keeps messages visible", async ({ cq, mock }) => {
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  // Script a recognisable reply.
  const replyText = "tab-switch-test-reply-unique-xyz";
  await mock.script(makeTextSSEEvents(replyText));

  const userText = "tab-switch-test-input";
  await cq.sendMessage(userText);

  // Wait for the assistant reply to appear.
  await cq.waitForTextInStream(replyText, 25_000);
  await expect(cq.textarea).toBeEnabled({ timeout: 25_000 });

  // Confirm the user bubble is visible before the tab switch.
  const userBubbles = cq.page.locator("[data-role='user']");
  await expect(userBubbles.first()).toBeVisible({ timeout: 5_000 });

  // Switch to History tab.
  await cq.goToHistory();

  // Switch back to Chat tab.
  await cq.goToChat();

  // User bubble must still be visible.
  await expect(userBubbles.first()).toBeVisible({ timeout: 5_000 });
  await expect(userBubbles.first()).toContainText(userText);

  // Assistant reply must still be in the stream.
  await cq.waitForTextInStream(replyText, 5_000);
});
