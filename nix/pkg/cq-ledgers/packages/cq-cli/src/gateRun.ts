import {
  acquireWorktreeGate,
  closeWorktreeGate,
  launchRegisteredGateCommand,
  releaseWorktreeGate,
  type WorktreeGateLease,
} from "@cq/process-control";

export interface GateRunIo {
  err(line: string): void;
}

export interface GateRunOutcome {
  readonly exitCode: number;
}

interface ParsedGateRun {
  readonly worktree: string;
  readonly commandCwd: string;
  readonly command: readonly string[];
}

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
  for (let index = 1; index < separator; index += 1) {
    const argument = argv[index];
    if (argument === "--worktree" || argument === "--command-cwd") {
      const value = argv[index + 1];
      if (value === undefined || index + 1 >= separator) {
        throw new Error(`cq gate run: ${argument} requires a value`);
      }
      if (argument === "--worktree") worktree = value;
      else commandCwd = value;
      index += 1;
    } else if (argument !== undefined && argument.startsWith("--worktree=")) {
      worktree = argument.slice("--worktree=".length);
    } else if (argument !== undefined && argument.startsWith("--command-cwd=")) {
      commandCwd = argument.slice("--command-cwd=".length);
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
  return { worktree, commandCwd, command };
}

export async function runGateRun(argv: readonly string[], _io: GateRunIo): Promise<GateRunOutcome> {
  const parsed = parseGateRun(argv);
  let lease: WorktreeGateLease | null = await acquireWorktreeGate({
    worktree: parsed.worktree,
    commandCwd: parsed.commandCwd,
  });
  try {
    const launched = await launchRegisteredGateCommand(lease, parsed.command);
    let interrupt: ((signal: NodeJS.Signals) => void) | null = null;
    const interrupted = new Promise<NodeJS.Signals>((resolve) => {
      interrupt = resolve;
    });
    const handlers = (["SIGHUP", "SIGINT", "SIGTERM"] as const).map((signal) => {
      const handler = () => interrupt?.(signal);
      process.once(signal, handler);
      return { signal, handler };
    });
    try {
      const outcome = await Promise.race([
        launched.exited.then((exit) => ({ kind: "exit" as const, exit })),
        interrupted.then((signal) => ({ kind: "signal" as const, signal })),
      ]);
      await closeWorktreeGate(lease);
      lease = null;
      if (outcome.kind === "signal") return { exitCode: SIGNAL_EXIT_CODES[outcome.signal] ?? 1 };
      if (outcome.exit.exitCode !== null) return { exitCode: outcome.exit.exitCode };
      return { exitCode: SIGNAL_EXIT_CODES[outcome.exit.signal ?? "SIGTERM"] ?? 1 };
    } finally {
      for (const { signal, handler } of handlers) process.off(signal, handler);
    }
  } finally {
    if (lease !== null) await releaseWorktreeGate(lease);
  }
}
