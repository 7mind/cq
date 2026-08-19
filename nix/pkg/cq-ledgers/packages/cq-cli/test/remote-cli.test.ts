import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { inMemoryRemoteClientFactory } from "../../ledger/test/remoteLedgerClientInMemoryAdapter.js";
import { runCounts } from "../src/counts.js";
import { runPredicates } from "../src/predicates.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("T730 remote CLI reads [BA]", () => {
  test("predicates and counts talk to the in-memory remote service", async () => {
    const service = await inMemoryRemoteClientFactory.build();
    const dir = await mkdtemp(path.join(tmpdir(), "t730-"));
    dirs.push(dir);
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    await writeFile(
      path.join(dir, "cq.toml"),
      `[ledger]\nbackend = "remote"\nserverUrl = "${service.serverUrl}"\nprojectId = "${service.projectKey}"\n`,
    );
    const previous = process.env["CQ_LEDGER_REMOTE_TOKEN"];
    process.env["CQ_LEDGER_REMOTE_TOKEN"] = service.validToken;
    const out: string[] = [];
    try {
      await runPredicates({ cwd: dir }, { out: (line) => out.push(line), err: () => undefined });
      expect(out[0]).toContain("\"predicates\"");
      out.length = 0;
      await runCounts({ cwd: dir }, { out: (line) => out.push(line), err: () => undefined });
      expect(out[0]).toContain("ledgerSummaries");
    } finally {
      if (previous === undefined) delete process.env["CQ_LEDGER_REMOTE_TOKEN"];
      else process.env["CQ_LEDGER_REMOTE_TOKEN"] = previous;
      await service.dispose();
    }
  });
});
