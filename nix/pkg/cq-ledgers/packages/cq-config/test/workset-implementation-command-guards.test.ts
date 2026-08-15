import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const COMMAND_ROOT = join(REPOSITORY_ROOT, "nix", "pkg", "cq-assets", "commands", "cq");

function command(relativePath: string): string {
  return readFileSync(join(COMMAND_ROOT, relativePath), "utf8");
}

describe("T1987 implementation command workset guards", () => {
  test("start and advance bind the shared boundary and scope implicit selection to manifests", () => {
    const start = command("implement/start.md");
    const advance = command("implement/advance.md");
    for (const [name, source] of [
      ["implement/start", start],
      ["implement/advance", advance],
    ] as const) {
      expect(source, name).toContain("{{cq:fragment:workset-effect-discipline}}");
    }
    expect(start).toContain("eligible finalized-manifest work");
    expect(advance).toContain("eligible finalized-manifest work");
  });
});
