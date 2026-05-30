import { parseInvocation } from "./args";
import { buildWeb } from "./buildWeb";
import { startServer } from "./server";
import { startDevServer } from "./devServer";
import { createLogger } from "./log/logger";
import { startGracefulShutdown } from "./shutdown";
import { runReset, defaultConfirm } from "./reset";

const invocation = parseInvocation(process.argv.slice(2));

if (invocation.kind === "reset") {
  // `cq reset` — back up / clear the regenerable bootstrap ledger files and
  // exit. Never starts a server.
  const { code } = await runReset(invocation.opts, {
    stdout: (s) => process.stdout.write(`${s}\n`),
    stderr: (s) => process.stderr.write(`${s}\n`),
    confirm: defaultConfirm,
    now: () => new Date().toISOString(),
    stdinIsTty: () => process.stdin.isTTY === true,
  });
  process.exit(code);
}

const args = invocation.args;

const logger = createLogger();

let shutdownFn: () => Promise<void>;

if (args.dev) {
  const devServer = await startDevServer({
    host: args.host,
    port: args.port,
    cwd: args.cwd,
    dbPath: args.db,
    logger,
  });
  shutdownFn = async () => {
    await devServer.stop();
  };
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

  shutdownFn = () =>
    startGracefulShutdown({
      server,
      persistence: server.persistence,
      bridge: server.bridge,
      workflow: server.workflow,
      logger,
      timeoutMs: args.shutdownTimeoutMs,
    });
}

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownFn()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("shutdown failed", err);
      process.exit(1);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
