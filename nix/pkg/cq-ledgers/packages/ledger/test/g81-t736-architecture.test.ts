import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

const pkg = path.resolve(import.meta.dir, "..");

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("T736 architecture [BA]", () => {
  test("no porsager postgres dependency and no LISTEN watcher", () => {
    const pkgJson = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkgJson.dependencies?.["postgres"]).toBeUndefined();
    expect(existsSync(path.join(pkg, "src/store/postgres/coherenceWatcher.ts"))).toBe(false);
  });

  test("public product sources do not listen/notify", () => {
    const sources = walkTs(path.join(pkg, "src"));
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/postgres\.listen|pg_notify|LEDGER_CHANGE_CHANNEL/);
    }
  });
});
