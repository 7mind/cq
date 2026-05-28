/**
 * file-refs.test.ts — PR-36: FileRefAnchor + Markdown file-ref rendering.
 *
 * Test cases:
 *  1. Markdown text "Found /etc/hosts:12" renders an anchor with data-testid
 *     "file-ref-anchor"; clicking it calls manager.send() with a
 *     chat.read_file_request frame; when the result arrives, the snippet is shown.
 *  2. Markdown text with no path:line pattern renders no file-ref-anchor element.
 */

// Must be first — registers DOM globals.
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import { Markdown } from "../src/chat/Markdown";
import { ConnectionContext } from "../src/ws/ConnectionProvider";
import type { Manager } from "../src/ws/Manager";
import type { ServerFrame, ClientFrame, ChatReadFileRequest, ChatReadFileResult } from "@cq/shared";

// ---------------------------------------------------------------------------
// Minimal Manager mock
// ---------------------------------------------------------------------------

type MessageHandler = (frame: ServerFrame) => void;

class MockManager {
  readonly sentFrames: ClientFrame[] = [];
  private readonly handlers: MessageHandler[] = [];

  send(frame: ClientFrame): boolean {
    this.sentFrames.push(frame);
    return true;
  }

  onMessage(cb: MessageHandler): () => void {
    this.handlers.push(cb);
    return () => {
      const idx = this.handlers.indexOf(cb);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  /** Simulate receiving a server frame. */
  receive(frame: ServerFrame): void {
    for (const h of this.handlers) {
      h(frame);
    }
  }

  // Stub remaining Manager interface members used by useConnectionStats etc.
  get stats() {
    return {} as unknown as ReturnType<Manager["stats"]["valueOf"]>;
  }
  /**
   * Deterministic CryptoProvider for tests — gives stable requestIds so
   * assertions can pin them rather than matching a UUID regex.
   */
  readonly crypto = {
    _n: 0,
    randomUUID(): string {
      this._n += 1;
      return `mock-req-${this._n}`;
    },
  };
  onUpdate(): () => void { return () => {}; }
  destroy(): void {}
}

// ---------------------------------------------------------------------------
// DOM container lifecycle
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let reactRoot: ReturnType<typeof createRoot> | null = null;
let mockManager: MockManager;

function setup(): HTMLDivElement {
  mockManager = new MockManager();
  container = document.createElement("div");
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  return container;
}

function teardown(): void {
  if (reactRoot) {
    act(() => { reactRoot!.unmount(); });
    reactRoot = null;
  }
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
}

afterEach(() => { teardown(); });

function renderWithManager(src: string): HTMLDivElement {
  const c = setup();
  act(() => {
    reactRoot!.render(
      createElement(
        ConnectionContext.Provider,
        { value: mockManager as unknown as Manager },
        createElement(Markdown, null, src),
      ),
    );
  });
  return c;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    await act(async () => { await new Promise<void>((r) => setTimeout(r, 0)); });
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileRefAnchor — Markdown integration", () => {
  test("renders anchor for src/main.ts:42; click sends chat.read_file_request; result shows snippet", async () => {
    const c = renderWithManager("Found src/main.ts:42 in the diff");

    // Assert anchor rendered
    const anchor = c.querySelector("[data-testid='file-ref-anchor']");
    expect(anchor).not.toBeNull();
    expect((anchor as HTMLElement).dataset["path"]).toBe("src/main.ts");
    expect((anchor as HTMLElement).dataset["line"]).toBe("42");

    // Click the anchor
    act(() => {
      (anchor as HTMLElement).click();
    });

    // A chat.read_file_request should have been sent
    expect(mockManager.sentFrames.length).toBeGreaterThanOrEqual(1);
    const requestFrame = mockManager.sentFrames.find(
      (f) => f.type === "chat.read_file_request",
    ) as ChatReadFileRequest | undefined;
    expect(requestFrame).toBeDefined();
    expect(requestFrame!.path).toBe("src/main.ts");
    expect(requestFrame!.around.line).toBe(42);

    // Simulate the server result arriving
    const resultFrame: ChatReadFileResult = {
      type: "chat.read_file_result",
      seq: 1,
      ts: Date.now(),
      requestId: requestFrame!.requestId,
      content: "line7\nline8\nline9\nline10\nline11\nline12\nline13",
      startLine: 7,
    };
    act(() => {
      mockManager.receive(resultFrame);
    });

    // Wait for the snippet to appear
    const snippetVisible = await waitFor(() => {
      return c.querySelector("[data-testid='file-ref-snippet']") !== null;
    });
    expect(snippetVisible).toBe(true);

    const snippet = c.querySelector("[data-testid='file-ref-snippet']");
    expect(snippet?.textContent).toContain("line7");
  });

  test("does not render file-ref-anchor for plain text without path:line pattern", () => {
    const c = renderWithManager("This is just ordinary text without any file references.");
    const anchor = c.querySelector("[data-testid='file-ref-anchor']");
    expect(anchor).toBeNull();
  });
});
