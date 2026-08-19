/**
 * T723/R823 remote-backend fallthrough regressions.
 *
 * Constructive taxonomy: Behavioral-Active Blackbox-Atomic. Each case drives
 * a public production entry point and observes that no local persistence path
 * receives a construction or mutation before the remote client is wired.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createLedgerStore } from "@cq/ledger";
import {
  dispatch,
  type ConfirmIo,
  type DispatchIo,
} from "../src/main.js";
import {
  parseLogPutArgs,
  runLogPut,
  type LogPutIo,
} from "../src/logPut.js";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) =>
      rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});

async function makeRemoteRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `cq-remote-${label}-`));
  dirs.push(root);
  await writeFile(
    path.join(root, "cq.toml"),
    `[ledger]
backend = "remote"
serverUrl = "https://ledger.example.test"
projectId = "${label}"
`,
    "utf8",
  );
  return root;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function recordingDispatchIo(): DispatchIo & {
  readonly outs: string[];
  readonly errs: string[];
} {
  const outs: string[] = [];
  const errs: string[] = [];
  const confirm: ConfirmIo = {
    isTty: false,
    out: (line) => outs.push(line),
    err: (line) => errs.push(line),
    prompt: async () => "",
  };
  return {
    outs,
    errs,
    out: (line) => outs.push(line),
    err: (line) => errs.push(line),
    confirm,
  };
}

describe("backend='remote' fails before local persistence (T723/R823)", () => {
  it("createLedgerStore refuses before constructing an XDG/SQLite store", async () => {
    const root = await makeRemoteRoot("store-fail-fast");
    const xdgHome = await mkdtemp(path.join(tmpdir(), "cq-remote-xdg-"));
    dirs.push(xdgHome);
    const originalXdgStateHome = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = xdgHome;

    let resolved: Awaited<ReturnType<typeof createLedgerStore>> | undefined;
    let error: unknown;
    try {
      resolved = await createLedgerStore(root);
    } catch (caught) {
      error = caught;
    } finally {
      await resolved?.store.dispose();
      if (originalXdgStateHome === undefined) {
        delete process.env["XDG_STATE_HOME"];
      } else {
        process.env["XDG_STATE_HOME"] = originalXdgStateHome;
      }
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /backend = 'remote'.*remote ledger client.*not wired.*local persistence/is,
    );
    expect(await readdir(xdgHome)).toEqual([]);
    expect(await exists(path.join(root, ".cq"))).toBe(false);
  });

  it("runLogPut refuses before reading input or writing an fs log", async () => {
    const root = await makeRemoteRoot("log-fail-fast");
    let readCount = 0;
    const io: LogPutIo = {
      out: () => undefined,
      err: () => undefined,
      readStdin: async () => {
        readCount += 1;
        return '{"event":"must-not-write"}\n';
      },
    };
    const args = parseLogPutArgs(root, [
      "--stdin",
      "--dest",
      "logs/raw/remote.jsonl",
    ]);

    let error: unknown;
    try {
      await runLogPut(args, io);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/CQ_LEDGER_REMOTE_TOKEN/);
    expect(readCount).toBe(1);
    expect(await exists(path.join(root, ".cq"))).toBe(false);
  });

  it("cq erase refuses before deleting local artifacts or cq.toml", async () => {
    const root = await makeRemoteRoot("erase-fail-fast");
    const configPath = path.join(root, "cq.toml");
    const sentinelPath = path.join(root, ".cq", "logs", "raw", "sentinel.md");
    await mkdir(path.dirname(sentinelPath), { recursive: true });
    await writeFile(sentinelPath, "must survive\n", "utf8");
    const configBefore = await readFile(configPath, "utf8");
    const io = recordingDispatchIo();

    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);

    expect(outcome.exitCode).toBe(2);
    expect(io.errs.join("\n")).toMatch(/CQ_LEDGER_REMOTE_TOKEN|outcome-unknown|NOT erased/);
    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect(await readFile(sentinelPath, "utf8")).toBe("must survive\n");
  });
});
