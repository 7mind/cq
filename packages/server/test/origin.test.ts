/**
 * origin.test.ts — unit tests for isOriginAllowed().
 *
 * Contract: Origin authority MUST equal Host authority. The server's bind
 * address is irrelevant to the same-origin check (a server bound to 0.0.0.0
 * is reachable via any DNS name resolving to one of its interfaces).
 *
 * The integration tests in ws-origin.test.ts cover the HTTP-403 wiring;
 * this file covers the predicate's edge cases directly.
 */

import { describe, expect, test } from "bun:test";
import { isOriginAllowed } from "../src/ws/origin";

function req(headers: Record<string, string>): Request {
  return new Request("http://0.0.0.0/ws", { headers });
}

describe("isOriginAllowed", () => {
  test("Origin matches Host (explicit ports) → allowed", () => {
    expect(
      isOriginAllowed(
        req({ Origin: "http://vm:8733", Host: "vm:8733" }),
      ),
    ).toBe(true);
  });

  test("Origin matches Host (server bound to 0.0.0.0, reached via hostname) → allowed", () => {
    // The dogfooding bug: server bound to 0.0.0.0, browser hits http://vm:8733/,
    // sends Origin: http://vm:8733 + Host: vm:8733. The old impl compared
    // Origin against the bind host (0.0.0.0) and rejected. Now it compares
    // Origin against Host (vm:8733) and accepts.
    expect(
      isOriginAllowed(
        req({ Origin: "http://vm:8733", Host: "vm:8733" }),
      ),
    ).toBe(true);
  });

  test("Origin host differs from Host → rejected", () => {
    expect(
      isOriginAllowed(
        req({ Origin: "http://evil.example:8733", Host: "vm:8733" }),
      ),
    ).toBe(false);
  });

  test("Origin port differs from Host → rejected", () => {
    expect(
      isOriginAllowed(
        req({ Origin: "http://vm:8734", Host: "vm:8733" }),
      ),
    ).toBe(false);
  });

  test("Missing Origin header → rejected", () => {
    expect(isOriginAllowed(req({ Host: "vm:8733" }))).toBe(false);
  });

  test("Empty Origin header → rejected", () => {
    expect(isOriginAllowed(req({ Origin: "", Host: "vm:8733" }))).toBe(false);
  });

  test("Missing Host header → rejected", () => {
    // Construct directly because Bun's Request always adds Host from the URL,
    // so we use Headers with delete.
    const r = new Request("http://0.0.0.0/ws", {
      headers: { Origin: "http://vm:8733" },
    });
    r.headers.delete("Host");
    expect(isOriginAllowed(r)).toBe(false);
  });

  test("Malformed Origin URL → rejected", () => {
    expect(
      isOriginAllowed(req({ Origin: "not a url", Host: "vm:8733" })),
    ).toBe(false);
  });

  test("Origin without explicit port defaults to 80 → matches Host 'vm:80'", () => {
    expect(
      isOriginAllowed(req({ Origin: "http://vm", Host: "vm:80" })),
    ).toBe(true);
  });

  test("Origin without port + Host without port → both default to 80, allowed", () => {
    expect(
      isOriginAllowed(req({ Origin: "http://vm", Host: "vm" })),
    ).toBe(true);
  });

  test("Hostname case-insensitive", () => {
    expect(
      isOriginAllowed(req({ Origin: "http://VM:8733", Host: "vm:8733" })),
    ).toBe(true);
  });

  test("IPv6 with brackets in Origin and Host", () => {
    expect(
      isOriginAllowed(
        req({ Origin: "http://[::1]:8733", Host: "[::1]:8733" }),
      ),
    ).toBe(true);
  });

  test("Host with non-numeric port → rejected", () => {
    expect(
      isOriginAllowed(req({ Origin: "http://vm:8733", Host: "vm:not-a-port" })),
    ).toBe(false);
  });
});
