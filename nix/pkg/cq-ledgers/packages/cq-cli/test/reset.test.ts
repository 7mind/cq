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
 *   - K117 (was T505's hard refusal): a cq.toml-less legacy root resolves to
 *     the DEFAULT xdg backend — construction emits the legacy-shadow warning
 *     and, on a non-git tmp root, fails with ProjectKeyResolutionError; the
 *     in-tree ledger survives untouched. An EXPLICIT backend='fs' takes the
 *     warn-and-open path, restoring the pre-T505 FS backup→reinit reset.
 *
 * Seeds the tmp tree with the FsLedgerStore directly (a legacy .cq/ tree on
 * disk, exactly what a pre-migration repo looks like).
 */

import { describe, it, expect, afterAll, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  LEDGER_STORAGE_DIRNAME,
  ProjectKeyResolutionError,
  type LedgerSchema,
} from "@cq/ledger";
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
  it("(a — K117) --yes on a cq.toml-less legacy root: shadow warning, then ProjectKeyResolutionError on a non-git root; tree untouched", async () => {
    const root = await seedTree();
    const io = recordingIo(false); // non-TTY, but --yes overrides the prompt

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    let err: unknown;
    try {
      err = await dispatch(["reset", "--cwd", root, "--yes"], io).then(
        () => null,
        (e: unknown) => e,
      );
      const warned = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(warned).toContain("legacy in-tree ledger");
      expect(warned).toContain("cq migrate");
    } finally {
      stderrSpy.mockRestore();
    }
    // The DEFAULT xdg backend needs a repo identity; a non-git root fails
    // fast — and the legacy in-tree ledger is never the wipe target.
    expect(err).toBeInstanceOf(ProjectKeyResolutionError);

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

  it("(c — K117) TTY 'y' answer proceeds past confirmation; default-xdg construction fails on the non-git root; tree untouched", async () => {
    const root = await seedTree();
    const io = recordingIo(true, "y");
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    let err: unknown;
    try {
      err = await dispatch(["reset", "--cwd", root], io).then(
        () => null,
        (e: unknown) => e,
      );
    } finally {
      stderrSpy.mockRestore();
    }
    // Confirmation was accepted (no refusal exit) — construction then fails
    // on the missing repo identity; the in-tree ledger is untouched.
    expect(err).toBeInstanceOf(ProjectKeyResolutionError);
    expect(await hasOpsLedger(root)).toBe(true);
  });

  it("(e — K117) explicit backend='fs' warns DEPRECATED and restores the pre-T505 FS backup→reinit reset", async () => {
    const root = await seedTree();
    await fs.writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n', "utf8");
    const io = recordingIo(false);

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const outcome = await dispatch(["reset", "--cwd", root, "--yes"], io);
      expect(outcome.exitCode).toBe(0);
      const warned = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(warned).toContain("DEPRECATED");
    } finally {
      stderrSpy.mockRestore();
    }

    // The FS reset ran: a backup snapshot exists and the ops ledger is gone.
    await expect(
      fs.stat(path.join(root, LEDGER_STORAGE_DIRNAME, ".backup")),
    ).resolves.toBeDefined();
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
