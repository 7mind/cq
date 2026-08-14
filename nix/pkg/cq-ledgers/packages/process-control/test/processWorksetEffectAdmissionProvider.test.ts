import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProcessWorksetEffectAdmissionProvider,
} from "@cq/process-control";

const roots: string[] = [];
const fixture = fileURLToPath(
  new URL("./processWorksetEffectAdmissionProviderFixture.ts", import.meta.url),
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("process workset admission provider [Behavioral-Active Blackbox Good-Communication]", () => {
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
