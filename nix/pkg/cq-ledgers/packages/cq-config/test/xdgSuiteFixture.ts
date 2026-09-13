import { afterAll, beforeAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function useIsolatedXdgSuite(settle: () => Promise<void>): void {
  let previous: string | undefined;
  let stateHome: string;
  beforeAll(async () => {
    previous = process.env["XDG_STATE_HOME"];
    stateHome = await mkdtemp(join(tmpdir(), "cq-attestation-xdg-"));
    process.env["XDG_STATE_HOME"] = stateHome;
  });
  afterAll(async () => {
    try {
      await settle();
    } finally {
      if (previous === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previous;
      await rm(stateHome, { recursive: true, force: true });
    }
  });
}
