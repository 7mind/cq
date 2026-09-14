/** Explicit XDG-to-remote migration. Source state is retained after import. */

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildBackupDump,
  createManagementLedgerStore,
  createTrustedWorksetManagementAuthority,
  requireWorksetStore,
  resolveLedgerBackend,
  RemoteLedgerClient,
} from "@cq/ledger";
import { resolveRemoteAdminToken } from "@cq/config";
import { type ConfirmIo } from "./confirm.js";

/** Exit code for a usage / refusal error (mirrors main.ts EXIT_USAGE). */
const EXIT_USAGE = 2;

/** The cq.toml config filename (kept local; see main.ts CQ_CONFIG_FILENAME). */
const CQ_CONFIG_FILENAME = "cq.toml";

/** Result of a `migrate` run: the resolved exit code for the dispatcher. */
export interface MigrateOutcome {
  exitCode: number;
}

/** IO seam: stdout / stderr line sinks + confirmation IO (from the dispatcher). */
export interface MigrateIo {
  out(line: string): void;
  err(line: string): void;
  confirm: ConfirmIo;
}

/** Parsed `migrate` arguments (bridged from the dispatcher's SubcommandArgs). */
export interface MigrateArgs {
  /** Resolved ledger root (--cwd > $LEDGER_ROOT > CWD, absolute). */
  cwd: string;
  /** Shared CLI confirmation flag; remote migration requires an empty target. */
  yes: boolean;
  /**
   * Explicit destination; an absent flag is rejected before accessing source state.
   */
  to: "remote" | null;
}

/**
 * Set `[ledger] backend = '<backend>'` in `<root>/cq.toml` via a targeted text
 * edit (cq-config has no serialiser). Three cases:
 *  - no cq.toml → create one with a `[ledger]` block;
 *  - cq.toml with an ACTIVE (uncommented) `[ledger]` table → replace its
 *    `backend = ...` line (or insert one right after the header if absent);
 *  - cq.toml WITHOUT an active `[ledger]` table → append a fresh block.
 *
 * Only the `backend` key is touched; any `branch`/`remote` lines are preserved.
 */
export async function setLedgerBackend(
  root: string,
  backend: "xdg" | "remote",
  extras: Readonly<Record<string, string>> = {},
): Promise<void> {
  const configPath = path.join(root, CQ_CONFIG_FILENAME);
  let source: string | null;
  try {
    source = await fsPromises.readFile(configPath, "utf8");
  } catch {
    source = null;
  }

  const extraLines = Object.entries(extras).map(([key, value]) => `  ${key} = "${value}"`);
  const block = [`[ledger]`, `  backend = "${backend}"`, ...extraLines, ""].join("\n");

  if (source === null) {
    await fsPromises.writeFile(configPath, block, "utf8");
    return;
  }

  const lines = source.split("\n");
  // Locate an ACTIVE (non-comment) [ledger] table header.
  const headerIdx = lines.findIndex((l) => /^\s*\[ledger\]\s*$/.test(l));
  if (headerIdx < 0) {
    // No active [ledger] table — append a fresh block (one blank-line separated).
    const sep = source.endsWith("\n") ? "\n" : "\n\n";
    await fsPromises.writeFile(configPath, `${source}${sep}${block}`, "utf8");
    return;
  }

  // Find the extent of the [ledger] table: from headerIdx+1 until the next
  // active table header (a line starting with `[`).
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  // Within the table, find an ACTIVE backend assignment.
  let backendIdx = -1;
  for (let i = headerIdx + 1; i < end; i++) {
    if (/^\s*backend\s*=/.test(lines[i] ?? "")) {
      backendIdx = i;
      break;
    }
  }
  if (backendIdx >= 0) {
    // Preserve the original indentation of the line.
    const indent = (lines[backendIdx] ?? "").match(/^\s*/)?.[0] ?? "  ";
    lines[backendIdx] = `${indent}backend = "${backend}"`;
  } else {
    // Insert a backend line right after the header.
    lines.splice(headerIdx + 1, 0, `  backend = "${backend}"`);
    backendIdx = headerIdx + 1;
    end += 1;
  }
  let insertAt = backendIdx + 1;
  for (const [key, value] of Object.entries(extras)) {
    const extraRe = new RegExp(`^\\s*${key}\\s*=`);
    let extraIdx = -1;
    for (let i = headerIdx + 1; i < end; i++) {
      if (extraRe.test(lines[i] ?? "")) {
        extraIdx = i;
        break;
      }
    }
    if (extraIdx >= 0) {
      const indent = (lines[extraIdx] ?? "").match(/^\s*/)?.[0] ?? "  ";
      lines[extraIdx] = `${indent}${key} = "${value}"`;
    } else {
      lines.splice(insertAt, 0, `  ${key} = "${value}"`);
      insertAt += 1;
      end += 1;
    }
  }
  await fsPromises.writeFile(configPath, lines.join("\n"), "utf8");
}

export async function runMigrate(args: MigrateArgs, io: MigrateIo): Promise<MigrateOutcome> {
  if (args.to !== "remote") {
    io.err("cq migrate: requires --to remote.");
    return { exitCode: EXIT_USAGE };
  }
  return runMigrateXdgToRemote(args, io);
}

async function runMigrateXdgToRemote(args: MigrateArgs, io: MigrateIo): Promise<MigrateOutcome> {
  const { backend, explicit } = resolveLedgerBackend(args.cwd);
  if (backend !== "xdg" || !explicit) {
    io.err(
      `cq migrate --to remote: [ledger] backend at ${args.cwd} must be explicit 'xdg'.`,
    );
    return { exitCode: EXIT_USAGE };
  }
  const serverUrl = process.env["CQ_LEDGER_SERVER_URL"]?.trim() ?? "";
  if (serverUrl === "") {
    io.err("cq migrate --to remote: CQ_LEDGER_SERVER_URL must be set to the cq serve origin");
    return { exitCode: EXIT_USAGE };
  }
  const resolved = await createManagementLedgerStore(args.cwd);
  const projectKey = resolved.projectKey;
  const logsDir = resolved.logsDir;
  if (projectKey === undefined || logsDir === undefined) {
    await resolved.store.dispose();
    throw new Error("cq migrate --to remote: xdg store resolved without projectKey/logsDir");
  }
  try {
    const workset = requireWorksetStore(resolved.store);
    await workset.runAdministrative({
      kind: "backend-migration",
      authority: createTrustedWorksetManagementAuthority(),
      destructivePhase: async () => {
        const dump = await buildBackupDump(resolved.store, logsDir);
        const operationId = `migrate-${randomUUID()}`;
        const adminToken = resolveRemoteAdminToken(process.env);
        const client = await RemoteLedgerClient.connectAdmin({
          serverUrl,
          projectKey,
          adminToken,
        });
        try {
          await client.importDump(operationId, "migrate-empty", dump);
        } finally {
          await client.close();
        }
        await setLedgerBackend(args.cwd, "remote", { serverUrl });
      },
    });
    io.out(`cq migrate: uploaded the xdg primary at ${args.cwd} to remote tenant ${projectKey}`);
    io.out(`  ${CQ_CONFIG_FILENAME}:  [ledger] backend = "remote"`);
    io.out("  xdg primary data left INTACT — delete it manually once confident.");
    return { exitCode: 0 };
  } finally {
    await resolved.store.dispose();
  }
}
