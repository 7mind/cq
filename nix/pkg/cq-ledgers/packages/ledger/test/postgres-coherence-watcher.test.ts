import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";

describe("T736 LISTEN/NOTIFY watcher is retired [BA]", () => {
  test("coherenceWatcher.ts is gone", () => {
    expect(
      existsSync(path.resolve(import.meta.dir, "../src/store/postgres/coherenceWatcher.ts")),
    ).toBe(false);
  });
});
