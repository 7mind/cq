import path from "node:path";
import fs from "node:fs/promises";
import type { Logger } from "./log/logger";

export type ServerConfig = Readonly<{
  host: string;
  port: number;
  webOutdir: string;
  cwd: string;
  dbPath: string;
  logger: Logger;
}>;

export type RunningServer = {
  stop(): void | Promise<void>;
};

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const { host, port, webOutdir, cwd, dbPath, logger } = config;

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // Serve index.html for root or unknown paths
      if (pathname === "/" || pathname === "") {
        const indexPath = path.join(webOutdir, "index.html");
        try {
          const content = await fs.readFile(indexPath, "utf8");
          return new Response(content, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      }

      // Serve static files from webOutdir
      const filePath = path.join(webOutdir, pathname.replace(/^\//, ""));
      try {
        const file = Bun.file(filePath);
        const exists = await file.exists();
        if (!exists) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(file);
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  });

  logger.info("cq listening", { host, port, cwd, dbPath });

  return {
    stop() {
      server.stop();
    },
  };
}
