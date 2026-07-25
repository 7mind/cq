/**
 * T837 (G96): bootstrap the browser directly into the deep-linked XDG
 * project at the shared initial-connection seam (main.tsx). A valid
 * `?project=<key>` must resolve to `/p/<key>/mcp` + `/p/<key>/ws` BEFORE any
 * connection is attempted — the alias route (`/mcp`/`/ws`) must never be hit
 * first — while an absent or syntactically unsafe key falls back to the
 * alias deterministically (before any connect), a syntactically SAFE key
 * that names no REGISTERED project falls back ONCE post-connect-failure
 * (T837 round-1 fix / D143 criticism 1), `?url=` keeps full precedence (T588
 * Q273 contract untouched), and the always-visible selector (T589) still
 * reconnects + persists on switch.
 *
 * Pure-unit coverage (no DOM) mirrors mainToken.test.ts's established pattern
 * for `resolveToken`/`liveWsUrl`: every resolver here takes an injectable
 * `loc`. The Behavioral-Active group below proves the end-to-end "zero
 * wrong-project requests/sockets" property by feeding the SAME resolvers'
 * output into `App` (as main.tsx's own boot call does) and recording every
 * `connect()`/WebSocket URL.
 */
import { registerDom } from "./helpers/dom.js";
registerDom();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.js";
import { FakeClient } from "./fakeClient.js";
import type { LedgerClient } from "../src/types.js";
import { isSafeProjectKeySegment } from "../src/projectRoutes.js";

const { resolveDeepLinkedProjectKey, resolveInitialUrl, liveWsUrl, resolveDeepLinkFallback } =
  await import("../src/main.js");

describe("isSafeProjectKeySegment", () => {
  it("accepts an ordinary single-segment key", () => {
    expect(isSafeProjectKeySegment("p2")).toBe(true);
    expect(isSafeProjectKeySegment("my-project_1")).toBe(true);
  });

  it("rejects blank, dot-segment, path-separator, and NUL-bearing keys", () => {
    expect(isSafeProjectKeySegment("")).toBe(false);
    expect(isSafeProjectKeySegment("   ")).toBe(false);
    expect(isSafeProjectKeySegment(".")).toBe(false);
    expect(isSafeProjectKeySegment("..")).toBe(false);
    expect(isSafeProjectKeySegment("a/b")).toBe(false);
    expect(isSafeProjectKeySegment("a\\b")).toBe(false);
    expect(isSafeProjectKeySegment("a\0b")).toBe(false);
  });
});

describe("resolveDeepLinkedProjectKey", () => {
  it("reads a safe ?project= key", () => {
    expect(resolveDeepLinkedProjectKey({ search: "?project=p2" })).toBe("p2");
  });

  it("returns null when absent", () => {
    expect(resolveDeepLinkedProjectKey({ search: "" })).toBeNull();
    expect(resolveDeepLinkedProjectKey({ search: "?url=/mcp" })).toBeNull();
  });

  it("returns null for a blank or unsafe key (falls back to the alias)", () => {
    expect(resolveDeepLinkedProjectKey({ search: "?project=" })).toBeNull();
    expect(resolveDeepLinkedProjectKey({ search: "?project=.." })).toBeNull();
    expect(resolveDeepLinkedProjectKey({ search: `?project=${encodeURIComponent("a/b")}` })).toBeNull();
  });
});

describe("resolveInitialUrl", () => {
  it("routes a valid ?project=<key> to /p/<key>/mcp before any connection", () => {
    expect(resolveInitialUrl({ search: "?project=p2", origin: "http://x" })).toBe("http://x/p/p2/mcp");
  });

  it("?url= keeps full precedence over ?project= (T837-preserved)", () => {
    expect(
      resolveInitialUrl({ search: "?url=http://elsewhere/mcp&project=p2", origin: "http://x" }),
    ).toBe("http://elsewhere/mcp");
  });

  it("falls back to the default /mcp alias when ?project= is absent", () => {
    expect(resolveInitialUrl({ search: "", origin: "http://x" })).toBe("http://x/mcp");
  });

  it("falls back to the default /mcp alias when ?project= is unsafe (deterministic)", () => {
    expect(resolveInitialUrl({ search: "?project=..", origin: "http://x" })).toBe("http://x/mcp");
    expect(
      resolveInitialUrl({ search: `?project=${encodeURIComponent("a/b")}`, origin: "http://x" }),
    ).toBe("http://x/mcp");
  });

  it("percent-encodes the key when deriving the per-project route", () => {
    expect(resolveInitialUrl({ search: "?project=a b", origin: "http://x" })).toBe("http://x/p/a%20b/mcp");
  });
});

describe("liveWsUrl (T837 project-aware)", () => {
  it("routes a valid ?project=<key> to /p/<key>/ws, paired with resolveInitialUrl", () => {
    expect(liveWsUrl(null, { protocol: "http:", host: "x", search: "?project=p2" })).toBe("ws://x/p/p2/ws");
  });

  it("appends ?token= onto the per-project ws URL", () => {
    expect(liveWsUrl("abc 123", { protocol: "http:", host: "x", search: "?project=p2" })).toBe(
      "ws://x/p/p2/ws?token=abc%20123",
    );
  });

  it("falls back to /ws when ?project= is absent or unsafe", () => {
    expect(liveWsUrl(null, { protocol: "http:", host: "x", search: "" })).toBe("ws://x/ws");
    expect(liveWsUrl(null, { protocol: "http:", host: "x", search: "?project=.." })).toBe("ws://x/ws");
  });
});

// --- Behavioral-Active: prove the seam end-to-end through App -------------

let container: HTMLElement;
let root: Root;
/**
 * The pure resolvers (`resolveInitialUrl`/`liveWsUrl`) take `origin` as an
 * explicit param, decoupled from `window.location` — this fixed value drives
 * both. App's own T589 post-connect `?project=` read, however, reads the REAL
 * `window.location.search` — see `setLocationSearch` below, which sets it
 * WITHOUT changing origin (happy-dom's `about:blank` origin refuses a
 * `history.replaceState` to a different one — mirrors projectSelector.test.tsx's
 * `next = new URL(window.location.href)` pattern).
 */
const ORIGIN = "http://x";
const HOST = new URL(ORIGIN).host;
function setLocationSearch(search: string): void {
  const next = new URL(window.location.href);
  next.search = search;
  window.history.replaceState(null, "", next.toString());
}
const sleep = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(10);
  });
}
const testid = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  window.history.replaceState(null, "", "about:blank");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

/** Minimal fake WebSocket (mirrors projectSelector.test.tsx's FakeWS). */
class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

describe("T837 Behavioral-Active: deep-link bootstrap makes zero wrong-project requests/sockets", () => {
  it("a valid ?project=p2 deep link connects + opens a socket to p2 directly — /p/p1 (alias) is never contacted", async () => {
    FakeWS.instances = [];
    const p1 = new FakeClient("Project One");
    p1.projects = [
      { key: "p1", displayName: "Project One" },
      { key: "p2", displayName: "Project Two" },
    ];
    const p2 = new FakeClient("Project Two");
    p2.projects = p1.projects;
    await p2.createItem("bugs", "M1", { status: "open", fields: { headline: "only in project two" } });

    const connectedUrls: string[] = [];
    const connect = async (url: string): Promise<LedgerClient> => {
      connectedUrls.push(url);
      // The alias project (p1) must NEVER be dialed for this deep link — fail
      // loudly rather than silently answering with the wrong project's data.
      if (url.includes("/p/p1/") || url === `${ORIGIN}/mcp`) {
        throw new Error(`unexpected wrong-project connect: ${url}`);
      }
      return p2;
    };

    const search = "?project=p2";
    // Mirror a real deep link: main.tsx's resolvers AND App's own post-connect
    // ?project= match (T589) both read the SAME page location in production.
    setLocationSearch(search);
    await act(async () => {
      root.render(
        createElement(App, {
          connect,
          initialUrl: resolveInitialUrl({ search, origin: ORIGIN }),
          liveUrl: liveWsUrl(null, { protocol: "http:", host: HOST, search }),
          liveWsCtor: FakeWS as unknown as { new (url: string): WebSocket },
        }),
      );
    });
    await flush();

    // Exactly ONE connect call, straight to /p/p2/mcp — the alias route was
    // never attempted first.
    expect(connectedUrls).toEqual([`${ORIGIN}/p/p2/mcp`]);
    // Exactly ONE socket, straight to /p/p2/ws.
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0]!.url).toBe(`ws://${HOST}/p/p2/ws`);

    // The selector reflects p2 as active (matched against the FULL catalog
    // returned by list_projects on the already-correct connection), with no
    // additional connect triggered by that match.
    const select = testid("project-selector") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.value).toBe("p2");
    expect(connectedUrls).toHaveLength(1);

    // Views render p2's data (proves the live connection is really p2's).
    click(testid("ledger-bugs"));
    await flush();
    expect(container.textContent ?? "").toContain("only in project two");
  });

  it("absent ?project= falls back deterministically to the alias /mcp + /ws — no /p/ route is ever attempted", async () => {
    FakeWS.instances = [];
    const alias = new FakeClient("cq1");
    const connectedUrls: string[] = [];
    const connect = async (url: string): Promise<LedgerClient> => {
      connectedUrls.push(url);
      if (url.includes("/p/")) throw new Error(`unexpected per-project connect: ${url}`);
      return alias;
    };

    const search = "";
    setLocationSearch(search);
    await act(async () => {
      root.render(
        createElement(App, {
          connect,
          initialUrl: resolveInitialUrl({ search, origin: ORIGIN }),
          liveUrl: liveWsUrl(null, { protocol: "http:", host: HOST, search }),
          liveWsCtor: FakeWS as unknown as { new (url: string): WebSocket },
        }),
      );
    });
    await flush();

    expect(connectedUrls).toEqual([`${ORIGIN}/mcp`]);
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0]!.url).toBe(`ws://${HOST}/ws`);
  });

  it("an unsafe ?project=.. falls back deterministically to the alias — never attempted as a route", async () => {
    FakeWS.instances = [];
    const alias = new FakeClient("cq1");
    const connectedUrls: string[] = [];
    const connect = async (url: string): Promise<LedgerClient> => {
      connectedUrls.push(url);
      if (url.includes("/p/")) throw new Error(`unexpected per-project connect: ${url}`);
      return alias;
    };

    const search = "?project=..";
    setLocationSearch(search);
    await act(async () => {
      root.render(
        createElement(App, {
          connect,
          initialUrl: resolveInitialUrl({ search, origin: ORIGIN }),
          liveUrl: liveWsUrl(null, { protocol: "http:", host: HOST, search }),
          liveWsCtor: FakeWS as unknown as { new (url: string): WebSocket },
        }),
      );
    });
    await flush();

    expect(connectedUrls).toEqual([`${ORIGIN}/mcp`]);
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0]!.url).toBe(`ws://${HOST}/ws`);
  });

  it("a SAFE but UNREGISTERED ?project=stale falls back ONCE to the alias, post-connect-failure, instead of bricking the page (T837 round-1 fix / D143 criticism 1)", async () => {
    FakeWS.instances = [];
    // `stale` is syntactically safe (isSafeProjectKeySegment("stale") === true)
    // but not a registered project — the real serveXdgCatalog answers 404
    // "unknown project" for exactly this case (xdgCatalogServe.ts:200-203).
    const alias = new FakeClient("cq1");
    const connectedUrls: string[] = [];
    const connect = async (url: string): Promise<LedgerClient> => {
      connectedUrls.push(url);
      if (url === `${ORIGIN}/p/stale/mcp`) throw new Error("404: unknown project");
      if (url === `${ORIGIN}/mcp`) return alias;
      throw new Error(`unexpected connect: ${url}`);
    };

    const search = "?project=stale";
    setLocationSearch(search);
    await act(async () => {
      root.render(
        createElement(App, {
          connect,
          initialUrl: resolveInitialUrl({ search, origin: ORIGIN }),
          liveUrl: liveWsUrl(null, { protocol: "http:", host: HOST, search }),
          deepLinkFallback: resolveDeepLinkFallback(null, {
            search,
            origin: ORIGIN,
            protocol: "http:",
            host: HOST,
          }),
          liveWsCtor: FakeWS as unknown as { new (url: string): WebSocket },
        }),
      );
    });
    await flush();

    // Exactly TWO connect calls, in order: the deep-linked stale project
    // first (which fails with the catalog-miss), then the alias — the
    // fallback is ONE-SHOT, not a blanket retry loop.
    expect(connectedUrls).toEqual([`${ORIGIN}/p/stale/mcp`, `${ORIGIN}/mcp`]);
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0]!.url).toBe(`ws://${HOST}/ws`);

    // The page recovers instead of bricking: conn is "connected" and the
    // selector is enabled over the real (alias) catalog, not disabled over
    // an empty one.
    const select = testid("project-selector") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.disabled).toBe(false);
    expect(select!.value).toBe("cq1");
  });
});

function click(el: Element | null): void {
  if (el === null) throw new Error("click: element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}
