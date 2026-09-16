import { runPostgresRequiredGate } from "./postgresRequiredGate.js";
import { openPostgresTestCluster } from "./postgresTestCluster.js";
import { runPostgresRequiredCommand } from "./postgresRequiredCommand.js";

const abort = new AbortController();
const stop = () => abort.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const run = (command: readonly string[], cwd: string, environment: NodeJS.ProcessEnv) =>
  runPostgresRequiredCommand(command, cwd, environment, abort.signal);
const cleanup = (command: readonly string[], cwd: string, environment: NodeJS.ProcessEnv) =>
  runPostgresRequiredCommand(command, cwd, environment, null);

try {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const taskOnly = args[0] === "--task-only";
  if (taskOnly) args.shift();
  const report = await runPostgresRequiredGate(args, process.cwd(), { ...process.env }, {
    run, openCluster: (environment) => openPostgresTestCluster(environment, run, cleanup),
  }, { taskOnly });
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : "required PostgreSQL gate failed");
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
