import { resolve } from "node:path";
import { createLedgerStore, createLedgerMcpToolSpecifications, resolveLedgerBackend } from "@cq/ledger";
import { withRemoteClient } from "./remoteClient.js";

export type CohortStatusQuery = (cwd: string) => Promise<unknown>;
export interface CohortStatusIo { out(line: string): void; err(line: string): void }

export function parseCohortStatusArgs(argv: readonly string[], processCwd: string): { cwd: string } {
  if (argv[0] !== "cohort" || argv[1] !== "status") throw new Error("cq ledger: expected `cohort status`");
  let cwd = processCwd;
  let json = false;
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--json") { json = true; continue; }
    if (argument === "--cwd" || argument.startsWith("--cwd=")) {
      const value = argument === "--cwd" ? argv[++index] : argument.slice("--cwd=".length);
      if (value === undefined || value.length === 0 || value.startsWith("--")) throw new Error("--cwd requires one repository path");
      cwd = resolve(processCwd, value); continue;
    }
    throw new Error(`unknown cohort status argument ${argument}; status accepts no execution authority`);
  }
  if (!json) throw new Error("cq ledger cohort status requires --json");
  return { cwd };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertCohortStatus(value: unknown): void {
  if (!object(value) || !["local", "unavailable"].includes(String(value["executor"]))) throw new Error("cohort status has an invalid executor marker");
  const status = value["status"];
  if (status === null && value["executor"] === "unavailable") return;
  if (!object(status) || !Array.isArray(status["definitions"]) || typeof status["resumeRequired"] !== "boolean" ||
      !object(status["counters"]) || Object.values(status["counters"]).some((count) => !Number.isSafeInteger(count) || (count as number) < 0)) {
    throw new Error("cohort status requires retained definitions, resume state, and measured counters");
  }
}

export const queryCohortStatus: CohortStatusQuery = async (cwd) => {
  if (resolveLedgerBackend(cwd).backend === "remote") {
    return await withRemoteClient(cwd, (client) => client.callToolRaw("get_cohort_status", {}));
  }
  const resolved = await createLedgerStore(cwd);
  try {
    const metadata = createLedgerMcpToolSpecifications(resolved.store).find(({ name }) => name === "get_cohort_status");
    if (metadata === undefined) throw new Error("cohort status metadata is unavailable");
    const response = await metadata.handler({}, null);
    const content = response.content[0];
    if (response.isError || content?.type !== "text") throw new Error("cohort status metadata returned an invalid response");
    return JSON.parse(content.text) as unknown;
  } finally { resolved.backup?.close(); await resolved.store.dispose(); }
};

export async function runCohortStatus(argv: readonly string[], io: CohortStatusIo, processCwd: string,
  query: CohortStatusQuery): Promise<{ exitCode: number }> {
  let args: { cwd: string };
  try { args = parseCohortStatusArgs(argv, processCwd); }
  catch (error) { io.err(error instanceof Error ? error.message : String(error)); return { exitCode: 2 }; }
  try {
    const value = await query(args.cwd);
    assertCohortStatus(value);
    io.out(JSON.stringify(value));
    return { exitCode: 0 };
  } catch (error) { io.err(error instanceof Error ? error.message : String(error)); return { exitCode: 1 }; }
}
