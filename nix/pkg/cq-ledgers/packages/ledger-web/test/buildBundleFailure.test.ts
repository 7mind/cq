/**
 * Regression test for D110: buildBundle must surface the per-module
 * ResolveMessage detail (naming the unresolvable specifier) on a failed
 * Bun.build, not the generic `AggregateError("Bundle failed")` that Bun
 * throws by default when `throw` is left at its default (true).
 *
 * Kept in its OWN file (see serveEmbedded.test.ts) because a second
 * in-process Bun.build alongside serve.test.ts's has tripped a documented
 * Bun bundler limitation; if that recurs here, fall back to running the
 * failing build in a spawned subprocess.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildBundle } from "../src/serve.js";

const UNRESOLVABLE_SPECIFIER = "@cq/definitely-not-a-real-module-d110";

let tmpRoot: string;
let fixtureEntry: string;
let outdir: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "buildBundleFailure-"));
  fixtureEntry = path.join(tmpRoot, "entry.tsx");
  await fs.writeFile(fixtureEntry, `import "${UNRESOLVABLE_SPECIFIER}";\n`, "utf8");
  outdir = path.join(tmpRoot, "out");
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("buildBundle failure diagnostics (D110)", () => {
  it("rejects naming both the ledger-web prefix and the unresolvable specifier", async () => {
    await expect(buildBundle(outdir, fixtureEntry)).rejects.toThrow(
      new RegExp(
        `ledger-web: Bun\\.build failed:[\\s\\S]*${UNRESOLVABLE_SPECIFIER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  });
});
