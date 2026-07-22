/**
 * main.tsx's ?token= wiring (T588 / Q273): resolveToken reads the page-URL
 * query param, liveWsUrl forwards it onto the /ws upgrade. Both take an
 * injectable `loc` so they're pure-testable with no DOM/happy-dom needed.
 */
import { describe, it, expect } from "bun:test";
import { registerDom } from "./helpers/dom.js";

// main.tsx references `document`/`window` at module top-level (mounts the
// React root on import) — happy-dom must be registered before importing it.
registerDom();
const { resolveToken, liveWsUrl } = await import("../src/main.js");

describe("resolveToken", () => {
  it("reads ?token= from the page URL", () => {
    expect(resolveToken({ search: "?token=abc123" })).toBe("abc123");
  });

  it("returns null when absent or blank", () => {
    expect(resolveToken({ search: "" })).toBeNull();
    expect(resolveToken({ search: "?url=/mcp" })).toBeNull();
    expect(resolveToken({ search: "?token=" })).toBeNull();
  });
});

describe("liveWsUrl", () => {
  it("appends ?token= when a token is known", () => {
    expect(liveWsUrl("abc 123", { protocol: "http:", host: "h:5190" })).toBe(
      "ws://h:5190/ws?token=abc%20123",
    );
  });

  it("omits the query param when no token is known", () => {
    expect(liveWsUrl(null, { protocol: "http:", host: "h:5190" })).toBe("ws://h:5190/ws");
  });

  it("uses wss: on an https page", () => {
    expect(liveWsUrl(null, { protocol: "https:", host: "h:443" })).toBe("wss://h:443/ws");
  });
});
