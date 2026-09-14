import { spawn } from "node:child_process";
import { readProcessIdentity, settleProcessGroups, type ProcessGroupRegistration } from "@cq/process-control";

export async function runPostgresRequiredCommand(command: readonly string[], cwd: string,
  environment: NodeJS.ProcessEnv, signal: AbortSignal | null): Promise<number> {
  if (command[0] === undefined) throw new Error("required PostgreSQL command is empty");
  if (signal !== null && signal.aborted) throw new Error("required PostgreSQL gate was interrupted");
  const child = spawn(command[0], command.slice(1), { cwd, env: { ...environment }, detached: true, stdio: "inherit" });
  const exited = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); });
  if (child.pid === undefined) return await exited;
  const identity = await readProcessIdentity(child.pid);
  const registration: ProcessGroupRegistration | null = identity === null ? null : { pgid: child.pid, leader: identity };
  let settlement: Promise<void> | null = null;
  let settlementError: unknown;
  const settle = () => {
    if (settlement !== null || registration === null) return;
    settlement = settleProcessGroups([registration]).then((result) => {
      if (result.survivors.length > 0) settlementError = new Error(`required PostgreSQL command left process groups ${result.survivors.join(", ")}`);
    }, (error: unknown) => { settlementError = error; });
  };
  if (signal !== null) {
    signal.addEventListener("abort", settle, { once: true });
    if (signal.aborted) settle();
  }
  try {
    const code = await exited;
    settle();
    if (settlement !== null) await settlement;
    if (settlementError !== undefined) throw settlementError;
    return code;
  } finally {
    if (signal !== null) signal.removeEventListener("abort", settle);
  }
}
