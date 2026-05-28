/**
 * dom.test.ts — regression assertion for D-OUTER7-01.
 *
 * The defect: `GlobalRegistrator.register()` patches process-global symbols
 * (`document`, `window`, `Request`, `fetch`, `Headers`, …). Without a
 * corresponding `unregister()` call, those patches leak into any test file
 * the same bun-test process loads afterwards — breaking server-side unit
 * tests (origin.test.ts) and HTTP-driven integration tests (smoke,
 * dev-server, ws-origin, sdk-stub, MockAnthropicHTTP-driven bridge tests).
 *
 * The fix is `registerDom()` (see helpers/dom.ts), which installs an
 * `afterAll` hook to unregister at the end of each test file. This file
 * asserts that the hook actually fires by:
 *
 *  1. Calling `registerDom()` at module top (so `document` is defined here).
 *  2. Registering a second `afterAll` AFTER the helper's `afterAll` — Bun
 *     fires `afterAll` hooks in registration order, so this one runs last
 *     and observes the post-cleanup state.
 *  3. Asserting in that final hook that `globalThis.document === undefined`,
 *     i.e. the helper's `afterAll` successfully unregistered.
 *
 * If a future refactor drops the unregister call (or breaks its ordering
 * relative to subsequent afterAll hooks), this test fails locally —
 * the polluter is caught here rather than via downstream pollution in
 * server tests, which is opaque to debug.
 */

import { registerDom } from "./dom";
import { describe, test, expect, afterAll } from "bun:test";

registerDom();

// This afterAll is registered after registerDom()'s internal afterAll, so it
// runs after the helper's unregister(). It is the regression assertion:
// if the helper stops unregistering, document remains defined here and this
// throws. The afterAll's assertion failure is reported on the file's
// containing describe.
afterAll(() => {
  // The unregister sequence ends with `globalThis.document` being deleted by
  // happy-dom; assert that's what happened.
  if (typeof globalThis.document !== "undefined") {
    throw new Error(
      "D-OUTER7-01 regression: helpers/dom.ts did not unregister happy-dom — " +
        "globalThis.document is still defined after the file's tests finished. " +
        "This will leak DOM-patched globals into subsequent test files and break " +
        "server tests like origin.test.ts.",
    );
  }
});

describe("helpers/dom: registerDom() lifecycle", () => {
  test("registers document during the file's tests", () => {
    expect(typeof globalThis.document).toBe("object");
  });

  test("Request constructor accepts forbidden headers under happy-dom (sanity)", () => {
    // happy-dom's Request strips Host/Origin from user-provided headers.
    // This documents the polluted behaviour that the unregister contract
    // must hide from downstream tests. Native Bun preserves these headers.
    const r = new Request("http://0.0.0.0/", {
      headers: { Host: "vm:8733", Origin: "http://vm:8733" },
    });
    expect(r.headers.get("Host")).toBe(null);
    expect(r.headers.get("Origin")).toBe(null);
  });
});
