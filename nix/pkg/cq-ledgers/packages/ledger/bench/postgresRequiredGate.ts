import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { postgresEvidenceFromJunit, requirePostgresCases, type PostgresCaseEvidence } from "./postgresRequiredEvidence.js";

export interface PostgresTestCluster {
  readonly dsn: string;
  readonly ownership: "provided" | "disposable";
  close(): Promise<void>;
}

export interface PostgresRequiredServices {
  openCluster(environment: NodeJS.ProcessEnv): Promise<PostgresTestCluster>;
  run(command: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<number>;
}

export interface PostgresRequiredReport {
  readonly status: "pass";
  readonly mode: "task-only" | "task-and-full";
  readonly dsnFingerprint: string;
  readonly clusterOwnership: PostgresTestCluster["ownership"];
  readonly task: PostgresCaseEvidence;
  readonly full: PostgresCaseEvidence | null;
}

export interface PostgresRequiredOptions {
  readonly taskOnly: boolean;
}

export async function runPostgresRequiredGate(command: readonly string[], cwd: string,
  environment: NodeJS.ProcessEnv, services: PostgresRequiredServices,
  options: PostgresRequiredOptions): Promise<PostgresRequiredReport> {
  if (command.length === 0) throw new Error("check:postgres-required requires a task command after --");
  const reports = await mkdtemp(join(tmpdir(), "cq-postgres-required-reports-"));
  let cluster: PostgresTestCluster | null = null;
  try {
    cluster = await services.openCluster(environment);
    const childEnvironment: NodeJS.ProcessEnv = { ...environment, CQ_TEST_PG_URL: cluster.dsn, CQ_TEST_REQUIRE_PG: "1" };
    for (const key of ["CQ_SERVE_TOKEN", "CQ_SERVE_MANAGEMENT_TOKEN", "CQ_LEDGER_REMOTE_TOKEN"]) delete childEnvironment[key];
    const taskIsBunTest = basename(command[0]!) === "bun" && command[1] === "test";
    const taskReport = join(reports, taskIsBunTest ? "task.xml" : "task.json");
    const taskCommand = taskIsBunTest ? [...command, "--reporter=junit", `--reporter-outfile=${taskReport}`] : command;
    const taskExit = await services.run(taskCommand, cwd, { ...childEnvironment, CQ_TEST_PG_REPORT_JSON: taskReport });
    if (taskExit !== 0) throw new Error(`required PostgreSQL task command exited ${taskExit}`);
    const task = taskIsBunTest ? postgresEvidenceFromJunit(await readFile(taskReport, "utf8"))
      : requirePostgresCases(JSON.parse(await readFile(taskReport, "utf8")) as PostgresCaseEvidence);
    const common = {
      status: "pass" as const,
      dsnFingerprint: createHash("sha256").update(cluster.dsn).digest("hex"),
      clusterOwnership: cluster.ownership,
      task,
    };
    if (options.taskOnly) {
      return { ...common, mode: "task-only", full: null };
    }
    const fullReport = join(reports, "full.xml");
    const fullExit = await services.run([process.execPath, "run", "check"], cwd,
      { ...childEnvironment, CQ_TEST_JUNIT_PATH: fullReport });
    if (fullExit !== 0) throw new Error(`required PostgreSQL full check exited ${fullExit}`);
    const full = postgresEvidenceFromJunit(await readFile(fullReport, "utf8"));
    return { ...common, mode: "task-and-full", full };
  } finally {
    try { if (cluster !== null) await cluster.close(); }
    finally { await rm(reports, { recursive: true, force: true }); }
  }
}
