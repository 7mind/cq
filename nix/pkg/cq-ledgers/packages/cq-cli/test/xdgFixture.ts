import { afterEach, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function useIsolatedXdgState(): void {
  let previous: string | undefined;
  let stateDir: string;
  beforeEach(async () => {
    previous = process.env["XDG_STATE_HOME"];
    stateDir = await mkdtemp(join(tmpdir(), "cq-cli-xdg-state-"));
    process.env["XDG_STATE_HOME"] = stateDir;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = previous;
    await rm(stateDir, { recursive: true, force: true });
  });
}

export async function writeXdgConfig(root: string): Promise<string> {
  const projectId = "cq-cli-" + randomUUID();
  await writeFile(join(root, "cq.toml"), `[ledger]\nbackend = "xdg"\nprojectId = "${projectId}"\n`);
  return projectId;
}
