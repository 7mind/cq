/**
 * history-title-resume.spec.ts — resume-rework e2e (PR-01/PR-03/PR-05).
 *
 * Scenario:
 *   1. Open the page; wait for ALIVE.
 *   2. Send a message; wait for the assistant reply and the title-generator
 *      log line. The mock returns "Mock generated title" for any
 *      non-streaming /v1/messages, so the bridge's Haiku call lands in the
 *      mock and the session.title is persisted.
 *   3. Click "New session" to end the active session and start a fresh one.
 *      The prior session's runLoop finally block fires `sessions.update({
 *      endedAt, endedReason })`, so the row now satisfies the Resume-column
 *      predicate (finished + non-active).
 *   4. Switch to the History tab; confirm the prior row shows the
 *      generated title.
 *   5. Click the row's Resume button. Assert: (a) the app switches back to
 *      the Chat tab, (b) the user bubble from step 2 is still in the stream
 *      (resume reused the same chatSessionId — a brand new session would
 *      have cleared the stream).
 */

import { test, expect } from "../fixtures/base.ts";
import { makeTextSSEEvents } from "../fixtures/adminMock.ts";

test("history-title-resume: Haiku title appears on History tab; Resume reuses session", async ({ cq, mock, page }) => {
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  const replyText = "session-titled reply unique-xyz";
  // Use a unique-per-test user text so the mock's derived title is unique
  // (shared in-memory DB across tests means earlier titles persist).
  const userText = `resume-rework spec marker ${Date.now()}`;
  // Expected title shape: "mock title: <userText, truncated to 40 chars>".
  const expectedTitle = `mock title: ${userText.slice(0, 40)}`;
  await mock.script(makeTextSSEEvents(replyText));
  await cq.sendMessage(userText);
  await cq.waitForTextInStream(replyText, 25_000);
  await expect(cq.textarea).toBeEnabled({ timeout: 25_000 });

  // Give the bridge's async title generator a moment to land in persistence.
  await page.waitForTimeout(300);

  // End the active session so the row becomes "finished" (endedAt set).
  // Clicking New session preempts the active session via the bridge's
  // interrupt+shutdown path; the runLoop finally fires sessions.update.
  const newSessionBtn = page.locator("button[data-testid='new-session-btn']");
  await newSessionBtn.click();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });
  await page.waitForTimeout(300);

  // Switch to the History tab.
  const historyTab = page.locator("[role='tab']", { hasText: "History" });
  await historyTab.click();

  // Find the row that carries our unique title.
  const myRow = page.locator("table tbody tr", { hasText: expectedTitle });
  await expect(myRow).toBeVisible({ timeout: 15_000 });

  // Click the Resume button inside that row.
  const resumeBtn = myRow.locator("button[data-testid^='resume-row-']");
  await expect(resumeBtn).toBeVisible({ timeout: 5_000 });
  await resumeBtn.click();

  // App switches to Chat; the prior user bubble is still present
  // (resume reused the same chatSessionId; brand-new would have cleared).
  const chatTab = page.locator("[role='tab']", { hasText: "Chat" });
  await expect(chatTab).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

  const userBubble = page.locator("[data-role='user']", { hasText: userText });
  await expect(userBubble).toBeVisible({ timeout: 10_000 });
});
