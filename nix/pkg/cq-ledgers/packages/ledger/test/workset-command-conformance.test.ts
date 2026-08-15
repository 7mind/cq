import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const WORKSPACE_ROOT = resolve(import.meta.dir, "..", "..", "..");
const REPOSITORY_ROOT = resolve(WORKSPACE_ROOT, "..", "..", "..");

describe("T1988 representative command transports [Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("executes the shared direct, stdio, HTTP, and Remote management contract", async () => {
    const child = Bun.spawn(
      [process.execPath, "test", "packages/ledger-mcp/test/workset-transport-parity.test.ts"],
      {
        cwd: WORKSPACE_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`transport parity child failed (${exitCode})\n${stdout}\n${stderr}`);
    }
    expect(`${stdout}\n${stderr}`).toContain("4 pass");
  });
});

describe("T1988 command and launcher conformance inventory [Contract-Active Whitebox-Atomic]", () => {
  test("keeps CLI, generated guards, launchers, and Pi lifecycle evidence gate-reachable", async () => {
    const paths = [
      join(WORKSPACE_ROOT, "packages/cq-config/test/workset-operation-authority.test.ts"),
      join(WORKSPACE_ROOT, "packages/cq-config/test/workset-effect-boundary-inventory.test.ts"),
      join(WORKSPACE_ROOT, "packages/process-control/test/worksetGitEffectGate.test.ts"),
      join(REPOSITORY_ROOT, "nix/pkg/pi-extensions/cq-subagent-process-lifecycle.test.ts"),
      join(REPOSITORY_ROOT, "nix/pkg/pi-extensions/cq-subagent-dispatch.test.ts"),
    ];
    for (const path of paths) await access(path);
  });

  test("the representative transport contract remains bounded to one in-memory backend", async () => {
    const source = await readFile(
      join(WORKSPACE_ROOT, "packages/ledger-mcp/test/workset-transport-parity.test.ts"),
      "utf8",
    );
    expect(source).toContain("direct management");
    expect(source).toContain("stdio management");
    expect(source).toContain("HTTP management");
    expect(source).toContain("RemoteLedgerClient management");
    expect(source).toContain("new InMemoryLedgerStore()");
    expect(source).not.toContain("PostgresLedgerStore");
    expect(source).not.toContain("FsLedgerStore");
    expect(source).not.toContain("GitObjectLedgerBackend");
    expect(source).not.toContain("SqliteLedgerStore");
  });
});
