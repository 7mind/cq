import { describe, expect, it } from "bun:test";
import * as guards from "../src/stdioProcessGuards.js";

describe("stdioProcessGuards", () => {
  it("does not expose a process-wide singleton guard", () => {
    expect("acquireStdioSingletonLock" in guards).toBe(false);
  });
});
