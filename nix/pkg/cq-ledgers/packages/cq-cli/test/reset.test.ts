/**
 * `cq reset` — backup + reinit (destructive). Relocated from ledger-mcp's
 * `--reset` path (T190 / Q109).
 *
 * runReset is driven here through dispatch(["reset", …]) with an injected
 * ConfirmIo so the operator confirmation + exit-code policy can be asserted
 * without a real TTY:
 *
 *   - --yes (unattended): backs the prior tree up to .cq/.backup/<ts>/ and
 *     reinitialises the canonical empty set; exit 0 + summary on io.out.
 *   - non-TTY without --yes: REFUSES (exit 2) and does NOT touch the tree —
 *     never wipe silently.
 *   - TTY answering 'y' proceeds; any other answer aborts (exit 1).
 *
 * Seeds the tmp tree with the FsLedgerStore directly (same reader/writer the
 * production path uses), then closes the store before invoking reset so file
 * locks don't collide.
 */

import { describe, it, expect, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FsLedgerStore, LEDGER_STORAGE_DIRNAME, type LedgerSchema } from "@cq/ledger";
import { dispatch, type ConfirmIo, type DispatchIo } from "../src/main.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const opsSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { headline: { type: "string", required: true } },
};

/** Seed a tmp root with a custom `ops` ledger holding one item. */
async function seedTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "cq-reset-"));
  dirs.push(root);
  const store = new FsLedgerStore({ root });
  await store.init();
  await store.createLedger("ops", opsSchema);
  await store.createMilestone({ id: "M1", title: "m1" });
  await store.createItem("ops", "M1", { status: "open", fields: { headline: "seeded" } });
  await store.dispose();
  return root;
}

/** A DispatchIo whose ConfirmIo records output and answers the prompt fixed. */
function recordingIo(isTty: boolean, answer = ""): DispatchIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  const confirm: ConfirmIo = {
    isTty,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    prompt: async () => answer,
  };
  return { outs, errs, out: (l) => outs.push(l), err: (l) => errs.push(l), confirm };
}

/** True iff the tmp root has a custom `ops` ledger (i.e. NOT reset). */
async function hasOpsLedger(root: string): Promise<boolean> {
  const verify = new FsLedgerStore({ root });
  await verify.init();
  try {
    return verify.enumerate().includes("ops");
  } finally {
    await verify.dispose();
  }
}

describe("cq reset", () => {
  it("(a) --yes backs up to .cq/.backup/<ts>/ + reinitialises empty, exit 0 + summary", async () => {
    const root = await seedTree();
    const io = recordingIo(false); // non-TTY, but --yes overrides
    const outcome = await dispatch(["reset", "--cwd", root, "--yes"], io);

    expect(outcome.exitCode).toBe(0);

    // Backup dir created under .cq/.backup/<ts>/.
    const backupParent = path.join(root, LEDGER_STORAGE_DIRNAME, ".backup");
    const summaryLine = io.outs.find((l) => l.startsWith("  backup: "));
    expect(summaryLine).toBeDefined();
    const backupDir = summaryLine!.slice("  backup: ".length);
    expect(backupDir.startsWith(backupParent + path.sep)).toBe(true);
    expect((await fs.stat(backupDir)).isDirectory()).toBe(true);

    // Summary mentions the seeded ops ledger's backed-up item.
    expect(io.outs.join("\n")).toContain("ops: 1 item(s) backed up");

    // Live tree reset: the custom `ops` ledger is gone (canonical set only).
    expect(await hasOpsLedger(root)).toBe(false);
  });

  it("(b) non-TTY without --yes refuses (exit 2) and leaves the tree untouched", async () => {
    const root = await seedTree();
    const io = recordingIo(false);
    const outcome = await dispatch(["reset", "--cwd", root], io);

    expect(outcome.exitCode).toBe(2);
    expect(io.errs.join("\n")).toContain("--yes");

    // No backup written, no wipe: the seeded ops ledger survives.
    await expect(fs.stat(path.join(root, LEDGER_STORAGE_DIRNAME, ".backup"))).rejects.toThrow();
    expect(await hasOpsLedger(root)).toBe(true);
  });

  it("(c) TTY prompt proceeds on a 'y' answer", async () => {
    const root = await seedTree();
    const io = recordingIo(true, "y");
    const outcome = await dispatch(["reset", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);
    expect(await hasOpsLedger(root)).toBe(false);
  });

  it("(d) TTY prompt aborts on a non-'y' answer and leaves the tree untouched", async () => {
    const root = await seedTree();
    const io = recordingIo(true, "n");
    const outcome = await dispatch(["reset", "--cwd", root], io);
    expect(outcome.exitCode).toBe(1);
    expect(await hasOpsLedger(root)).toBe(true);
  });
});
