import { describe, expect, test } from "bun:test";
import { postgresEvidenceFromJunit, requirePostgresCases } from "../bench/postgresRequiredEvidence.js";
import { runPostgresRequiredGate, type PostgresRequiredServices } from "../bench/postgresRequiredGate.js";

function report(body: string, count: number): string {
  return `<?xml version="1.0"?><testsuites tests="${count}"><testsuite name="mixed">${body}</testsuite></testsuites>`;
}

describe("PostgreSQL required-wrapper evidence [T5916 Behavioral-Active Blackbox-Atomic]", () => {
  test("counts PostgreSQL ancestry and file identities without counting an unrelated skip", () => {
    const xml = report(`<testsuite name="real PostgreSQL"><testsuite name="claim cases"><testcase name="claims" /></testsuite></testsuite>
      <testcase name="private writes" file="postgres-schema.test.ts" /><testcase name="offline control"><skipped /></testcase>`, 3);
    expect(postgresEvidenceFromJunit(xml)).toEqual({ cases: 3, postgresCases: 2, postgresSkipped: 0 });
  });

  test("fails closed for skipped PostgreSQL cases, zero execution, failures, and truncated reports", () => {
    expect(() => postgresEvidenceFromJunit(report('<testcase name="PostgreSQL"><skipped /></testcase>', 1))).toThrow("skipped 1");
    expect(() => postgresEvidenceFromJunit(report('<testcase name="SQLite" />', 1))).toThrow("no valid PostgreSQL");
    expect(() => postgresEvidenceFromJunit(report('<testcase name="PostgreSQL"><failure /></testcase>', 1))).toThrow("failed testcase");
    expect(() => postgresEvidenceFromJunit(report('<testcase name="PostgreSQL" />', 2))).toThrow("inconsistent counts");
    expect(() => postgresEvidenceFromJunit(report('<testcase name="PostgreSQL" />', 1).replace('</testsuites>', ''))).toThrow("incomplete");
    expect(() => requirePostgresCases({ cases: 1, postgresCases: 2, postgresSkipped: 0 })).toThrow("no valid PostgreSQL");
    expect(() => postgresEvidenceFromJunit(report('<testcase name="PostgreSQL wrapper [Blackbox-Atomic]" />', 1))).toThrow("no valid PostgreSQL");
  });

  test("does not read test identities from comments or CDATA and preserves quoted angle brackets", () => {
    const xml = report(`<!-- <testcase name="PostgreSQL" /> -->
      <testcase name="PostgreSQL x > y"><system-out><![CDATA[<testcase name="fake" />]]></system-out></testcase>`, 1);
    expect(postgresEvidenceFromJunit(xml)).toEqual({ cases: 1, postgresCases: 1, postgresSkipped: 0 });
  });

  test("shares one DSN and required flag across task/full stages and closes only its lease", async () => {
    const calls: { command: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    let opens = 0;
    let closes = 0;
    const dsn = "postgresql://fixture:opaque-password@localhost/test";
    const services: PostgresRequiredServices = {
      openCluster: async () => { opens++; return { dsn, ownership: "provided", close: async () => { closes++; } }; },
      run: async (command, _cwd, env) => {
        calls.push({ command, env });
        const path = calls.length === 1 ? command.find((arg) => arg.startsWith("--reporter-outfile="))?.split("=").slice(1).join("=") : env.CQ_TEST_JUNIT_PATH;
        expect(path).toBeDefined();
        await Bun.write(path!, report('<testcase name="real PostgreSQL operation" />', 1));
        return 0;
      },
    };
    const result = await runPostgresRequiredGate(["bun", "test", "selected.test.ts"], process.cwd(), { CQ_SERVE_TOKEN: "do-not-forward" }, services);
    expect(opens).toBe(1);
    expect(closes).toBe(1);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.env.CQ_TEST_PG_URL).toBe(dsn);
      expect(call.env.CQ_TEST_REQUIRE_PG).toBe("1");
      expect(call.env.CQ_SERVE_TOKEN).toBeUndefined();
    }
    expect(calls[1]!.command).toEqual([process.execPath, "run", "check"]);
    expect(result.task.postgresCases).toBe(1);
    expect(result.full.postgresCases).toBe(1);
    expect(JSON.stringify(result)).not.toContain("opaque-password");
  });

  test("a skipped task case prevents the full stage and still releases the lease", async () => {
    let commands = 0;
    let closed = false;
    await expect(runPostgresRequiredGate(["bun", "test", "selected.test.ts"], process.cwd(), {}, {
      openCluster: async () => ({ dsn: "postgresql://fixture/test", ownership: "disposable", close: async () => { closed = true; } }),
      run: async (command) => {
        commands++;
        const path = command.find((arg) => arg.startsWith("--reporter-outfile="))!.slice("--reporter-outfile=".length);
        await Bun.write(path, report('<testcase name="PostgreSQL"><skipped /></testcase>', 1));
        return 0;
      },
    })).rejects.toThrow("skipped 1");
    expect(commands).toBe(1);
    expect(closed).toBe(true);
  });

  test("the standalone bounds protocol must report nonzero cases before the automatic full stage", async () => {
    let commands = 0;
    const result = await runPostgresRequiredGate(["bun", "run", "check:postgres-lifecycle-bounds"], process.cwd(), {}, {
      openCluster: async () => ({ dsn: "postgresql://fixture/test", ownership: "provided", close: async () => {} }),
      run: async (_command, _cwd, env) => {
        commands++;
        if (commands === 1) await Bun.write(env.CQ_TEST_PG_REPORT_JSON!, JSON.stringify({ cases: 20, postgresCases: 20, postgresSkipped: 0 }));
        else await Bun.write(env.CQ_TEST_JUNIT_PATH!, report('<testcase name="PostgreSQL" />', 1));
        return 0;
      },
    });
    expect(commands).toBe(2);
    expect(result.task.postgresCases).toBe(20);
  });
});
