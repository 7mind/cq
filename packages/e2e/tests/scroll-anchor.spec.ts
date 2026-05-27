/**
 * scroll-anchor.spec.ts — Tier 2: scroll-up shows "Jump to latest", clicking
 * it scrolls back and resumes auto-scroll.
 *
 * Scenario:
 *   1. Open the page
 *   2. Send 3 messages with long multi-paragraph replies to make the stream
 *      genuinely taller than clientHeight + SCROLL_NEAR_BOTTOM_PX (80px).
 *   3. Assert the stream is scrollable (precondition — fail loudly if not).
 *   4. Manually scroll the stream to the top.
 *   5. Verify the "Jump to latest" button appears.
 *   6. Click "Jump to latest" → button disappears, stream scrolled to bottom.
 */

import { test, expect } from "../fixtures/base.ts";
import { makeTextSSEEvents } from "../fixtures/adminMock.ts";

// A multi-paragraph body long enough that even a single reply generates
// significant DOM height. 60 lines × ~80 chars ensures the stream overflows
// even a tall viewport (1257px+). Increase the line count here if the
// precondition assertion fires on a taller display.
function makeLongReply(index: number): string {
  const line = `Reply ${index}: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.`;
  return Array.from({ length: 60 }, (_, i) => `${line} (line ${i + 1})`).join("\n");
}

test("scroll-anchor: jump-to-latest appears on scroll-up and scrolls back", async ({
  cq,
  mock,
}) => {
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  // Send 3 messages with long replies to ensure the stream overflows the viewport.
  const messageCount = 3;
  for (let i = 0; i < messageCount; i++) {
    await mock.script(makeTextSSEEvents(makeLongReply(i + 1)));
    await cq.sendMessage(`Message ${i + 1}`);
    // Wait for the response before sending the next.
    await expect(cq.textarea).toBeEnabled({ timeout: 25_000 });
  }

  // Verify the stream has content.
  await expect(cq.streamRoot).not.toBeEmpty();

  // Precondition: stream content must exceed clientHeight + 80px so that
  // scrolling to top actually puts us "far from bottom". If this fails, the
  // long-reply helper above needs more lines — the test was mis-configured,
  // not the UI.
  const dims = await cq.streamRoot.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(
    dims.scrollHeight,
    `Stream is not scrollable: scrollHeight(${dims.scrollHeight}) must be > clientHeight(${dims.clientHeight}) + 80. Increase makeLongReply() line count.`,
  ).toBeGreaterThan(dims.clientHeight + 80);

  // Scroll the stream to the top to trigger the scroll-up detection.
  await cq.scrollStreamToTop();

  // The "Jump to latest" button should appear.
  await expect(cq.jumpToLatestBtn).toBeVisible({ timeout: 5_000 });

  // Click it.
  await cq.jumpToLatestBtn.click();

  // The button should disappear (auto-scroll resumed).
  await expect(cq.jumpToLatestBtn).not.toBeVisible({ timeout: 5_000 });
});
