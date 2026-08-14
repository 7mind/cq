import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStrictInMemoryWorksetEffectAdmissionProvider,
  readProcessIdentity,
} from "@cq/process-control";
import {
  launchPiChild,
  launchPiChildWithDependencies,
} from "./cq-subagent-dispatch/cq-subagent-process-lifecycle.ts";

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

describe("Pi child process lifecycle [Behavioral-Active Blackbox Good-Communication]", () => {
  test("a replacement refusal prevents the Pi process from being created", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-pi-child-workset-refusal-"));
    const marker = join(root, "target-ran");
    try {
      await expect(
        launchPiChild(
          [
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ],
          root,
          process.env,
          undefined,
          {
            provider: {
              acquire: async () => {
                throw new Error("replacement committed before Pi admission");
              },
            },
            targetRef: "tasks:T1983",
          },
        ),
      ).rejects.toThrow("replacement committed before Pi admission");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an immediate target exit cannot hide its same-group descendant from ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-pi-child-immediate-exit-"));
    const marker = join(root, "descendant-pid");
    let registrations = 0;
    const strict = createStrictInMemoryWorksetEffectAdmissionProvider();

    try {
      const launched = await launchPiChildWithDependencies(
        [process.execPath, "run", fixture, marker, "immediate-exit"],
        root,
        process.env,
        undefined,
        {
          targetRef: "tasks:T1983",
          provider: {
            acquire: async (input) => {
              const handle = await strict.acquire(input);
              return {
                ...handle,
                registerProcessGroup: async (registration) => {
                  registrations += 1;
                  await Bun.sleep(75);
                  await handle.registerProcessGroup(registration);
                },
              };
            },
          },
        },
      );
      await launched.exited;
      await waitForFile(marker);
      const descendantPid = Number.parseInt((await readFile(marker, "utf8")).trim(), 10);

      expect(registrations).toBe(1);
      expect(launched.registration.leader.startTime).not.toBe("");
      await waitForIdentityToDisappear(launched.registration.leader.pid);
      await waitForIdentityToDisappear(descendantPid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an abort settles an ignoring target and same-group descendant", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-pi-child-abort-"));
    const marker = join(root, "descendant-pid");
    const controller = new AbortController();
    const provider = createStrictInMemoryWorksetEffectAdmissionProvider();

    try {
      const launched = await launchPiChild(
        [process.execPath, "run", fixture, marker, "persistent"],
        root,
        process.env,
        controller.signal,
        { provider, targetRef: "tasks:T1983" },
      );
      await waitForFile(marker);
      const descendantPid = Number.parseInt((await readFile(marker, "utf8")).trim(), 10);
      let replacementAcknowledged = false;
      const replacement = provider.waitForIdle().then(() => {
        replacementAcknowledged = true;
      });
      await Bun.sleep(25);
      expect(replacementAcknowledged).toBe(false);
      controller.abort();

      expect(await launched.exited).toBe(0);
      await replacement;
      await waitForIdentityToDisappear(launched.process.pid!);
      await waitForIdentityToDisappear(descendantPid);
      expect(provider.events()).toEqual([
        "admission-acquired",
        "process-group-registered",
        "guardian-shared",
        "process-group-settled",
        "guardian-released",
        "admission-released",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("abort and target exit join one settlement promise before output completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-pi-child-settlement-"));
    const controller = new AbortController();
    let settlements = 0;
    let finishSettlement: () => void = () => {
      throw new Error("settlement did not start");
    };
    const provider = createStrictInMemoryWorksetEffectAdmissionProvider();

    try {
      const launched = await launchPiChildWithDependencies(
        [process.execPath, "-e", "setTimeout(() => process.exit(0), 30)"],
        root,
        process.env,
        controller.signal,
        {
          provider,
          targetRef: "tasks:T1983",
          settleRegisteredDescendants: async () => {
            settlements += 1;
            return new Promise((resolve) => {
              finishSettlement = () => resolve();
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
      finishSettlement();

      expect(await launched.exited).toBe(0);
      expect(settlements).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("registration failure prevents target execution and settles the fenced group", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-pi-child-registration-failure-"));
    const marker = join(root, "target-ran");
    let leaderPid: number | undefined;
    const strict = createStrictInMemoryWorksetEffectAdmissionProvider();

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
            targetRef: "tasks:T1983",
            provider: {
              acquire: async (input) => {
                const handle = await strict.acquire(input);
                return {
                  ...handle,
                  registerProcessGroup: (candidate) => {
                    leaderPid = candidate.leaderPid;
                    throw new Error("controlled Pi registration refusal");
                  },
                };
              },
            },
          },
        ),
      ).rejects.toThrow("controlled Pi registration refusal");
      if (leaderPid === undefined) throw new Error("registration failure was not observed");
      await waitForIdentityToDisappear(leaderPid);
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
          {
            provider: createStrictInMemoryWorksetEffectAdmissionProvider(),
            targetRef: "tasks:T1983",
          },
        ),
      ).rejects.toThrow("target launch failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
