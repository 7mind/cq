import type { Logger } from "./log/logger";
import indexHtml from "../../web/index.html" with { type: "html" };

export type DevServerConfig = Readonly<{
  host: string;
  port: number;
  cwd: string;
  dbPath: string;
  logger: Logger;
}>;

export type RunningDevServer = {
  stop(): void | Promise<void>;
  readonly url: URL;
  readonly development: boolean;
};

/**
 * Injectable serve function type — matches the Bun.serve signature for our use.
 * The default is Bun.serve. Tests may inject a stub to capture options.
 */
export type ServeFunction = typeof Bun.serve;

export function startDevServer(
  config: DevServerConfig,
  serve: ServeFunction = Bun.serve,
): RunningDevServer {
  const { host, port, cwd, dbPath, logger } = config;

  const server = serve({
    hostname: host,
    port,
    development: { hmr: true, console: true },
    routes: {
      "/": indexHtml,
    },
  });

  logger.info("cq dev listening", { host, port, cwd, dbPath, hmr: true });

  return {
    stop() {
      return server.stop();
    },
    get url() {
      return server.url;
    },
    get development() {
      return server.development;
    },
  };
}
