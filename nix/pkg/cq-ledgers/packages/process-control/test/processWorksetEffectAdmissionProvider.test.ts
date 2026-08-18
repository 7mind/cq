import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProcessWorksetEffectAdmissionProvider,
  readProcessIdentity,
} from "@cq/process-control";

const roots: string[] = [];
const fixture = fileURLToPath(
  new URL("./processWorksetEffectAdmissionProviderFixture.ts", import.meta.url),
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("process workset admission provider [Behavioral-Active Blackbox Good-Communication]", () => {
  test("D343 scaled external phases terminate and drain every expired provider-control exchange", async () => {
    const startedAt = Date.now();
    for (const delayedOperation of ["acquire", "register", "share"] as const) {
      const root = await mkdtemp(join(tmpdir(), `cq-d343-provider-${delayedOperation}-`));
      roots.push(root);
      const transcript = join(root, "transcript.jsonl");
      const pidPath = join(root, "provider.pid");
      const provider = createProcessWorksetEffectAdmissionProvider({
        command: process.execPath,
        args: ["run", fixture],
        cwd: root,
        env: {
          ...process.env,
          CQ_TEST_PROVIDER_TRANSCRIPT: transcript,
          CQ_TEST_PROVIDER_DELAY_OPERATION: delayedOperation,
          CQ_TEST_PROVIDER_DELAY_MS: "1200",
          CQ_TEST_PROVIDER_PID_PATH: pidPath,
        },
      });
      if (delayedOperation === "acquire") {
        await expect(
          provider.acquire({
            kind: "child-dispatch",
            targetRef: "tasks:T2228",
            launchDeadlineMs: Date.now() + 800,
          }),
        ).rejects.toThrow("provider-control acquire exchange");
      } else {
        const handle = await provider.acquire({
          kind: "child-dispatch",
          targetRef: "tasks:T2228",
        });
        if (delayedOperation === "register") {
          await expect(
            handle.registerProcessGroup({ pgid: 43210, leaderPid: 43210 }, Date.now() + 800),
          ).rejects.toThrow("provider-control register exchange");
        } else {
          await handle.registerProcessGroup({ pgid: 43210, leaderPid: 43210 });
          await expect(
            handle.shareWithGuardian({ pgid: 43210, leaderPid: 43210 }, Date.now() + 800),
          ).rejects.toThrow("provider-control share exchange");
        }
      }
      const pid = Number(await readFile(pidPath, "utf8"));
      expect(await readProcessIdentity(pid)).toBeNull();
      const requests = (await readFile(transcript, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(requests.some((request) => request["op"] === delayedOperation)).toBe(true);
    }
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test("forwards only stage operations and retains no durable admission capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-process-workset-provider-"));
    roots.push(root);
    const transcript = join(root, "transcript.jsonl");
    const provider = createProcessWorksetEffectAdmissionProvider({
      command: process.execPath,
      args: ["run", fixture],
      cwd: root,
      env: { ...process.env, CQ_TEST_PROVIDER_TRANSCRIPT: transcript },
    });

    const handle = await provider.acquire({
      kind: "child-dispatch",
      targetRef: "tasks:T1983",
    });
    expect(handle).toMatchObject({
      id: "process-workset-effect-admission",
      epoch: 7,
      kind: "child-dispatch",
      targetRef: "tasks:T1983",
    });
    await handle.registerProcessGroup({ pgid: 43210, leaderPid: 43210 });
    await handle.shareWithGuardian({ pgid: 43210, leaderPid: 43210 });
    await handle.markSettled();
    await handle.releaseAfterSettlement();

    const requests = (await readFile(transcript, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests).toEqual([
      { op: "acquire", kind: "child-dispatch", targetRef: "tasks:T1983" },
      { op: "register", pgid: 43210, leaderPid: 43210 },
      { op: "share", pgid: 43210, leaderPid: 43210 },
      { op: "settle" },
      { op: "release" },
    ]);
    expect(JSON.stringify(requests)).not.toContain("process-workset-effect-admission");
  });
});
