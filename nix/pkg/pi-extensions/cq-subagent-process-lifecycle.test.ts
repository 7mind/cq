import { describe, expect, test } from "bun:test";
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
  launchPiChild,
  launchPiChildWithDependencies,
} from "./cq-subagent-process-lifecycle.ts";

const fixture = fileURLToPath(
  new URL("./cq-subagent-process-lifecycle-fixture.ts", import.meta.url),
);

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      if (attempt === 99) throw new Error(`lifecycle fixture did not create ${path}`);
      await Bun.sleep(2);
    }
  }
}

async function waitForIdentityToDisappear(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if ((await readProcessIdentity(pid)) === null) return;
    await Bun.sleep(2);
  }
  throw new Error(`test process ${pid} did not exit`);
}

describe("Pi child process lifecycle [BA]", () => {
  test("an immediate target exit cannot hide its same-group descendant from ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-pi-child-immediate-exit-"));
    const marker = join(root, "descendant-pid");
    const registrations: ProcessGroupRegistration[] = [];

    try {
      const launched = await launchPiChildWithDependencies(
        [process.execPath, "run", fixture, marker, "immediate-exit"],
        root,
        process.env,
        undefined,
        {
          publishRegistration: async (registration) => {
            registrations.push(registration);
            await Bun.sleep(75);
          },
          settleGroups: settleProcessGroups,
        },
      );
      await launched.exited;
      await waitForFile(marker);
      const descendantPid = Number.parseInt((await readFile(marker, "utf8")).trim(), 10);

      expect(registrations).toHaveLength(1);
      expect(registrations[0]!.leader.startTime).not.toBe("");
      await waitForIdentityToDisappear(registrations[0]!.leader.pid);
      await waitForIdentityToDisappear(descendantPid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an abort settles an ignoring target and same-group descendant", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-pi-child-abort-"));
    const marker = join(root, "descendant-pid");
    const controller = new AbortController();

    try {
      const launched = await launchPiChild(
        [process.execPath, "run", fixture, marker, "persistent"],
        root,
        process.env,
        controller.signal,
      );
      await waitForFile(marker);
      const descendantPid = Number.parseInt((await readFile(marker, "utf8")).trim(), 10);
      controller.abort();

      expect(await launched.exited).toBe(0);
      await waitForIdentityToDisappear(launched.process.pid!);
      await waitForIdentityToDisappear(descendantPid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("abort and target exit join one settlement promise before output completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-pi-child-settlement-"));
    const controller = new AbortController();
    let settlements = 0;
    let finishSettlement: (result: SettleProcessGroupsResult) => void = () => {
      throw new Error("settlement did not start");
    };

    try {
      const launched = await launchPiChildWithDependencies(
        [process.execPath, "-e", "setTimeout(() => process.exit(0), 30)"],
        root,
        process.env,
        controller.signal,
        {
          publishRegistration: async () => {},
          settleGroups: async () => {
            settlements += 1;
            return new Promise((resolve) => {
              finishSettlement = resolve;
            });
          },
        },
      );
      let completed = false;
      void launched.exited.then(() => {
        completed = true;
      });

      controller.abort();
      await Bun.sleep(75);
      expect(settlements).toBe(1);
      expect(completed).toBe(false);
      finishSettlement({ signaled: [launched.process.pid!], survivors: [] });

      expect(await launched.exited).toBe(0);
      expect(settlements).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("registration failure prevents target execution and settles the fenced group", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-pi-child-registration-failure-"));
    const marker = join(root, "target-ran");
    let registration: ProcessGroupRegistration | undefined;

    try {
      await expect(
        launchPiChildWithDependencies(
          [
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ],
          root,
          process.env,
          undefined,
          {
            publishRegistration: async (candidate) => {
              registration = candidate;
              throw new Error("controlled Pi registration refusal");
            },
            settleGroups: settleProcessGroups,
          },
        ),
      ).rejects.toThrow("controlled Pi registration refusal");
      if (registration === undefined) throw new Error("registration failure was not observed");
      await waitForIdentityToDisappear(registration.leader.pid);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("target launch failure propagates after fenced-group cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-pi-child-target-failure-"));
    try {
      await expect(
        launchPiChild(
          [join(root, "executable-does-not-exist")],
          root,
          process.env,
          undefined,
        ),
      ).rejects.toThrow("target launch failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
