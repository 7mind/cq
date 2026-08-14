import {
  acquireWorktreeGate,
  closeWorktreeGate,
  launchRegisteredGateCommand,
  releaseWorktreeGate,
  type WorktreeGateLease,
} from "@cq/process-control";
import { DISPATCH_UTC_TIMESTAMP_PATTERN } from "@cq/config";
import {
  runGateGitEffect,
  type GateGitEffectRequest,
} from "./gateGitEffect.js";

export interface GateRunIo {
  err(line: string): void;
}

export interface GateRunOutcome {
  readonly exitCode: number;
}

interface ParsedGateRun {
  readonly worktree: string;
  readonly commandCwd: string;
  readonly deadlineMs?: number;
  readonly command: readonly string[];
}

export interface GateRunDependencies {
  readonly gitEffect?: (request: GateGitEffectRequest) => Promise<GateRunOutcome>;
}

export const GATE_DEADLINE_EXIT_CODE = 124;

const DISPATCH_UTC_TIMESTAMP = new RegExp(DISPATCH_UTC_TIMESTAMP_PATTERN, "u");

const SIGNAL_EXIT_CODES: Readonly<Partial<Record<NodeJS.Signals, number>>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

function parseGateRun(argv: readonly string[]): ParsedGateRun {
  if (argv[0] !== "run") {
    throw new Error("cq gate: expected `run`");
  }
  const separator = argv.indexOf("--");
  if (separator < 0) throw new Error("cq gate run: expected `--` before the command");
  const command = argv.slice(separator + 1);
  if (command.length === 0) throw new Error("cq gate run: command after `--` must not be empty");

  let worktree: string | undefined;
  let commandCwd: string | undefined;
  let deadlineMs: number | undefined;
  for (let index = 1; index < separator; index += 1) {
    const argument = argv[index];
    if (argument === "--worktree" || argument === "--command-cwd" || argument === "--deadline") {
      const value = argv[index + 1];
      if (value === undefined || index + 1 >= separator) {
        throw new Error(`cq gate run: ${argument} requires a value`);
      }
      if (argument === "--worktree") worktree = value;
      else if (argument === "--command-cwd") commandCwd = value;
      else deadlineMs = parseDeadline(value);
      index += 1;
    } else if (argument !== undefined && argument.startsWith("--worktree=")) {
      worktree = argument.slice("--worktree=".length);
    } else if (argument !== undefined && argument.startsWith("--command-cwd=")) {
      commandCwd = argument.slice("--command-cwd=".length);
    } else if (argument !== undefined && argument.startsWith("--deadline=")) {
      deadlineMs = parseDeadline(argument.slice("--deadline=".length));
    } else {
      throw new Error(`cq gate run: unknown option ${String(argument)}`);
    }
  }
  if (worktree === undefined || worktree === "") {
    throw new Error("cq gate run: --worktree is required");
  }
  if (commandCwd === undefined || commandCwd === "") {
    throw new Error("cq gate run: --command-cwd is required");
  }
  return { worktree, commandCwd, ...(deadlineMs === undefined ? {} : { deadlineMs }), command };
}

function parseGateGitEffect(argv: readonly string[]): GateGitEffectRequest {
  let operation: GateGitEffectRequest["operation"] | undefined;
  let cwd: string | undefined;
  let taskId: string | undefined;
  let commit: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === "--operation" ||
      argument === "--cwd" ||
      argument === "--task-id" ||
      argument === "--commit"
    ) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`cq gate git-effect: ${argument} requires a value`);
      if (argument === "--operation") {
        if (value !== "rebase" && value !== "merge") {
          throw new Error("cq gate git-effect: --operation must be rebase or merge");
        }
        operation = value;
      } else if (argument === "--cwd") cwd = value;
      else if (argument === "--task-id") taskId = value;
      else commit = value;
      index += 1;
      continue;
    }
    throw new Error(`cq gate git-effect: unknown option ${String(argument)}`);
  }
  if (operation === undefined) throw new Error("cq gate git-effect: --operation is required");
  if (cwd === undefined || cwd === "") throw new Error("cq gate git-effect: --cwd is required");
  if (taskId === undefined || taskId === "") {
    throw new Error("cq gate git-effect: --task-id is required");
  }
  if (commit === undefined || commit === "") {
    throw new Error("cq gate git-effect: --commit is required");
  }
  return { operation, cwd, taskId, commit };
}

function parseDeadline(value: string): number {
  const deadlineMs = Date.parse(value);
  if (!DISPATCH_UTC_TIMESTAMP.test(value) || !Number.isFinite(deadlineMs)) {
    throw new Error(
      `cq gate run: --deadline requires a dispatch UTC timestamp, got ${JSON.stringify(value)}`,
    );
  }
  return deadlineMs;
}

function deadlineReached(deadlineMs: number | undefined): boolean {
  return deadlineMs !== undefined && Date.now() >= deadlineMs;
}

export async function runGateRun(
  argv: readonly string[],
  _io: GateRunIo,
  dependencies: GateRunDependencies = {},
): Promise<GateRunOutcome> {
  if (argv[0] === "git-effect") {
    const request = parseGateGitEffect(argv);
    return await (dependencies.gitEffect ?? runGateGitEffect)(request);
  }
  const parsed = parseGateRun(argv);
  let lease: WorktreeGateLease | null = await acquireWorktreeGate({
    worktree: parsed.worktree,
    commandCwd: parsed.commandCwd,
  });
  try {
    if (deadlineReached(parsed.deadlineMs)) {
      await closeWorktreeGate(lease);
      lease = null;
      return { exitCode: GATE_DEADLINE_EXIT_CODE };
    }
    const launched = await launchRegisteredGateCommand(lease, parsed.command);
    if (deadlineReached(parsed.deadlineMs)) {
      await closeWorktreeGate(lease);
      lease = null;
      return { exitCode: GATE_DEADLINE_EXIT_CODE };
    }
    let interrupt: ((signal: NodeJS.Signals) => void) | null = null;
    const interrupted = new Promise<NodeJS.Signals>((resolve) => {
      interrupt = resolve;
    });
    const handlers = (["SIGHUP", "SIGINT", "SIGTERM"] as const).map((signal) => {
      const handler = () => interrupt?.(signal);
      process.once(signal, handler);
      return { signal, handler };
    });
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineMs = parsed.deadlineMs;
    const deadline =
      deadlineMs === undefined
        ? undefined
        : new Promise<"deadline">((resolve) => {
            deadlineTimer = setTimeout(
              () => resolve("deadline"),
              Math.max(0, deadlineMs - Date.now()),
            );
          });
    try {
      const candidates = [
        launched.exited.then((exit) => ({ kind: "exit" as const, exit })),
        interrupted.then((signal) => ({ kind: "signal" as const, signal })),
        ...(deadline === undefined ? [] : [deadline.then(() => ({ kind: "deadline" as const }))]),
      ];
      const outcome = await Promise.race(candidates);
      await closeWorktreeGate(lease);
      lease = null;
      if (deadlineReached(parsed.deadlineMs) || outcome.kind === "deadline") {
        return { exitCode: GATE_DEADLINE_EXIT_CODE };
      }
      if (outcome.kind === "signal") return { exitCode: SIGNAL_EXIT_CODES[outcome.signal] ?? 1 };
      if (outcome.exit.exitCode !== null) return { exitCode: outcome.exit.exitCode };
      return { exitCode: SIGNAL_EXIT_CODES[outcome.exit.signal ?? "SIGTERM"] ?? 1 };
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      for (const { signal, handler } of handlers) process.off(signal, handler);
    }
  } finally {
    if (lease !== null) await releaseWorktreeGate(lease);
  }
}
