/**
 * T579 — `cq predicates` / `cq counts` / `cq advance-gate` against a
 * `backend = 'postgres'` cq.toml, driven as REAL subprocesses of the actual
 * `cq` entrypoint (`packages/cq-cli/src/main.ts`) — proving the whole
 * product wire (arg parsing, dispatch, createLedgerStore) works over this
 * backend with zero product changes, and that each command still emits
 * valid JSON on stdout.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, same gate as every other
 * postgres-*.test.ts): no live Postgres in this sandbox/CI by default, so
 * this file SKIPS cleanly offline and `bun run check` stays green.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PG_URL = process.env.CQ_TEST_PG_URL;
const dirs: string[] = [];

const CQ_MAIN = path.resolve(import.meta.dir, "../src/main.ts");

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/** A throwaway initialised git repo (stable projectKey) with cq.toml selecting postgres. */
async function postgresRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-native-cmds-pg-"));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), `# repo ${randomUUID()}\n`, "utf8");
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  await writeFile(path.join(dir, "cq.toml"), '[ledger]\nbackend = "postgres"\nbackup = "none"\n', "utf8");
  return dir;
}

async function runCq(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await exec(process.execPath, ["run", CQ_MAIN, ...args], {
      cwd,
      env: { ...process.env, CQ_LEDGER_PG_URL: PG_URL },
    });
    return { stdout, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; code?: number };
    return { stdout: err.stdout ?? "", exitCode: err.code ?? 1 };
  }
}

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("cq predicates/counts/advance-gate over backend='postgres' (T579)", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  describe("cq predicates/counts/advance-gate over backend='postgres' (T579)", () => {
    it("predicates --cwd <pg repo> emits valid JSON", async () => {
      const dir = await postgresRepo();
      const { stdout, exitCode } = await runCq(["predicates", "--cwd", dir], dir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { predicates: Record<string, unknown> };
      expect(parsed.predicates).toBeDefined();
      expect(parsed.predicates["pImplement"]).toBeDefined();
    });

    it("counts --cwd <pg repo> emits valid JSON naming the canonical ledgers", async () => {
      const dir = await postgresRepo();
      const { stdout, exitCode } = await runCq(["counts", "--cwd", dir], dir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { ledgers: string[]; counts: Record<string, number> };
      expect(parsed.ledgers).toContain("tasks");
      expect(parsed.ledgers).toContain("milestones");
      expect(typeof parsed.counts["tasks"]).toBe("number");
    });

    it("advance-gate --cwd <pg repo> emits a valid verdict JSON and allows on a fresh tenant", async () => {
      const dir = await postgresRepo();
      const { stdout, exitCode } = await runCq(["advance-gate", "--cwd", dir], dir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { block: boolean; reason: string; predicates: unknown };
      expect(parsed.block).toBe(false);
      expect(typeof parsed.reason).toBe("string");
      expect(parsed.predicates).toBeDefined();
    });
  });
}
