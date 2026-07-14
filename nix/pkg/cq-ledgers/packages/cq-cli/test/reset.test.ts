/**
 * `cq reset` — backup + reinit (destructive). Relocated from ledger-mcp's
 * `--reset` path (T190 / Q109).
 *
 * runReset is driven here through dispatch(["reset", …]) with an injected
 * ConfirmIo so the operator confirmation + exit-code policy can be asserted
 * without a real TTY:
 *
 *   - non-TTY without --yes: REFUSES (exit 2) and does NOT touch the tree —
 *     never wipe silently. The refusal happens BEFORE any store construction.
 *   - TTY answering a non-'y' aborts (exit 1), tree untouched.
 *   - T505: once confirmed, a root whose cq.toml (or the no-cq.toml default)
 *     names a LEGACY backend rejects with LegacyBackendError naming
 *     `cq migrate` — reset's FS backup→reinit path is no longer reachable at
 *     runtime. (The historical fs reset assertions live in git history.)
 *
 * Seeds the tmp tree with the FsLedgerStore directly (a legacy .cq/ tree on
 * disk, exactly what a pre-migration repo looks like).
 */

import { describe, it, expect, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FsLedgerStore, LegacyBackendError, LEDGER_STORAGE_DIRNAME, type LedgerSchema } from "@cq/ledger";
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
  it("(a — T505) --yes on a legacy (default-fs) root rejects with LegacyBackendError naming cq migrate; tree untouched", async () => {
    const root = await seedTree();
    const io = recordingIo(false); // non-TTY, but --yes overrides the prompt

    const err = await dispatch(["reset", "--cwd", root, "--yes"], io).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LegacyBackendError);
    expect((err as Error).message).toContain("cq migrate");

    // No backup written, no wipe: the seeded ops ledger survives untouched.
    await expect(fs.stat(path.join(root, LEDGER_STORAGE_DIRNAME, ".backup"))).rejects.toThrow();
    expect(await hasOpsLedger(root)).toBe(true);
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

  it("(c — T505) TTY 'y' answer proceeds past confirmation, then rejects on the legacy backend", async () => {
    const root = await seedTree();
    const io = recordingIo(true, "y");
    const err = await dispatch(["reset", "--cwd", root], io).then(
      () => null,
      (e: unknown) => e,
    );
    // Confirmation was accepted (no refusal exit) — construction then fails
    // fast on the legacy backend; the tree is untouched.
    expect(err).toBeInstanceOf(LegacyBackendError);
    expect(await hasOpsLedger(root)).toBe(true);
  });

  it("(d) TTY prompt aborts on a non-'y' answer and leaves the tree untouched", async () => {
    const root = await seedTree();
    const io = recordingIo(true, "n");
    const outcome = await dispatch(["reset", "--cwd", root], io);
    expect(outcome.exitCode).toBe(1);
    expect(await hasOpsLedger(root)).toBe(true);
  });
});
