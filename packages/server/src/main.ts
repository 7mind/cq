import { parseArgs } from "./args";
import { buildWeb } from "./buildWeb";
import { startServer } from "./server";
import { startDevServer } from "./devServer";
import { createLogger } from "./log/logger";

const args = parseArgs(process.argv.slice(2));

const logger = createLogger();

let stop: () => void | Promise<void>;

if (args.dev) {
  const devServer = startDevServer({
    host: args.host,
    port: args.port,
    cwd: args.cwd,
    dbPath: args.db,
    logger,
  });
  stop = () => devServer.stop();
} else {
  const { outdir } = await buildWeb();

  const server = await startServer({
    host: args.host,
    port: args.port,
    webOutdir: outdir,
    cwd: args.cwd,
    dbPath: args.db,
    logger,
  });
  stop = () => server.stop();
}

function shutdown(): void {
  const result = stop();
  if (result instanceof Promise) {
    result.then(() => process.exit(0)).catch(() => process.exit(1));
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
