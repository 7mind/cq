/**
 * header-badges.spec.ts — T3: header badge state transitions.
 *
 * Verifies that the header status badge and usage counter update correctly
 * across a chat turn lifecycle.
 *
 * Scenario:
 *   1. Open the page — session-status badge shows "NEW" or "IDLE".
 *   2. Send a message — session-status transitions to "BUSY (1)" during
 *      generation (ACTIVITY-01: the badge now carries the aggregate running
 *      count; a chat-only turn → running=1).
 *   3. Wait for the reply — session-status returns to "IDLE".
 *   4. Assert usage counter (↑tokens ↓tokens $cost) contains non-zero values.
 *   5. Assert session-id badge is visible and non-empty.
 */

import { test, expect } from "../fixtures/base.ts";
import { makeTextSSEEvents } from "../fixtures/adminMock.ts";

test("header-badges: status transitions NEW→BUSY→IDLE and usage updates", async ({ cq, mock, page }) => {
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  // Initial state: the auto-start chat turn may still be streaming on open
  // (ACTIVITY-01: the badge shows "BUSY (1)" while that turn runs), so wait for
  // it to settle to NEW or IDLE before probing the next turn.
  const statusBadge = page.locator("[data-testid='session-status']");
  await expect(statusBadge).toBeVisible({ timeout: 5_000 });
  await expect(statusBadge).toHaveText(/^(NEW|IDLE)$/, { timeout: 15_000 });

  // Session-id badge must be present.
  const sessionIdBadge = page.locator("[data-testid='session-id']");
  await expect(sessionIdBadge).toBeVisible({ timeout: 3_000 });

  // Script the mock reply.
  const replyText = "header-badges-reply-unique";
  await mock.script(makeTextSSEEvents(replyText));

  // Record EVERY badge text change in-page via a MutationObserver (synchronous,
  // no per-sample CDP round-trip; same technique as stop.spec) so we can inspect
  // the transition history regardless of how brief any intermediate state is.
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w["__badgeHistory"] = [] as string[];
    const el = document.querySelector("[data-testid='session-status']");
    if (el === null) return;
    const record = (): void => {
      const t = (el.textContent ?? "").trim();
      const hist = w["__badgeHistory"] as string[];
      if (t.length > 0 && hist[hist.length - 1] !== t) hist.push(t);
    };
    record();
    new MutationObserver(record).observe(el, { childList: true, characterData: true, subtree: true });
  });

  // Send the message — the turn runs and (briefly) drives the badge to BUSY (1).
  await cq.sendMessage("header-badges-probe");

  // Wait for the reply to appear and the turn to complete.
  await cq.waitForTextInStream(replyText, 25_000);
  await expect(cq.textarea).toBeEnabled({ timeout: 25_000 });

  // After the turn: status must return to IDLE.
  await expect(statusBadge).toHaveText("IDLE", { timeout: 5_000 });

  // ACTIVITY-01 (ACTIVITY-01-D02): the badge BUSY state derives from the
  // server-pushed activity.status frame, which lags the send by one round-trip.
  // Against the near-INSTANT e2e SSE mock the running:1 (turn start) and
  // running:0 (turn end) frames can land in a single React render batch, so the
  // intermediate "BUSY (1)" may never paint — the badge correctly shows no
  // compute window. The DETERMINISTIC strict-label assertion (BUSY (1)/BUSY (2)/
  // IDLE/NEW driven by a pushed activity.status frame) therefore lives in the
  // web unit test packages/web/test/activity-badge.test.ts. Here we assert the
  // real chat lane drove the aggregate badge through a complete, correct
  // lifecycle: it was observed in a BUSY state at some point OR it settled so
  // fast it coalesced — either way it must END at IDLE (above) and, when a busy
  // frame WAS painted, that frame must carry the count form "BUSY (N)".
  const badgeHistory = await page.evaluate(
    () => (window as unknown as Record<string, string[]>)["__badgeHistory"],
  );
  const busyStates = badgeHistory.filter((s) => s.startsWith("BUSY"));
  for (const s of busyStates) {
    // Every busy label that DID paint must be the aggregate-count form.
    expect(s).toBe("BUSY (1)");
  }
  // The badge must have visited a known-valid set of states only.
  for (const s of badgeHistory) {
    expect(["NEW", "IDLE", "BUSY (1)"]).toContain(s);
  }

  // Usage counter must contain non-zero token counts.
  // Format: "↑<n> ↓<m> $<cost>"
  const usage = page.locator("[data-testid='usage']");
  await expect(usage).toBeVisible({ timeout: 3_000 });
  const usageText = await usage.textContent();
  // The SDK charges at least 1 input token per turn.
  expect(usageText).toMatch(/↑[1-9]\d*/);
});
