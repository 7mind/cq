import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const IMPLEMENT_ADVANCE = path.join(
  REPO_ROOT,
  "nix",
  "pkg",
  "cq-assets",
  "commands",
  "cq",
  "implement",
  "advance.md",
);

test("canonical implement orchestration declares the expected-failure policy", () => {
  const prompt = readFileSync(IMPLEMENT_ADVANCE, "utf8");
  expect(prompt).toContain("## 6a. Expected-failure tasks");
});
