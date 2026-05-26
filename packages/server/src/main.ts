import { parseArgs } from "./args";
import { buildWeb } from "./buildWeb";
import { startServer } from "./server";
import { createLogger } from "./log/logger";

const args = parseArgs(process.argv.slice(2));

const logger = createLogger();

const { outdir } = await buildWeb();

const server = await startServer({
  host: args.host,
  port: args.port,
  webOutdir: outdir,
  cwd: args.cwd,
  dbPath: args.db,
  logger,
});

function shutdown(): void {
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
