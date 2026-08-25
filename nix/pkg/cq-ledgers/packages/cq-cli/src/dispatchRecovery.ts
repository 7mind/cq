import { resolve } from "node:path";
import { createLedgerStore } from "@cq/ledger";

const TASK_ID = /^T[0-9]+$/u;

export interface DispatchRecoveryIo {
  out(line: string): void;
  err(line: string): void;
}

export interface DispatchRecoveryCommand {
  readonly operation: "seal" | "status";
  readonly cwd: string;
  readonly taskId: string;
}

export interface DispatchRecoveryCommandDeps {
  readonly seal: (input: { readonly cwd: string; readonly taskId: string }) => Promise<unknown>;
  readonly status: (input: { readonly cwd: string; readonly taskId: string }) => Promise<unknown>;
}

export const DISPATCH_RECOVERY_USAGE =
  "usage: cq dispatch-recovery <seal|status> --task-id <Tn> [--cwd <repository>]";

export function parseDispatchRecoveryArgs(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DispatchRecoveryCommand {
  const operation = argv[0];
  if (operation !== "seal" && operation !== "status") {
    throw new Error(DISPATCH_RECOVERY_USAGE);
  }
  let cwd: string | undefined;
  let taskId: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cwd") {
      const value = argv[index + 1];
      if (value === undefined || value === "") throw new Error("--cwd requires a path");
      cwd = value;
      index += 1;
      continue;
    }
    if (argument === "--task-id") {
      const value = argv[index + 1];
      if (value === undefined || !TASK_ID.test(value)) {
        throw new Error("--task-id requires one canonical task id");
      }
      taskId = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown dispatch-recovery argument: ${String(argument)}`);
  }
  if (taskId === undefined) throw new Error("--task-id is required");
  const selectedRoot = cwd ?? environment["LEDGER_ROOT"] ?? process.cwd();
  return { operation, cwd: resolve(selectedRoot), taskId };
}

async function productionDeps(): Promise<DispatchRecoveryCommandDeps> {
  const recovery = await import("@cq/ledger-mcp");
  return {
    seal: async ({ cwd, taskId }) => {
      const resolved = await createLedgerStore(cwd);
      try {
        return await recovery.captureCurrentDispatchRecoveryForProject({
          construction: "direct",
          resolved,
          taskId,
        });
      } finally {
        await resolved.store.dispose();
      }
    },
    status: async ({ cwd, taskId }) => {
      const resolved = await createLedgerStore(cwd);
      try {
        return await recovery.readCurrentDispatchRecoveryStatusForProject({
          construction: "direct",
          resolved,
          taskId,
        });
      } finally {
        await resolved.store.dispose();
      }
    },
  };
}

export async function runDispatchRecoveryCommand(
  argv: readonly string[],
  io: DispatchRecoveryIo,
  deps?: DispatchRecoveryCommandDeps,
): Promise<{ readonly exitCode: number }> {
  let command: DispatchRecoveryCommand;
  try {
    command = parseDispatchRecoveryArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return { exitCode: 2 };
  }
  try {
    const runtime = deps ?? (await productionDeps());
    const output =
      command.operation === "seal"
        ? await runtime.seal({ cwd: command.cwd, taskId: command.taskId })
        : await runtime.status({ cwd: command.cwd, taskId: command.taskId });
    io.out(JSON.stringify(output));
    return { exitCode: 0 };
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return { exitCode: 1 };
  }
}
