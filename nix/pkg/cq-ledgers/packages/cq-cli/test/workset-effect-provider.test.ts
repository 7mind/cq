import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { createLedgerStore, requireWorksetStore } from "@cq/ledger";
import {
  WorksetEffectBroker,
  createProcessWorksetEffectAdmissionProvider,
  readProcessIdentity,
  type RegisteredLaunchBootstrapSpecification,
} from "@cq/process-control";

const roots: string[] = [];
const cli = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const parentFixture = fileURLToPath(
  new URL("./worksetEffectProviderParentFixture.ts", import.meta.url),
);

function childExited(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });
}

function nodeBootstrap(specification: RegisteredLaunchBootstrapSpecification<StdioOptions>) {
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
    outputDrained: Promise.resolve(),
    resultFromTargetOutcome: (outcome: { readonly exitCode: number | null }) =>
      outcome.exitCode ?? 0,
    terminate: (signal: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await access(path);
      if ((await readFile(path, "utf8")).endsWith("\n")) return;
    } catch {
      // The controller publishes one complete record before the test kills it.
    }
    await Bun.sleep(2);
  }
  throw new Error(`controller did not publish ${path}`);
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 2_500; attempt += 1) {
    if ((await readProcessIdentity(pid)) === null) return;
    await Bun.sleep(2);
  }
  throw new Error(`process ${String(pid)} survived controller death`);
}

describe("cq workset effect provider control [Behavioral-Active Blackbox Good-Communication]", () => {
  test("retains and closes the actual durable admission around a registered child", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-cli-workset-provider-"));
    roots.push(root);
    await writeFile(join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');
    const initialized = await createLedgerStore(root);
    await initialized.store.dispose();

    const provider = createProcessWorksetEffectAdmissionProvider({
      command: process.execPath,
      args: ["run", cli, "__workset-effect-provider", "--cwd", root],
      cwd: root,
      env: process.env,
    });
    const broker = new WorksetEffectBroker({ provider });
    const launched = await broker.launch({
      kind: "child-dispatch",
      targetRef: "tasks:T1983",
      argv: [process.execPath, "-e", "process.exit(0)"],
      cwd: root,
      env: process.env,
      stdio: "ignore" as StdioOptions,
      launchBootstrap: nodeBootstrap,
    });
    expect(await launched.exited).toBe(0);

    const observed = await createLedgerStore(root);
    try {
      expect(requireWorksetStore(observed.store).activeAdmissionCount()).toBe(0);
    } finally {
      await observed.store.dispose();
    }
  });

  test("controller death settles the target and descendant before replacement acknowledges", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-cli-workset-provider-parent-"));
    roots.push(root);
    const marker = join(root, "target.json");
    await writeFile(join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');
    const initialized = await createLedgerStore(root);
    await initialized.store.dispose();

    const controller = spawn(process.execPath, ["run", parentFixture, root, cli, marker], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      await waitForFile(marker);
      const published = JSON.parse((await readFile(marker, "utf8")).trim()) as {
        readonly targetPid: number;
        readonly descendantPid: number;
      };
      controller.kill("SIGKILL");
      await childExited(controller);
      await Promise.all([waitForExit(published.targetPid), waitForExit(published.descendantPid)]);

      const observed = await createLedgerStore(root);
      try {
        const replacement = await requireWorksetStore(observed.store).setRoots([]);
        expect(replacement).toEqual({ roots: [], epoch: 1 });
      } finally {
        await observed.store.dispose();
      }
    } finally {
      controller.kill("SIGKILL");
    }
  });
});
