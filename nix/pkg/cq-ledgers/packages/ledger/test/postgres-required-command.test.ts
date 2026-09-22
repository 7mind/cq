import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readProcessIdentity } from "@cq/process-control";
import { runPostgresRequiredCommand } from "../bench/postgresRequiredCommand.js";
import { openPostgresTestCluster } from "../bench/postgresTestCluster.js";

async function captureRequiredCommand(command: readonly string[]) {
  const runner = Bun.spawn([process.execPath, "-e", `
    import { runPostgresRequiredCommand } from ${JSON.stringify(join(import.meta.dir, "../bench/postgresRequiredCommand.ts"))};
    try {
      const code = await runPostgresRequiredCommand(${JSON.stringify(command)}, process.cwd(), { ...process.env }, null);
      console.log(JSON.stringify({ code }));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      console.log(JSON.stringify({ code: error.code }));
    }
  `], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    runner.exited, new Response(runner.stdout).text(), new Response(runner.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("required gate command reports nonzero exits and spawn errors [T5916 Behavioral-Active Blackbox-GoodCommunication]", async () => {
  expect(await runPostgresRequiredCommand([process.execPath, "-e", "process.exit(7)"], process.cwd(), { ...process.env }, null)).toBe(7);
  await expect(runPostgresRequiredCommand(["/cq-nonexistent-gate-command"], process.cwd(), { ...process.env }, null)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["SIGTERM", "SIGKILL"] as const)("required gate reports actual terminating signal %s without losing process settlement [Behavioral-Active Blackbox-GoodCommunication]", async (signal) => {
  const childSource = `import { writeSync } from "node:fs"; writeSync(1, JSON.stringify({ childPid: process.pid }) + "\\n"); process.kill(process.pid, ${JSON.stringify(signal)});`;
  const { exitCode, stdout, stderr } = await captureRequiredCommand([process.execPath, "-e", childSource]);
  expect(exitCode).toBe(0);
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(2);
  const child = JSON.parse(lines[0]!) as { childPid: number };
  expect(JSON.parse(lines[1]!)).toEqual({ code: 1 });
  expect(await readProcessIdentity(child.childPid)).toBeNull();
  expect(stderr).toContain(`required PostgreSQL command terminated by signal ${signal} (pid ${child.childPid})`);
}, 15_000);

test.each([
  { name: "nonzero exit", command: [process.execPath, "-e", "process.exit(7)"], code: 7 },
  { name: "spawn error", command: ["/cq-nonexistent-gate-command"], code: "ENOENT" },
])("required gate does not misreport $name as a signal [Behavioral-Active Blackbox-GoodCommunication]", async ({ command, code }) => {
  const result = await captureRequiredCommand(command);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ code });
  expect(result.stderr).toBe("");
}, 15_000);

test("required gate cancellation settles its owned subprocess [T5916 Behavioral-Active Blackbox-GoodCommunication]", async () => {
  const root = await mkdtemp(join(tmpdir(), "cq-required-command-"));
  const ready = join(root, "ready");
  const abort = new AbortController();
  const command = runPostgresRequiredCommand([process.execPath, "-e", "await Bun.write(process.argv[1],String(process.pid));setInterval(()=>{},1000)", ready],
    root, { ...process.env }, abort.signal);
  try {
    const deadline = performance.now() + 5_000;
    while (!(await Bun.file(ready).exists())) {
      if (performance.now() >= deadline) throw new Error("owned gate command did not reach readiness");
      await Bun.sleep(5);
    }
    const pid = Number(await readFile(ready, "utf8"));
    expect(await readProcessIdentity(pid)).not.toBeNull();
    abort.abort();
    expect(await command).not.toBe(0);
    expect(await readProcessIdentity(pid)).toBeNull();
  } finally { abort.abort(); await command; await rm(root, { recursive: true, force: true }); }
}, 15_000);

describe.skipIf(!process.env.CQ_TEST_PG_URL)("PostgreSQL provided-cluster lease [T5916 Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("validates the live DSN without provisioning or stopping it", async () => {
    const forbidden = async () => { throw new Error("provided cluster must not run provisioning or cleanup commands"); };
    const cluster = await openPostgresTestCluster({ ...process.env }, forbidden, forbidden);
    expect(cluster.ownership).toBe("provided");
    await cluster.close();
    const pool = new SQL(cluster.dsn);
    try { expect([...await pool`SELECT 1 AS live`]).toEqual([{ live: 1 }]); }
    finally { await pool.close(); }
  });
});
