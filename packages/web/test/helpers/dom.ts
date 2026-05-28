/**
 * dom.ts — happy-dom registration helper with cross-file cleanup.
 *
 * Why: `GlobalRegistrator.register()` patches process-global symbols
 * (`document`, `window`, `Request`, `fetch`, `Headers`, timer functions, …).
 * Without a corresponding `unregister()` call, those patches leak into any
 * test file the same bun-test process loads afterwards.
 *
 * That leak is observable. Bun's test discovery order is filesystem-dependent
 * and non-deterministic across worktrees/checkouts. In particular, the
 * polluted `Request` constructor strips forbidden headers (`Host`, `Origin`),
 * which breaks `packages/server/test/origin.test.ts`'s pure unit tests;
 * the polluted `fetch` produces HPE_UNEXPECTED_CONTENT_LENGTH against real
 * Bun-served HTTP, which breaks smoke, dev-server, ws-origin, sdk-stub, and
 * MockAnthropicHTTP-driven bridge tests.
 *
 * Fix: each happy-dom-using test file calls `registerDom()` at module top,
 * which (a) registers happy-dom if not already registered, and
 * (b) installs an `afterAll` hook to unregister at the end of that file's
 * test cases. Bun's `afterAll` registered at module scope runs once per file
 * (not once per process), so each file leaves the process globals as it
 * found them.
 *
 * The previous pattern was a shared-global guard that registered once across
 * the whole process and never unregistered. That worked accidentally on `main`
 * because filesystem order placed `packages/server/test/*` before
 * `packages/web/test/*`; once the worktree's order flipped, the leak became
 * a 19-test regression. See defects.md D-OUTER7-01.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll } from "bun:test";

/**
 * Register happy-dom DOM globals for this test file and arrange to
 * unregister them when the file's tests finish. Idempotent within a file
 * (multiple calls are safe — only the first registers).
 */
export function registerDom(): void {
  if (typeof globalThis.document === "undefined") {
    GlobalRegistrator.register();
  }
  // Tell React 19 this environment supports act() — suppresses the
  // "not configured to support act(...)" warning.
  // @ts-expect-error — IS_REACT_ACT_ENVIRONMENT is a React internal global not typed in bun-types
  if (!globalThis.IS_REACT_ACT_ENVIRONMENT) {
    // @ts-expect-error — IS_REACT_ACT_ENVIRONMENT is a React internal global not typed in bun-types
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  }
  afterAll(async () => {
    // Unregister only if we still have a happy-dom window globally.
    // (Defensive: another afterAll may have already unregistered.)
    if (typeof globalThis.document !== "undefined") {
      // Drain any pending microtasks + a macrotask cycle so React-DOM's
      // scheduler callbacks (which read `window.event`) have a chance to
      // run while `window` is still defined. Without this, React 19's
      // `performWorkOnRootViaSchedulerTask` can fire AFTER unregister and
      // throw `ReferenceError: window is not defined` between test files.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await GlobalRegistrator.unregister();
    }
  });
}
