import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exposedLedgerToolsForRole } from "../src/index.js";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const REVIEW = join(
  REPOSITORY_ROOT,
  "nix",
  "pkg",
  "cq-assets",
  "commands",
  "cq",
  "implement-review.md",
);

describe("T1987 standalone implement-review workset boundary", () => {
  test("stays write-free and consumes only the parent-prepared task target", () => {
    const source = readFileSync(REVIEW, "utf8");
    expect(exposedLedgerToolsForRole("implement-review")).toEqual([]);
    expect(source).toContain("Write nothing");
    expect(source).toContain("supplied `taskId` is the only prepared target");
    expect(source).not.toContain("management-token");
  });
});
