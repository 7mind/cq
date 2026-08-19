import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveRemoteLaunch } from "../src/store/remote/remoteLaunch.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function remoteRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "t733-"));
  dirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  await writeFile(
    path.join(dir, "cq.toml"),
    `[ledger]\nbackend = "remote"\nserverUrl = "http://127.0.0.1:5190"\nprojectId = "alpha"\n`,
  );
  return dir;
}

describe("T733/T734 resolveRemoteLaunch", () => {
  test("returns null for non-remote checkouts [BA]", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t733-local-"));
    dirs.push(dir);
    expect(await resolveRemoteLaunch(dir)).toBeNull();
  });

  test("derives /p/<key>/mcp and reads the env token [BA]", async () => {
    const dir = await remoteRepo();
    const target = await resolveRemoteLaunch(dir, { CQ_LEDGER_REMOTE_TOKEN: "secret-token" });
    expect(target).not.toBeNull();
    expect(target!.mcpUrl).toBe("http://127.0.0.1:5190/p/alpha/mcp");
    expect(target!.token).toBe("secret-token");
    expect(target!.projectKey).toBe("alpha");
  });
});
