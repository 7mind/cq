/**
 * Shared port-management helpers for ledger-tui test harnesses.
 *
 * freePort() — bind :0 on loopback, read the OS-assigned port, close the
 * listener. Has a theoretical TOCTOU window, but across repeated test runs
 * eliminates the fixed-port collision that causes intermittent "Unable to
 * connect" failures.
 *
 * waitForPort() — TCP-connect loop: waits until the target port accepts a
 * connection, proving the server's socket layer is live (not merely that the
 * HTTP handler has responded to one GET).
 */

import * as net from "node:net";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") return reject(new Error("no port"));
      const p = addr.port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

export async function waitForPort(p: number, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>((res) => {
      const s = net.connect(p, "127.0.0.1");
      s.on("connect", () => {
        s.end();
        res(true);
      });
      s.on("error", () => res(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server not up on ${p}`);
}
