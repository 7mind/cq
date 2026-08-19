import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const cliRoot = path.resolve(import.meta.dir, "../src");

function read(rel: string): string {
  return readFileSync(path.join(cliRoot, rel), "utf8");
}

describe("G81 remote CLI architecture", () => {
  test("routine CLI consumers no longer throw RemoteLedgerClientNotWiredError [BA]", () => {
    for (const file of ["predicates.ts", "counts.ts", "stats.ts", "advanceGate.ts", "logPut.ts"]) {
      expect(read(file)).not.toContain("RemoteLedgerClientNotWiredError");
    }
    expect(read("main.ts")).not.toContain("RemoteLedgerClientNotWiredError");
  });

  test("remote admin operations go through withRemoteAdminClient [BA]", () => {
    const main = read("main.ts");
    expect(main).toContain("withRemoteAdminClient");
    expect(main).toContain("runResetRemote");
    expect(main).toContain("runEraseRemote");
    expect(main).toContain("runBackupRemote");
    expect(main).toContain("runRestoreRemote");
  });
});
