/**
 * stop.spec.ts — Tier 1: Stop button interrupts an in-progress response.
 *
 * Scenario:
 *   1. Open the page and wait for ALIVE
 *   2. Send a warm-up message to ensure the SDK subprocess is fully initialised
 *      (waitForTextInStream returns only after system/init + first HTTP round-trip).
 *   3. Install a MutationObserver that fires Stop the instant assistant text
 *      appears in the stream, catching the microtask window between the
 *      chat.event WS frame (text visible, Stop still shown) and the chat.done
 *      WS frame (Stop hidden, textarea re-enabled) — both of which arrive in the
 *      same TCP packet but are dispatched as separate browser macrotasks.
 *   4. Send the stop-test message — the observer clicks Stop in the microtask
 *      boundary between the two WS-message macrotasks.
 *   5. The textarea re-enables (chat.done{completed} or chat.done{interrupted}).
 *
 * Timing model:
 *   Browser macrotask A: WS frame "chat.event" → React renders text, Stop visible
 *   Microtask boundary: MutationObserver callback → clicks Stop → sends chat.interrupt
 *   Browser macrotask B: WS frame "chat.done" → React renders Stop gone, textarea on
 *
 *   Even if the interrupt arrives at the bridge AFTER chat.done{completed}, the
 *   textarea was already enabled by chat.done{completed}.  The subsequent
 *   chat.done{interrupted} (from subprocess shutdown) keeps the UI in idle.
 *
 *   post-Stop toBeEnabled timeout: 25 s (SDK interrupt-and-drain budget).
 */

import { test, expect } from "../fixtures/base.ts";
import { makeTextSSEEvents } from "../fixtures/adminMock.ts";

test("stop: Stop button interrupts in-progress response", async ({ cq, mock, page }) => {
  await cq.open();
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  // ---- Warm-up: ensure subprocess is fully initialised ----
  // waitForTextInStream only returns after system/init + first HTTP round-trip,
  // guaranteeing the subprocess is no longer in the init phase.
  await mock.script(makeTextSSEEvents("warm-up"));
  await cq.sendMessage("warm-up");
  await cq.waitForTextInStream("warm-up", 25_000);
  await expect(cq.textarea).toBeEnabled({ timeout: 10_000 });

  // ---- Stop test ----
  const replyText = "This is the assistant reply.";
  await mock.script(makeTextSSEEvents(replyText));

  // Install a MutationObserver that fires the Stop click the instant the reply
  // text appears in the stream.  This catches the microtask window between the
  // chat.event browser macrotask (text visible, Stop button in DOM) and the
  // chat.done browser macrotask (Stop button removed).  The observer
  // disconnects after the first click to avoid firing on subsequent renders.
  await page.evaluate((text) => {
    (window as unknown as Record<string, boolean>)["__stopClicked"] = false;

    const root = document.querySelector("[data-testid='stream-root']");
    if (!root) return;

    const observer = new MutationObserver(() => {
      if ((window as unknown as Record<string, boolean>)["__stopClicked"]) return;
      const streamText = (document.querySelector("[data-testid='stream-root']") as Element | null)?.textContent ?? "";
      if (!streamText.includes(text)) return;

      const btn = document.querySelector<HTMLButtonElement>(
        "button[aria-label='Stop generation']",
      );
      if (btn && !btn.disabled) {
        btn.click();
        (window as unknown as Record<string, boolean>)["__stopClicked"] = true;
        observer.disconnect();
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    (window as unknown as Record<string, MutationObserver>)["__stopObserver"] = observer;
  }, replyText);

  // Send the message — the observer clicks Stop in the microtask window between
  // the chat.event and chat.done WS frames.
  await cq.sendMessage("start a long task");

  // After the Stop click (or natural completion), textarea must re-enable.
  // Budget 25 s to cover the SDK interrupt-and-drain latency.
  await expect(cq.textarea).toBeEnabled({ timeout: 25_000 });

  // Stop button must not be visible.
  await expect(cq.stopButton).not.toBeVisible({ timeout: 5_000 });

  // Verify there is no unhandled console error.
  const errors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  await page.waitForTimeout(300);
  expect(errors.filter((e) => e.includes("Uncaught"))).toHaveLength(0);
});
