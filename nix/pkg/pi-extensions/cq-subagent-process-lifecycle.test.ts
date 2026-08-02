import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readProcessIdentity,
  settleProcessGroups,
  type ProcessGroupRegistration,
  type SettleProcessGroupsResult,
} from "@cq/process-control";
import {
  waitForPiChild,
  waitForPiChildWithDependencies,
} from "./cq-subagent-process-lifecycle.ts";

const REGISTRATION: ProcessGroupRegistration = {
  pgid: 42001,
  leader: { pid: 42001, startTime: "100" },
};

class FakeChild extends EventEmitter {
  readonly pid = REGISTRATION.pgid;
}

function asChild(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Pi child process lifecycle [BA]", () => {
  test("SIGTERM delivery does not count as exit and settlement remains joined", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    let finishSettlement: (result: SettleProcessGroupsResult) => void = () => {
      throw new Error("settlement did not start");
    };
    let settlements = 0;
    const completion = waitForPiChildWithDependencies(asChild(child), controller.signal, {
      readIdentity: async () => REGISTRATION.leader,
      settleGroups: async () => {
        settlements += 1;
        return new Promise((resolve) => {
          finishSettlement = resolve;
        });
      },
    });
    let completed = false;
    void completion.then(() => {
      completed = true;
    });

    controller.abort();
    await flush();
    expect(settlements).toBe(1);
    expect(completed).toBe(false);

    child.emit("close", null, "SIGKILL");
    await flush();
    expect(completed).toBe(false);
    finishSettlement({ signaled: [REGISTRATION.pgid], survivors: [] });

    expect(await completion).toBe(0);
    expect(settlements).toBe(1);
  });

  test("error records failure but only close completes and settlement runs once", async () => {
    const child = new FakeChild();
    let settlements = 0;
    const completion = waitForPiChildWithDependencies(asChild(child), undefined, {
      readIdentity: async () => REGISTRATION.leader,
      settleGroups: async () => {
        settlements += 1;
        return { signaled: [], survivors: [] };
      },
    });
    let completed = false;
    void completion.then(() => {
      completed = true;
    });

    child.emit("error", new Error("spawn failure"));
    await flush();
    expect(settlements).toBe(1);
    expect(completed).toBe(false);
    child.emit("close", null, null);

    expect(await completion).toBe(1);
    expect(settlements).toBe(1);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });

  test("exit starts one settlement while close remains the output-completion boundary", async () => {
    const child = new FakeChild();
    let settlements = 0;
    const completion = waitForPiChildWithDependencies(asChild(child), undefined, {
      readIdentity: async () => REGISTRATION.leader,
      settleGroups: async () => {
        settlements += 1;
        return { signaled: [], survivors: [] };
      },
    });
    let completed = false;
    void completion.then(() => {
      completed = true;
    });

    child.emit("exit", 0, null);
    await flush();
    expect(settlements).toBe(1);
    expect(completed).toBe(false);
    child.emit("close", 0, null);

    expect(await completion).toBe(0);
    expect(settlements).toBe(1);
  });

  test("an ignoring root and its same-group descendant disappear after escalation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-pi-child-lifecycle-"));
    const marker = join(root, "descendant-pid");
    const fixture = fileURLToPath(
      new URL("./cq-subagent-process-lifecycle-fixture.ts", import.meta.url),
    );
    const child = spawn(process.execPath, ["run", fixture, marker], {
      detached: true,
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("lifecycle fixture did not return a pid");
    const leader = await readProcessIdentity(pid);
    if (leader === null) throw new Error("lifecycle fixture exited before identity observation");

    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await access(marker);
          break;
        } catch {
          if (attempt === 99) throw new Error("lifecycle fixture did not become ready");
          await Bun.sleep(2);
        }
      }
      const descendantPid = Number.parseInt((await readFile(marker, "utf8")).trim(), 10);
      const descendant = await readProcessIdentity(descendantPid);
      if (descendant === null) throw new Error("fixture descendant exited before cancellation");

      const controller = new AbortController();
      const completion = waitForPiChild(child, controller.signal);
      controller.abort();
      expect(await completion).toBe(0);
      expect(await readProcessIdentity(pid)).toBeNull();
      expect(await readProcessIdentity(descendantPid)).toBeNull();
    } finally {
      await settleProcessGroups([{ pgid: pid, leader }]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
