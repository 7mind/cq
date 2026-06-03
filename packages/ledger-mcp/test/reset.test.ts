/**
 * `--reset` CLI path (T124 / Q64).
 *
 * runReset is the testable core that main() delegates to before applying
 * process.exit. It is driven here with an injected ResetIo so the operator
 * confirmation + exit-code policy can be asserted without a real TTY:
 *
 *   - --yes (unattended): backs the prior tree up to docs/.backup/<ts>/ and
 *     reinitialises the canonical empty set; exit 0.
 *   - non-TTY without --yes: REFUSES (non-zero exit) and does NOT touch the
 *     tree — never wipe silently.
 *
 * Seeds the tmp tree with the FsLedgerStore directly (same reader/writer the
 * production path uses), then closes the store before invoking runReset so
 * file locks don't collide.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsLedgerStore, type LedgerSchema } from "@cq/ledger";
import { runReset, type ResetIo } from "../src/main.js";

const opsSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { headline: { type: "string", required: true } },
};

/** Seed a tmp root with a custom `ops` ledger holding one item. */
async function seedTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-reset-"));
  const store = new FsLedgerStore({ root });
  await store.init();
  await store.createLedger("ops", opsSchema);
  await store.createMilestone({ id: "M1", title: "m1" });
  await store.createItem("ops", "M1", { status: "open", fields: { headline: "seeded" } });
  await store.dispose();
  return root;
}

/** A ResetIo that records output and answers the prompt with a fixed string. */
function recordingIo(isTty: boolean, answer = ""): ResetIo & { lines: string[]; errs: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    isTty,
    lines,
    errs,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    prompt: async () => answer,
  };
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

describe("runReset", () => {
  it("--yes backs up + reinitialises and exits 0 without serving", async () => {
    const root = await seedTree();
    try {
      const io = recordingIo(false); // non-TTY, but --yes overrides
      const outcome = await runReset(root, true, io);

      expect(outcome.exitCode).toBe(0);
      expect(outcome.summary).not.toBeNull();
      const summary = outcome.summary!;

      // Backup dir created under docs/.backup/<ts>/.
      const backupParent = path.join(root, "docs", ".backup");
      expect(summary.backupDir.startsWith(backupParent + path.sep)).toBe(true);
      const backupStat = await fs.stat(summary.backupDir);
      expect(backupStat.isDirectory()).toBe(true);

      // Pre-wipe summary captured the seeded ops item.
      const ops = summary.ledgers.find((l) => l.name === "ops");
      expect(ops?.itemCount).toBe(1);

      // Live tree reset: the custom `ops` ledger is gone (canonical set only).
      expect(await hasOpsLedger(root)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("non-TTY without --yes refuses (exit 2) and leaves the tree untouched", async () => {
    const root = await seedTree();
    try {
      const io = recordingIo(false);
      const outcome = await runReset(root, false, io);

      expect(outcome.exitCode).toBe(2);
      expect(outcome.summary).toBeNull();
      expect(io.errs.join("\n")).toContain("--yes");

      // No backup written, no wipe: the seeded ops ledger survives.
      await expect(fs.stat(path.join(root, "docs", ".backup"))).rejects.toThrow();
      expect(await hasOpsLedger(root)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("TTY prompt proceeds on a 'y' answer", async () => {
    const root = await seedTree();
    try {
      const io = recordingIo(true, "y");
      const outcome = await runReset(root, false, io);
      expect(outcome.exitCode).toBe(0);
      expect(await hasOpsLedger(root)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("TTY prompt aborts on a non-'y' answer and leaves the tree untouched", async () => {
    const root = await seedTree();
    try {
      const io = recordingIo(true, "n");
      const outcome = await runReset(root, false, io);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.summary).toBeNull();
      expect(await hasOpsLedger(root)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
