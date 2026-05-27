/**
 * resume-running-rejoin.spec.ts — D48: resuming the currently-running session
 * sends chat.rejoin instead of chat.start, leaving the stream intact.
 *
 * Scenario:
 *   1. Open page, send a message. While the assistant is responding (session
 *      is "running" in history), open the Resume picker via "Resume from history"
 *      and click the row matching the active session.
 *   2. D48: because row.status === "running" AND row.sessionId === activeSessionId,
 *      the picker calls onRejoin() → chat.rejoin is sent → the stream is NOT cleared.
 *   3. Assert: the previously-visible user bubble is still in the stream after rejoin.
 *
 * Timing: The MutationObserver installed before sending the message clicks the
 * "Resume from history" button the instant the first chat.event text appears in
 * the stream (same technique as stop.spec.ts). The session status in history at
 * that point is "running". The observer then finds and clicks the first resume row.
 */

import { test, expect } from "../fixtures/base.ts";
import { makeTextSSEEvents } from "../fixtures/adminMock.ts";

test("resume-running-rejoin: resuming a running session rejoins without clearing chat", async ({ cq, mock, page }) => {
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  // Warm up so the SDK subprocess is initialised.
  await mock.script(makeTextSSEEvents("warmup-rejoin"));
  await cq.sendMessage("warmup-rejoin");
  await cq.waitForTextInStream("warmup-rejoin", 25_000);
  await expect(cq.textarea).toBeEnabled({ timeout: 25_000 });

  // Second turn: script a reply, install an observer to click Resume the instant
  // the first assistant text appears (session is "running" at that point).
  const replyText = "rejoin-reply-unique";
  await mock.script(makeTextSSEEvents(replyText));

  await page.evaluate((text) => {
    (window as unknown as Record<string, boolean>)["__rejoinClicked"] = false;

    const observer = new MutationObserver(() => {
      if ((window as unknown as Record<string, boolean>)["__rejoinClicked"]) return;
      const streamText = (document.querySelector("[data-testid='stream-root']") as Element | null)?.textContent ?? "";
      if (!streamText.includes(text)) return;

      // Click "Resume from history" button.
      const resumeBtn = document.querySelector<HTMLButtonElement>("[data-testid='resume-session-btn']");
      if (!resumeBtn) return;
      resumeBtn.click();
      (window as unknown as Record<string, boolean>)["__rejoinClicked"] = true;
      observer.disconnect();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }, replyText);

  const userText = "resume-running-input";
  await cq.sendMessage(userText);

  // Wait for the Resume picker to appear (observer clicked the button).
  const pickerDialog = page.locator("[data-testid='resume-picker-dialog']");
  await pickerDialog.waitFor({ state: "visible", timeout: 10_000 });

  // Click the first row in the resume picker (the running session).
  const firstRow = page.locator("[data-testid^='resume-row-']").first();
  await firstRow.waitFor({ state: "visible", timeout: 5_000 });
  await firstRow.click();

  // Wait for the turn to complete (textarea re-enables).
  await expect(cq.textarea).toBeEnabled({ timeout: 25_000 });

  // Assert: the user bubble is still visible (stream was not cleared on rejoin).
  const userBubbles = page.locator("[data-role='user']");
  await expect(userBubbles.filter({ hasText: userText })).toBeVisible({ timeout: 5_000 });
});
