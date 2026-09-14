import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostgresRequiredServices, PostgresTestCluster } from "./postgresRequiredGate.js";

type RunCommand = PostgresRequiredServices["run"];

async function validateDsn(dsn: string): Promise<void> {
  const url = new URL(dsn);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("CQ_TEST_PG_URL must be a PostgreSQL DSN");
  const pool = new SQL({ url: dsn, max: 1, connectionTimeout: 5 });
  try { await pool`SELECT 1`; }
  catch { throw new Error("required PostgreSQL database is unreachable"); }
  finally { await pool.close(); }
}

export async function openPostgresTestCluster(environment: NodeJS.ProcessEnv, run: RunCommand, cleanup: RunCommand): Promise<PostgresTestCluster> {
  const supplied = environment.CQ_TEST_PG_URL;
  if (supplied !== undefined) {
    if (supplied.length === 0) throw new Error("CQ_TEST_PG_URL must not be empty");
    await validateDsn(supplied);
    return { dsn: supplied, ownership: "provided", close: async () => {} };
  }
  const configuredBin = environment.CQ_TEST_POSTGRES_BIN;
  if (configuredBin === "") throw new Error("CQ_TEST_POSTGRES_BIN must not be empty");
  const executable = (name: string) => {
    let resolved: string | null;
    if (configuredBin === undefined) {
      const path = environment.PATH;
      if (path === undefined) throw new Error("PATH is required when CQ_TEST_POSTGRES_BIN is absent");
      resolved = Bun.which(name, { PATH: path });
    } else resolved = Bun.which(join(configuredBin, name));
    if (resolved === null) throw new Error(`${name} is required; set CQ_TEST_POSTGRES_BIN to an installed PostgreSQL bin directory`);
    return resolved;
  };
  const initdb = executable("initdb");
  const pgctl = executable("pg_ctl");
  const root = await mkdtemp(join(tmpdir(), "cq-postgres-required-cluster-"));
  const data = join(root, "data");
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  const port = reservation.port;
  reservation.stop(true);
  let started = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    if (started) {
      const status = await cleanup([pgctl, "-D", data, "status"], root, environment);
      if (status === 0 && await cleanup([pgctl, "-D", data, "-m", "fast", "-w", "-t", "30", "stop"], root, environment) !== 0) {
        throw new Error(`could not stop owned PostgreSQL cluster at ${root}; retained its data`);
      }
      if (status !== 0 && status !== 3) throw new Error(`could not inspect owned PostgreSQL cluster at ${root}; retained its data`);
      started = false;
    }
    await rm(root, { recursive: true, force: true });
    closed = true;
  };
  try {
    if (await run([initdb, "-D", data, "--username=cq", "--auth=trust", "--encoding=UTF8", "--no-locale"], root, environment) !== 0) {
      throw new Error("could not initialize disposable PostgreSQL cluster");
    }
    started = true;
    if (await run([pgctl, "-D", data, "-l", join(root, "postgres.log"), "-o", `-F -h 127.0.0.1 -p ${port} -k ${root}`, "-w", "-t", "30", "start"], root, environment) !== 0) {
      throw new Error(`could not start disposable PostgreSQL cluster at ${root}`);
    }
    const dsn = `postgresql://cq@127.0.0.1:${port}/postgres?sslmode=disable`;
    await validateDsn(dsn);
    return { dsn, ownership: "disposable", close };
  } catch (error) { await close(); throw error; }
}
