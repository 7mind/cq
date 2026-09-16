import { describe, expect, test } from "bun:test";
import { postgresEvidenceFromJunit, requirePostgresCases } from "../bench/postgresRequiredEvidence.js";
import { runPostgresRequiredGate, type PostgresRequiredServices } from "../bench/postgresRequiredGate.js";

function report(body: string, count: number): string {
  return `<?xml version="1.0"?><testsuites tests="${count}"><testsuite name="mixed">${body}</testsuite></testsuites>`;
}

const inapplicableCells = [
  {
    file: "packages/ledger/test/backup-exporter.test.ts",
    suite: "backup exporter — T582 public postgres backend retired (T736)",
    reason: "retired-public-backend" as const,
    names: [
      'backup="in-tree": a mutation produces a parseable .cq/ dump carrying every tenant log artifact byte-identically',
      'backup="orphan-branch": the dump lands as a commit on the configured ref with the same tenant .cq/logs/** bytes',
      "default config (backup=none): NOTHING is written in-tree or to any ref; no scheduler is constructed",
    ],
  },
  {
    file: "packages/ledger-tui/test/embeddedPostgres.test.tsx",
    suite: "embedded ledger-tui over backend='postgres' retired (T736)",
    reason: "retired-public-backend" as const,
    names: [
      "McpLedgerClient.embedded resolves backend='postgres' with a live pg handle",
      "<App> renders against the postgres-backed embedded store — lists the canonical ledgers",
      "<App> creates an item through the postgres store and shows it in the list",
    ],
  },
  {
    file: "packages/ledger/test/create-ledger-store-project-identity.test.ts",
    suite: "live PostgreSQL exclusion retired with public backend (T736)",
    reason: "retired-public-backend" as const,
    names: ["does not write XDG identity metadata for a successful PostgreSQL open"],
  },
  {
    file: "packages/ledger/test/remote-ledger-client-contract.test.ts",
    suite: "RemoteLedgerClient contract — real cq serve/PostgreSQL hub (Behavioral-Active Blackbox-GoodCommunication)",
    reason: "dummy-only-protocol-control" as const,
    names: [
      "fails loud with RemoteProtocolError when the service negotiates an unsupported protocol version",
      "fails loud with RemoteMalformedResponseError on a malformed tool result, then recovers",
    ],
  },
].flatMap(({ names, ...identity }) => names.map((name) => ({ ...identity, name })));

function cellXml(cell: { file: string; suite: string; name: string }, outcome: string): string {
  const encode = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&apos;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<testsuite name="${encode(cell.suite)}" file="${encode(cell.file)}"><testcase name="${encode(cell.name)}">${outcome}</testcase></testsuite>`;
}

describe("PostgreSQL required-wrapper evidence [T5916 Behavioral-Active Blackbox-Atomic]", () => {
  test("Q406 reports exactly the nine approved inapplicable cells separately from executed cases", () => {
    const xml = report('<testcase name="real PostgreSQL" />' + inapplicableCells.map((cell) => cellXml(cell, "<skipped />")).join(""), 10);
    expect(postgresEvidenceFromJunit(xml)).toEqual({ cases: 10, postgresCases: 1, postgresSkipped: 0, postgresInapplicable: inapplicableCells });
    expect(() => postgresEvidenceFromJunit(report(inapplicableCells.map((cell) => cellXml(cell, "<skipped />")).join(""), 9))).toThrow("no valid PostgreSQL");
  });

  test("Q406 does not exempt another file, suite, case, environmental skip, or failed control", () => {
    for (const cell of inapplicableCells) {
      for (const altered of [{ ...cell, file: "packages/ledger/test/other-postgres.test.ts" }, { ...cell, suite: cell.suite + " changed" }, { ...cell, name: cell.name + " changed" }]) {
        expect(() => postgresEvidenceFromJunit(report('<testcase name="real PostgreSQL" />' + cellXml(altered, "<skipped />"), 2))).toThrow("skipped 1");
      }
      expect(() => postgresEvidenceFromJunit(report(cellXml(cell, "<failure />"), 1))).toThrow("failed testcase");
      expect(() => postgresEvidenceFromJunit(report(cellXml(cell, ""), 1))).toThrow("inapplicable PostgreSQL cell executed");
    }
    expect(() => postgresEvidenceFromJunit(report('<testcase name="PostgreSQL requires CQ_TEST_PG_URL"><skipped /></testcase>', 1))).toThrow("skipped 1");
  });

  test("Q406 rejects omitted, unapproved, duplicated, or overlapping inapplicable JSON evidence", () => {
    const cell = inapplicableCells[0]!;
    const evidence = { cases: 2, postgresCases: 1, postgresSkipped: 0, postgresInapplicable: [cell] };
    expect(requirePostgresCases(evidence)).toEqual(evidence);
    expect(() => requirePostgresCases(JSON.parse('{"cases":1,"postgresCases":1,"postgresSkipped":0}'))).toThrow("report inapplicable cells explicitly");
    expect(() => requirePostgresCases({ ...evidence, postgresInapplicable: [{ ...cell, name: "unapproved" }] })).toThrow("unapproved");
    expect(() => requirePostgresCases({ ...evidence, postgresInapplicable: [{ ...cell, reason: "dummy-only-protocol-control" }] })).toThrow("unapproved");
    expect(() => requirePostgresCases({ ...evidence, postgresInapplicable: [cell, cell] })).toThrow("duplicate");
    expect(() => requirePostgresCases({ ...evidence, cases: 1 })).toThrow("no valid PostgreSQL");
    expect(() => requirePostgresCases({ ...evidence, postgresSkipped: 1 })).toThrow("skipped 1");
    expect(() => postgresEvidenceFromJunit(report('<testcase name="real PostgreSQL" />' + cellXml(cell, "<skipped />").repeat(2), 3))).toThrow("duplicate");
  });

  test("counts PostgreSQL ancestry and file identities without counting an unrelated skip", () => {
    const xml = report(`<testsuite name="real PostgreSQL"><testsuite name="claim cases"><testcase name="claims" /></testsuite></testsuite>
      <testcase name="private writes" file="postgres-schema.test.ts" /><testcase name="offline control"><skipped /></testcase>`, 3);
    expect(postgresEvidenceFromJunit(xml)).toEqual({ cases: 3, postgresCases: 2, postgresSkipped: 0, postgresInapplicable: [] });
  });

  test("fails closed for skipped PostgreSQL cases, zero execution, failures, and truncated reports", () => {
    expect(() => postgresEvidenceFromJunit(report('<testcase name="PostgreSQL"><skipped /></testcase>', 1))).toThrow("skipped 1");
    expect(() => postgresEvidenceFromJunit(report('<testcase name="SQLite" />', 1))).toThrow("no valid PostgreSQL");
    expect(() => postgresEvidenceFromJunit(report('<testcase name="PostgreSQL"><failure /></testcase>', 1))).toThrow("failed testcase");
    expect(() => postgresEvidenceFromJunit(report('<testcase name="PostgreSQL" />', 2))).toThrow("inconsistent counts");
    expect(() => postgresEvidenceFromJunit(report('<testcase name="PostgreSQL" />', 1).replace('</testsuites>', ''))).toThrow("incomplete");
    expect(() => requirePostgresCases({ cases: 1, postgresCases: 2, postgresSkipped: 0, postgresInapplicable: [] })).toThrow("no valid PostgreSQL");
    expect(() => postgresEvidenceFromJunit(report('<testcase name="PostgreSQL wrapper [Blackbox-Atomic]" />', 1))).toThrow("no valid PostgreSQL");
  });

  test("does not read test identities from comments or CDATA and preserves quoted angle brackets", () => {
    const xml = report(`<!-- <testcase name="PostgreSQL" /> -->
      <testcase name="PostgreSQL x > y"><system-out><![CDATA[<testcase name="fake" />]]></system-out></testcase>`, 1);
    expect(postgresEvidenceFromJunit(xml)).toEqual({ cases: 1, postgresCases: 1, postgresSkipped: 0, postgresInapplicable: [] });
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
    const result = await runPostgresRequiredGate(["bun", "test", "selected.test.ts"], process.cwd(), { CQ_SERVE_TOKEN: "do-not-forward" }, services, { taskOnly: false });
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
    expect(result.full?.postgresCases).toBe(1);
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
    }, { taskOnly: false })).rejects.toThrow("skipped 1");
    expect(commands).toBe(1);
    expect(closed).toBe(true);
  });

  test("the standalone bounds protocol must report nonzero cases before the automatic full stage", async () => {
    let commands = 0;
    const result = await runPostgresRequiredGate(["bun", "run", "check:postgres-lifecycle-bounds"], process.cwd(), {}, {
      openCluster: async () => ({ dsn: "postgresql://fixture/test", ownership: "provided", close: async () => {} }),
      run: async (_command, _cwd, env) => {
        commands++;
        if (commands === 1) await Bun.write(env.CQ_TEST_PG_REPORT_JSON!, JSON.stringify({ cases: 20, postgresCases: 20, postgresSkipped: 0, postgresInapplicable: [] }));
        else await Bun.write(env.CQ_TEST_JUNIT_PATH!, report('<testcase name="PostgreSQL" />', 1));
        return 0;
      },
    }, { taskOnly: false });
    expect(commands).toBe(2);
    expect(result.task.postgresCases).toBe(20);
  });

  test("task-only mode validates live PostgreSQL evidence without running the full check", async () => {
    const calls: string[][] = [];
    const result = await runPostgresRequiredGate(
      ["bun", "test", "packages/ledger/test/workset-generic-mutation-postgres.test.ts"],
      process.cwd(),
      {},
      {
        openCluster: async () => ({
          dsn: "postgresql://fixture/test",
          ownership: "provided",
          close: async () => {},
        }),
        run: async (command) => {
          calls.push([...command]);
          const path = command
            .find((argument) => argument.startsWith("--reporter-outfile="))
            ?.slice("--reporter-outfile=".length);
          if (path === undefined) throw new Error("task-only run requires a JUnit path");
          await Bun.write(path, report('<testcase name="real PostgreSQL semantic case" />', 1));
          return 0;
        },
      },
      { taskOnly: true },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toEqual([process.execPath, "run", "check"]);
    expect(result.mode).toBe("task-only");
    expect(result.task.postgresCases).toBe(1);
    expect(result.full).toBeNull();
  });
});
