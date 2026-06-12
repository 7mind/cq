/**
 * `cq erase` — the MOST destructive subcommand (T191 / Q110). Reproduce-first:
 * each test populates a tmp root with a full .cq/ tree (active ledgers +
 * archive/ + .backup/ + logs/ + .locks/) AND a cq.toml AND a sentinel sibling,
 * then drives runErase through dispatch(["erase", …]) with an injected ConfirmIo.
 *
 * Per the user's answer ("erase should erase everything including archives and
 * config"), erase DESTROYS with NO backup and NO reinit:
 *
 *   - --yes: removes <root>/.cq/ ENTIRELY (incl. archive/.backup/logs/.locks)
 *     AND deletes <root>/cq.toml, exit 0 + a removed-paths summary on io.out;
 *     the sentinel sibling under root SURVIVES (bounded delete, no path escape);
 *     NO ledger is recreated (.cq/ is gone, not reinitialised).
 *   - non-TTY without --yes: REFUSES (exit 2) and deletes NOTHING.
 *   - safety: an empty root (no .cq/, no cq.toml) REFUSES (exit 2) rather than
 *     silently succeeding.
 *
 * The tree is seeded with FsLedgerStore (the same reader/writer the production
 * path uses) so .cq/.locks/, ledgers.yaml and the active *.md exist for real;
 * the store is disposed before erase so no lock collides.
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

/** Name of the sentinel sibling seeded under the root; must survive erase. */
const SENTINEL = "SOURCE_KEEP_ME";

/**
 * Seed a tmp root with: a populated .cq/ tree (canonical + a custom `ops`
 * ledger with one item, an archived milestone, a .cq/.backup/ snapshot dir,
 * .cq/logs/), a cq.toml, and a sentinel sibling file + dir under the root.
 */
async function seedTree(): Promise<{ root: string; storageDir: string; configFile: string }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "cq-erase-"));
  dirs.push(root);

  const store = new FsLedgerStore({ root });
  await store.init();
  await store.createLedger("ops", opsSchema);
  await store.createMilestone({ id: "M1", title: "m1" });
  await store.createItem("ops", "M1", { status: "done", fields: { headline: "seeded" } });
  await store.dispose();

  const storageDir = path.join(root, LEDGER_STORAGE_DIRNAME);
  // Populate archive/ + logs/ + .backup/ so the test asserts erase removes ALL
  // of them (the store already wrote .cq/ledgers.yaml, ops.md, .locks/).
  await fs.mkdir(path.join(storageDir, "archive", "ops"), { recursive: true });
  await fs.writeFile(path.join(storageDir, "archive", "ops", "M1.md"), "# archived\n");
  await fs.mkdir(path.join(storageDir, "logs"), { recursive: true });
  await fs.mkdir(path.join(storageDir, ".backup", "20260101-000000"), { recursive: true });
  await fs.writeFile(path.join(storageDir, ".backup", "20260101-000000", "ops.md"), "# backed up\n");
  await fs.writeFile(path.join(storageDir, "logs", "session.log"), "log line\n");

  // The config file at <root>/cq.toml.
  const configFile = path.join(root, "cq.toml");
  await fs.writeFile(configFile, "[ledger]\nname = \"demo\"\n");

  // Sentinel siblings under the root that MUST survive a bounded erase.
  await fs.writeFile(path.join(root, SENTINEL), "do not delete\n");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.ts"), "export const x = 1;\n");

  return { root, storageDir, configFile };
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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("cq erase", () => {
  it(`(a) --yes removes ${LEDGER_STORAGE_DIRNAME}/ ENTIRELY (incl. archive/.backup/logs) + deletes cq.toml; sentinel survives; no reinit`, async () => {
    const { root, storageDir, configFile } = await seedTree();

    // Precondition: the full set exists before erase.
    expect(await exists(storageDir)).toBe(true);
    expect(await exists(path.join(storageDir, "archive"))).toBe(true);
    expect(await exists(path.join(storageDir, ".backup"))).toBe(true);
    expect(await exists(path.join(storageDir, "logs"))).toBe(true);
    expect(await exists(configFile)).toBe(true);

    const io = recordingIo(false); // non-TTY, but --yes overrides
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);

    expect(outcome.exitCode).toBe(0);

    // .cq/ gone in its ENTIRETY (not just emptied, not reinitialised).
    expect(await exists(storageDir)).toBe(false);
    expect(await exists(path.join(storageDir, "archive"))).toBe(false);
    expect(await exists(path.join(storageDir, ".backup"))).toBe(false);
    expect(await exists(path.join(storageDir, "logs"))).toBe(false);
    expect(await exists(path.join(storageDir, "ledgers.yaml"))).toBe(false);
    // cq.toml deleted.
    expect(await exists(configFile)).toBe(false);

    // Bounded: the root itself + sibling files survive (no whole-root wipe).
    expect(await exists(root)).toBe(true);
    expect(await exists(path.join(root, SENTINEL))).toBe(true);
    expect(await exists(path.join(root, "src", "index.ts"))).toBe(true);

    // Summary reports what was removed.
    const joined = io.outs.join("\n");
    expect(joined).toContain(`removed: ${storageDir}`);
    expect(joined).toContain(`removed: ${configFile}`);
  });

  it(`(a') erase does NOT recreate any ledger — ${LEDGER_STORAGE_DIRNAME}/ is absent, not a fresh canonical set`, async () => {
    const { root, storageDir } = await seedTree();
    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
    expect(outcome.exitCode).toBe(0);
    // No init() ran: .cq/ledgers.yaml is not regenerated.
    expect(await exists(storageDir)).toBe(false);
  });

  it("(b) non-TTY without --yes REFUSES (exit 2) and deletes NOTHING", async () => {
    const { root, storageDir, configFile } = await seedTree();
    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", root], io);

    expect(outcome.exitCode).toBe(2);
    expect(io.errs.join("\n")).toContain("--yes");

    // Nothing deleted: .cq/ + cq.toml + sentinel all intact.
    expect(await exists(storageDir)).toBe(true);
    expect(await exists(path.join(storageDir, "archive"))).toBe(true);
    expect(await exists(configFile)).toBe(true);
    expect(await exists(path.join(root, SENTINEL))).toBe(true);
  });

  it(`(c) bounded to <root>/${LEDGER_STORAGE_DIRNAME} + <root>/cq.toml — no sibling under root is touched`, async () => {
    const { root, storageDir, configFile } = await seedTree();
    // Snapshot the sibling set before erase.
    const before = (await fs.readdir(root)).filter((e) => e !== LEDGER_STORAGE_DIRNAME && e !== "cq.toml").sort();

    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
    expect(outcome.exitCode).toBe(0);

    // .cq/ + cq.toml gone; the remaining root entries are EXACTLY the siblings.
    const after = (await fs.readdir(root)).sort();
    expect(after).toEqual(before);
    expect(after).not.toContain(LEDGER_STORAGE_DIRNAME);
    expect(after).not.toContain("cq.toml");
    expect(await exists(storageDir)).toBe(false);
    expect(await exists(configFile)).toBe(false);
  });

  it(`(d) safety: empty root (no ${LEDGER_STORAGE_DIRNAME}/, no cq.toml) REFUSES (exit 2) rather than silently succeed`, async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "cq-erase-empty-"));
    dirs.push(root);
    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
    expect(outcome.exitCode).toBe(2);
    expect(io.errs.join("\n")).toContain("nothing to erase");
  });

  it("(e) TTY prompt proceeds on 'y'; aborts (exit 1) on anything else", async () => {
    const yesRoot = await seedTree();
    const ioYes = recordingIo(true, "y");
    expect((await dispatch(["erase", "--cwd", yesRoot.root], ioYes)).exitCode).toBe(0);
    expect(await exists(yesRoot.storageDir)).toBe(false);

    const noRoot = await seedTree();
    const ioNo = recordingIo(true, "n");
    expect((await dispatch(["erase", "--cwd", noRoot.root], ioNo)).exitCode).toBe(1);
    expect(await exists(noRoot.storageDir)).toBe(true);
  });

  it(`(f) preserves NON-ledger content under ${LEDGER_STORAGE_DIRNAME}/ and keeps ${LEDGER_STORAGE_DIRNAME}/; project docs/ UNTOUCHED`, async () => {
    const { root, storageDir, configFile } = await seedTree();
    // A sibling docs/ with user files must SURVIVE erase entirely (bounded delete
    // only touches .cq/ and cq.toml — never a project docs/ directory).
    const projectDocs = path.join(root, "docs");
    await fs.mkdir(path.join(projectDocs, "drafts"), { recursive: true });
    await fs.writeFile(path.join(projectDocs, "drafts", "20260101-note.md"), "user note\n");
    await fs.writeFile(path.join(projectDocs, "README.md"), "user readme\n");

    // Also seed a non-ledger file inside the storage dir itself to verify
    // the "preserved" path when .cq/ retains non-ledger content.
    await fs.writeFile(path.join(storageDir, "extra.txt"), "non-ledger\n");

    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
    expect(outcome.exitCode).toBe(0);

    // Ledger artifacts gone from .cq/.
    expect(await exists(path.join(storageDir, "ledgers.yaml"))).toBe(false);
    expect(await exists(path.join(storageDir, "tasks.md"))).toBe(false);
    expect(await exists(path.join(storageDir, "archive"))).toBe(false);
    expect(await exists(path.join(storageDir, "logs"))).toBe(false);
    expect(await exists(path.join(storageDir, ".backup"))).toBe(false);
    expect(await exists(configFile)).toBe(false);

    // Non-ledger content inside .cq/ PRESERVED + .cq/ dir itself retained.
    expect(await exists(storageDir)).toBe(true);
    expect(await exists(path.join(storageDir, "extra.txt"))).toBe(true);

    // Project docs/ directory completely untouched.
    expect(await exists(projectDocs)).toBe(true);
    expect(await exists(path.join(projectDocs, "drafts", "20260101-note.md"))).toBe(true);
    expect(await exists(path.join(projectDocs, "README.md"))).toBe(true);

    // Report mentions the preservation rather than claiming .cq/ removed.
    const joined = io.outs.join("\n");
    expect(joined).toContain(`preserved: ${storageDir}`);
    // .cq/ itself was NOT reported removed (only its ledger artifacts were);
    // exact-line membership avoids matching `removed: <storageDir>/ledgers.yaml`.
    expect(io.outs).not.toContain(`  removed: ${storageDir}`);
  });

  it(`(g) a non-ledger top-level ${LEDGER_STORAGE_DIRNAME}/*.md (not a registered ledger) survives`, async () => {
    const { root, storageDir } = await seedTree();
    // NOT one of the registered ledger names → must NOT be treated as a ledger file.
    await fs.writeFile(path.join(storageDir, "NOTES.md"), "design notes\n");

    const io = recordingIo(false);
    expect((await dispatch(["erase", "--cwd", root, "--yes"], io)).exitCode).toBe(0);

    expect(await exists(path.join(storageDir, "NOTES.md"))).toBe(true);
    expect(await exists(path.join(storageDir, "milestones.md"))).toBe(false); // a real ledger, removed
    expect(await exists(storageDir)).toBe(true);
  });

  it("(h) erase leaves a sibling project docs/ directory and its contents untouched", async () => {
    // Explicit test for the acceptance criterion: erase removes .cq/ storage and
    // leaves a sibling docs/drafts/ file UNTOUCHED.
    const { root, storageDir } = await seedTree();

    // Create the sibling project docs/ with a drafts file.
    const projectDocs = path.join(root, "docs");
    await fs.mkdir(path.join(projectDocs, "drafts"), { recursive: true });
    const draftFile = path.join(projectDocs, "drafts", "20260101-design.md");
    await fs.writeFile(draftFile, "# design notes\n");

    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
    expect(outcome.exitCode).toBe(0);

    // Storage dir removed (no non-ledger content, so it is rmdir'd).
    expect(await exists(storageDir)).toBe(false);

    // Sibling project docs/drafts/ file UNTOUCHED.
    expect(await exists(projectDocs)).toBe(true);
    expect(await exists(draftFile)).toBe(true);
  });
});
