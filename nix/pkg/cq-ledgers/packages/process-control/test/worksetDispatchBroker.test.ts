import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import {
  WorksetEffectBroker,
  createStrictInMemoryWorksetEffectAdmissionProvider,
  readProcessIdentity,
  type RegisteredLaunchBootstrapSpecification,
} from "@cq/process-control";

const roots: string[] = [];
const SECRET_ADMISSION_ID = "secret-workset-admission-t1983";

function childExited(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 0));
  });
}

function streamDrained(stream: NodeJS.ReadableStream | null): Promise<void> {
  if (stream === null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
}

function nodeBootstrap(
  specification: RegisteredLaunchBootstrapSpecification<StdioOptions>,
) {
  const child = spawn(specification.argv[0], specification.argv.slice(1), {
    cwd: specification.cwd,
    env: specification.env,
    detached: specification.detached,
    stdio: specification.stdio,
  });
  return {
    process: child,
    pid: child.pid,
    exited: childExited(child),
    outputDrained: Promise.all([
      streamDrained(child.stdout),
      streamDrained(child.stderr),
    ]).then(() => undefined),
    resultFromTargetOutcome: (outcome: { readonly exitCode: number | null }) =>
      outcome.exitCode ?? 0,
    terminate: (signal: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await Bun.sleep(2);
    }
  }
  throw new Error(`dispatch fixture did not create ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if ((await readProcessIdentity(pid)) === null) return;
    await Bun.sleep(2);
  }
  throw new Error(`dispatch process ${String(pid)} did not settle`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dispatch workset effect races [Behavioral-Active Blackbox Good-Communication]", () => {
  test("a replacement that wins first refuses admission before process creation", async () => {
    let bootstraps = 0;
    const broker = new WorksetEffectBroker({
      provider: {
        acquire: async () => {
          throw new Error("replacement already committed");
        },
      },
    });

    await expect(
      broker.launch({
        kind: "child-dispatch",
        targetRef: "tasks:T1983",
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: import.meta.dir,
        env: process.env,
        stdio: "ignore" as const,
        launchBootstrap: (specification) => {
          bootstraps += 1;
          return nodeBootstrap(specification);
        },
      }),
    ).rejects.toThrow("replacement already committed");
    expect(bootstraps).toBe(0);
  });

  test("a launched child holds replacement until its descendant settles and leaks no capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-dispatch-effect-race-"));
    roots.push(root);
    const marker = join(root, "descendant-pid");
    const capture = join(root, "child-metadata.json");
    const strict = createStrictInMemoryWorksetEffectAdmissionProvider();
    const provider = {
      acquire: async (input: Parameters<typeof strict.acquire>[0]) => {
        const handle = await strict.acquire(input);
        return { ...handle, id: SECRET_ADMISSION_ID };
      },
    };
    const controller = new AbortController();
    const script = [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});`,
      `fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));`,
      `fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv,env:process.env}));`,
      "process.on('SIGTERM',()=>{});",
      "setInterval(()=>{},1000);",
    ].join("");
    const broker = new WorksetEffectBroker({ provider });
    const launched = await broker.launch({
      kind: "child-dispatch",
      targetRef: "tasks:T1983",
      argv: [process.execPath, "-e", script],
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"] as StdioOptions,
      signal: controller.signal,
      launchBootstrap: nodeBootstrap,
    });
    await waitForFile(marker);
    const descendantPid = Number.parseInt((await readFile(marker, "utf8")).trim(), 10);

    let replacementAcknowledged = false;
    const replacement = (async () => {
      await strict.waitForIdle();
      expect(await readProcessIdentity(launched.registration.leader.pid)).toBeNull();
      expect(await readProcessIdentity(descendantPid)).toBeNull();
      replacementAcknowledged = true;
    })();
    await Bun.sleep(25);
    expect(replacementAcknowledged).toBe(false);
    controller.abort();

    await launched.exited;
    await replacement;
    await waitForProcessExit(launched.registration.leader.pid);
    await waitForProcessExit(descendantPid);
    const metadata = await readFile(capture, "utf8");
    expect(metadata).not.toContain(SECRET_ADMISSION_ID);
    expect(strict.events()).toEqual([
      "admission-acquired",
      "process-group-registered",
      "guardian-shared",
      "process-group-settled",
      "guardian-released",
      "admission-released",
    ]);
  });

  test("nested registered-group settlement completes before admission release", async () => {
    const strict = createStrictInMemoryWorksetEffectAdmissionProvider();
    let beginNestedSettlement!: () => void;
    const nestedSettlementStarted = new Promise<void>((resolve) => {
      beginNestedSettlement = resolve;
    });
    let releaseNestedSettlement!: () => void;
    const nestedSettlementReleased = new Promise<void>((resolve) => {
      releaseNestedSettlement = resolve;
    });
    const broker = new WorksetEffectBroker({ provider: strict });
    const launched = await broker.launch({
      kind: "child-dispatch",
      targetRef: "tasks:T1983",
      argv: [process.execPath, "-e", "process.exit(0)"],
      cwd: import.meta.dir,
      env: process.env,
      stdio: "ignore" as const,
      settleRegisteredDescendants: async () => {
        beginNestedSettlement();
        await nestedSettlementReleased;
      },
      launchBootstrap: nodeBootstrap,
    });

    await nestedSettlementStarted;
    expect(strict.activeAdmissionCount()).toBe(1);
    expect(strict.events()).toEqual([
      "admission-acquired",
      "process-group-registered",
      "guardian-shared",
    ]);
    releaseNestedSettlement();
    expect(await launched.exited).toBe(0);
    expect(strict.activeAdmissionCount()).toBe(0);
  });
});
