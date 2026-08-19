import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as processControl from "@cq/process-control";
import { dispatch, type DispatchIo } from "../src/main.js";
import { runGateGitEffect } from "../src/gateGitEffect.js";
import { GATE_DEADLINE_EXIT_CODE, runGateRun } from "../src/gateRun.js";

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

describe("cq gate run absolute phase deadline [BA]", () => {
  const lease = {
    worktree: "/test/worktree",
    commandCwd: "/test/worktree",
    gateDir: "/test/gate",
    nonce: "test-nonce",
  };
  const launched = {
    registration: { pgid: 123, leader: { pid: 123, startTime: "1" } },
    exited: Promise.resolve({ exitCode: 0, signal: null }),
  };

  function args(deadline: string): string[] {
    return [
      "run",
      "--worktree",
      lease.worktree,
      "--command-cwd",
      lease.commandCwd,
      "--deadline",
      deadline,
      "--",
      "true",
    ];
  }

  test("rejects deadline values outside the dispatch UTC timestamp grammar", async () => {
    await expect(
      runGateRun(args("2099-08-03T12:34:56"), { err: () => {} }),
    ).rejects.toThrow("dispatch UTC timestamp");
  });

  test("does not launch when gate acquisition consumes the remaining window", async () => {
    const startMs = Date.parse("2099-08-03T12:34:56.000Z");
    const deadlineMs = startMs + 1_000;
    let nowMs = startMs;
    const now = spyOn(Date, "now").mockImplementation(() => nowMs);
    const acquire = spyOn(processControl, "acquireWorktreeGate").mockImplementation(async () => {
      nowMs = deadlineMs;
      return lease;
    });
    const launch = spyOn(processControl, "launchRegisteredGateCommand").mockResolvedValue(launched);
    const close = spyOn(processControl, "closeWorktreeGate").mockResolvedValue({
      signaled: [],
      survivors: [],
    });
    try {
      const outcome = await runGateRun(args(new Date(deadlineMs).toISOString()), {
        err: () => {},
      });
      expect({ outcome, launchCalls: launch.mock.calls.length, closeCalls: close.mock.calls.length })
        .toEqual({
          outcome: { exitCode: GATE_DEADLINE_EXIT_CODE },
          launchCalls: 0,
          closeCalls: 1,
        });
    } finally {
      close.mockRestore();
      launch.mockRestore();
      acquire.mockRestore();
      now.mockRestore();
    }
  });

  test("returns deadline exhaustion when registered launch consumes the remaining window", async () => {
    const startMs = Date.parse("2099-08-03T12:34:56.000Z");
    const deadlineMs = startMs + 1_000;
    let nowMs = startMs;
    const now = spyOn(Date, "now").mockImplementation(() => nowMs);
    const schedule = spyOn(globalThis, "setTimeout").mockImplementation(
      (() => 0 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    );
    const acquire = spyOn(processControl, "acquireWorktreeGate").mockResolvedValue(lease);
    const launch = spyOn(processControl, "launchRegisteredGateCommand").mockImplementation(
      async () => {
        nowMs = deadlineMs;
        return launched;
      },
    );
    const close = spyOn(processControl, "closeWorktreeGate").mockResolvedValue({
      signaled: [],
      survivors: [],
    });
    try {
      const outcome = await runGateRun(args(new Date(deadlineMs).toISOString()), {
        err: () => {},
      });
      expect({
        outcome,
        scheduleCalls: schedule.mock.calls.length,
        closeCalls: close.mock.calls.length,
      }).toEqual({
        outcome: { exitCode: GATE_DEADLINE_EXIT_CODE },
        scheduleCalls: 0,
        closeCalls: 1,
      });
    } finally {
      close.mockRestore();
      launch.mockRestore();
      acquire.mockRestore();
      schedule.mockRestore();
      now.mockRestore();
    }
  });

  test("returns deadline exhaustion when normal-exit settlement overruns the window", async () => {
    const startMs = Date.parse("2099-08-03T12:34:56.000Z");
    const deadlineMs = startMs + 1_000;
    let nowMs = startMs;
    const now = spyOn(Date, "now").mockImplementation(() => nowMs);
    const acquire = spyOn(processControl, "acquireWorktreeGate").mockResolvedValue(lease);
    const launch = spyOn(processControl, "launchRegisteredGateCommand").mockResolvedValue(launched);
    const close = spyOn(processControl, "closeWorktreeGate").mockImplementation(async () => {
      nowMs = deadlineMs;
      return { signaled: [], survivors: [] };
    });
    try {
      const outcome = await runGateRun(args(new Date(deadlineMs).toISOString()), {
        err: () => {},
      });
      expect({ outcome, closeCalls: close.mock.calls.length }).toEqual({
        outcome: { exitCode: GATE_DEADLINE_EXIT_CODE },
        closeCalls: 1,
      });
    } finally {
      close.mockRestore();
      launch.mockRestore();
      acquire.mockRestore();
      now.mockRestore();
    }
  });
});

describe("cq gate git-effect [T1984]", () => {
  test("routes only one typed task-bound rebase or merge request [Behavioral-Active Blackbox-Atomic]", async () => {
    const requests: unknown[] = [];
    const outcome = await runGateRun(
      [
        "git-effect",
        "--operation",
        "merge",
        "--cwd",
        "/tmp/cq-repository",
        "--task-id",
        "T1984",
        "--commit",
        "a".repeat(40),
      ],
      { err: () => undefined },
      {
        gitEffect: async (request) => {
          requests.push(request);
          return { exitCode: 17 };
        },
      },
    );

    expect(outcome).toEqual({ exitCode: 17 });
    expect(requests).toEqual([
      {
        operation: "merge",
        cwd: "/tmp/cq-repository",
        taskId: "T1984",
        commit: "a".repeat(40),
      },
    ]);
  });

  test("carries one stable guarded-rebase operation id into the typed rebase request [Behavioral-Active Blackbox-Atomic]", async () => {
    const requests: unknown[] = [];
    const outcome = await runGateRun(
      [
        "git-effect",
        "--operation",
        "rebase",
        "--cwd",
        "/tmp/cq-repository",
        "--task-id",
        "T1984",
        "--commit",
        "a".repeat(40),
        "--operation-id",
        "implement-t1984-rebase-r0",
      ],
      { err: () => undefined },
      {
        gitEffect: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      },
    );

    expect(outcome).toEqual({ exitCode: 0 });
    expect(requests).toEqual([
      {
        operation: "rebase",
        cwd: "/tmp/cq-repository",
        taskId: "T1984",
        commit: "a".repeat(40),
        operationId: "implement-t1984-rebase-r0",
      },
    ]);
  });

  test("the trusted runner rejects a merge carrying an operation id before any store access [Behavioral-Active Blackbox-Atomic]", async () => {
    await expect(
      runGateGitEffect({
        operation: "merge",
        cwd: "/tmp/cq-repository",
        taskId: "T1984",
        commit: "a".repeat(40),
        operationId: "implement-t1984-rebase-r0",
      }),
    ).rejects.toThrow("--operation-id journals only a rebase");
  });

  test("the trusted runner rejects a malformed guarded-rebase operation id [Behavioral-Active Blackbox-Atomic]", async () => {
    await expect(
      runGateGitEffect({
        operation: "rebase",
        cwd: "/tmp/cq-repository",
        taskId: "T1984",
        commit: "a".repeat(40),
        operationId: "has spaces",
      }),
    ).rejects.toThrow("--operation-id must be one stable operation id");
  });

  test("rejects untyped operations before invoking the trusted runner [Behavioral-Active Blackbox-Atomic]", async () => {
    let calls = 0;
    await expect(
      runGateRun(
        [
          "git-effect",
          "--operation",
          "reset",
          "--cwd",
          "/tmp/cq-repository",
          "--task-id",
          "T1984",
          "--commit",
          "a".repeat(40),
        ],
        { err: () => undefined },
        {
          gitEffect: async () => {
            calls += 1;
            return { exitCode: 0 };
          },
        },
      ),
    ).rejects.toThrow("--operation must be rebase or merge");
    expect(calls).toBe(0);
  });
});
