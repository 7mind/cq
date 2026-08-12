import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const decoder = new TextDecoder();
const roots: string[] = [];

interface ChildResult {
  readonly exitCode: number | null;
  readonly output: string;
}

function fixtureSource(assertion: string): string {
  return [
    'import { expect, test } from "bun:test";',
    "",
    'test.failing("expected failure marker contract", () => {',
    `  expect(true).${assertion};`,
    "});",
    "",
  ].join("\n");
}

function runFixture(fixturePath: string): ChildResult {
  const result = Bun.spawnSync([process.execPath, "test", fixturePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("bun inverts test.failing outcomes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cq-expected-failure-marker-"));
  roots.push(root);
  const fixtureAPath = path.join(root, "fixture-a.test.ts");
  const fixtureBPath = path.join(root, "fixture-b.test.ts");
  const fixtureA = fixtureSource("toBe(false)");
  const fixtureB = fixtureSource("toBe(true)");

  writeFileSync(fixtureAPath, fixtureA);
  writeFileSync(fixtureBPath, fixtureB);

  const childA = runFixture(fixtureAPath);
  const childB = runFixture(fixtureBPath);

  expect(fixtureA.replace("toBe(false)", "toBe(true)")).toBe(fixtureB);
  expect(childA.exitCode).toBe(0);
  expect(childB.exitCode).not.toBe(0);
  expect(childA.exitCode).not.toBe(childB.exitCode);
  expect(childB.output).toContain("marked as failing but it passed");
});
