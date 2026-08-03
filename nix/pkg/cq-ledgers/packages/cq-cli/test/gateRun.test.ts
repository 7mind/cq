import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, type DispatchIo } from "../src/main.js";

const roots: string[] = [];

function io(): DispatchIo {
  return {
    out: () => {},
    err: () => {},
    confirm: { isTty: false, out: () => {}, err: () => {}, prompt: async () => "n" },
  };
}

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cq-gate-cli-"));
  roots.push(root);
  const init = Bun.spawnSync(["git", "init", "-q", root]);
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cq gate run [BG]", () => {
  test("runs the child in the validated in-worktree command cwd", async () => {
    const root = await repositoryFixture();
    const commandCwd = join(root, "nested");
    const marker = join(root, "cwd.txt");
    await mkdir(commandCwd);
    const result = await dispatch(
      [
        "gate",
        "run",
        "--worktree",
        root,
        "--command-cwd",
        commandCwd,
        "--",
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, process.cwd())`,
      ],
      io(),
    );
    expect(result).toEqual({ exitCode: 0, longRunning: false });
    expect(await readFile(marker, "utf8")).toBe(commandCwd);
  });

  test("rejects an escaping command cwd without running the child", async () => {
    const root = await repositoryFixture();
    const outside = await mkdtemp(join(tmpdir(), "cq-gate-cli-outside-"));
    roots.push(outside);
    const marker = join(root, "must-not-exist");
    await expect(
      dispatch(
        [
          "gate",
          "run",
          "--worktree",
          root,
          "--command-cwd",
          outside,
          "--",
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(marker)}, "ran")`,
        ],
        io(),
      ),
    ).rejects.toThrow("contained in worktree");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("passes child arguments after the separator verbatim", async () => {
    const root = await repositoryFixture();
    const marker = join(root, "argv.json");
    const result = await dispatch(
      [
        "gate",
        "run",
        "--worktree",
        root,
        "--command-cwd",
        root,
        "--",
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(1)))`,
        "--",
        "--cwd",
      ],
      io(),
    );
    expect(result).toEqual({ exitCode: 0, longRunning: false });
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual(["--cwd"]);
  });

  test("an absolute deadline terminates and settles the registered gate command [BG]", async () => {
    const root = await repositoryFixture();
    const marker = join(root, "overrun-started.txt");
    const deadline = new Date(Date.now() + 1_000).toISOString();
    const startedAt = Date.now();
    const exhausted = await dispatch(
      [
        "gate",
        "run",
        "--worktree",
        root,
        "--command-cwd",
        root,
        "--deadline",
        deadline,
        "--",
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, "started"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`,
      ],
      io(),
    );
    const settledAt = Date.now();
    expect(exhausted).toEqual({ exitCode: 124, longRunning: false });
    expect(await readFile(marker, "utf8")).toBe("started");
    expect(settledAt).toBeGreaterThanOrEqual(Date.parse(deadline));
    expect(settledAt - startedAt).toBeGreaterThanOrEqual(900);

    const afterSettlement = await dispatch(
      [
        "gate",
        "run",
        "--worktree",
        root,
        "--command-cwd",
        root,
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      io(),
    );
    expect(afterSettlement).toEqual({ exitCode: 0, longRunning: false });
  }, 15_000);
});
