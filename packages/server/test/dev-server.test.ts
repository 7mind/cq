import { describe, it, expect } from "bun:test";
import type { Serve } from "bun";
import { startDevServer, type ServeFunction } from "../src/devServer";
import type { Logger } from "../src/log/logger";

/**
 * Minimal logger that discards all output — avoids log file I/O in tests.
 */
function makeNullLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

// ---------------------------------------------------------------------------
// Test 1: Config shape — assert that startDevServer passes the expected options
// ---------------------------------------------------------------------------
describe("startDevServer — config shape (options passthrough)", () => {
  it("passes development:{hmr:true} and routes:'/' to Bun.serve", async () => {
    let capturedOptions: Serve.Options<unknown> | undefined;

    const stubServe: ServeFunction = (opts) => {
      capturedOptions = opts as Serve.Options<unknown>;
      // Return a minimal server stub — enough for startDevServer to work with.
      return {
        url: new URL("http://127.0.0.1:0"),
        development: true,
        stop: () => Promise.resolve(),
        port: 0,
        hostname: "127.0.0.1",
        protocol: "http" as const,
        id: "stub",
        pendingRequests: 0,
        pendingWebSockets: 0,
        fetch: () => new Response(),
        reload: () => { throw new Error("not implemented"); },
        upgrade: () => false,
        publish: () => 0,
        subscriberCount: () => 0,
        requestIP: () => null,
        timeout: () => {},
        ref: () => {},
        unref: () => {},
        [Symbol.dispose]: () => {},
      } as unknown as ReturnType<typeof Bun.serve>;
    };

    const logger = makeNullLogger();
    await startDevServer(
      { host: "127.0.0.1", port: 0, cwd: "/tmp", dbPath: "/tmp/cq.sqlite", logger },
      stubServe,
    );

    expect(capturedOptions).toBeDefined();
    // development field must enable HMR
    const dev = capturedOptions!.development;
    expect(dev).toBeDefined();
    // dev may be a boolean true or an object with hmr: true
    const hmrEnabled =
      dev === true ||
      (typeof dev === "object" && dev !== null && (dev as { hmr?: boolean }).hmr === true);
    expect(hmrEnabled).toBe(true);

    // routes must include "/"
    const routes = (capturedOptions as { routes?: Record<string, unknown> }).routes;
    expect(routes).toBeDefined();
    expect("/" in routes!).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Operational — boot a real dev server and assert GET / returns 200
// with <div id="root"> in the body. Uses real Bun.serve with HMR enabled.
// ---------------------------------------------------------------------------
describe("startDevServer — operational (real Bun.serve)", () => {
  it("GET / returns 200 with <div id=\"root\"> in the body", async () => {
    const logger = makeNullLogger();
    const devServer = await startDevServer({
      host: "127.0.0.1",
      port: 0,
      cwd: "/tmp",
      dbPath: "/tmp/cq.sqlite",
      logger,
    });

    try {
      // development flag should be true on the returned handle
      expect(devServer.development).toBe(true);

      const res = await fetch(devServer.url);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`<div id="root">`);
    } finally {
      await devServer.stop();
    }
  }, 10_000);
});
