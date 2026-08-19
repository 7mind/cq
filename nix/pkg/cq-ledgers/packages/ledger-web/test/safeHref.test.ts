import { describe, expect, test } from "bun:test";
import { safeHref } from "../src/App.js";

describe("T819 safeHref", () => {
  test("accepts http(s) and rejects unsafe schemes [BA]", () => {
    expect(safeHref("https://example.invalid/issues/1")).toBe("https://example.invalid/issues/1");
    expect(safeHref("http://127.0.0.1/x")).toBe("http://127.0.0.1/x");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });
});
