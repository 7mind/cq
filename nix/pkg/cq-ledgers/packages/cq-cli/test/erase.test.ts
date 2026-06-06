/**
 * `cq erase` — the MOST destructive subcommand (T191 / Q110). Reproduce-first:
 * each test populates a tmp root with a full docs/ tree (active ledgers +
 * archive/ + .backup/ + logs/ + .locks/) AND a cq.toml AND a sentinel sibling,
 * then drives runErase through dispatch(["erase", …]) with an injected ConfirmIo.
 *
 * Per the user's answer ("erase should erase everything including archives and
 * config"), erase DESTROYS with NO backup and NO reinit:
 *
 *   - --yes: removes <root>/docs ENTIRELY (incl. archive/.backup/logs/.locks)
 *     AND deletes <root>/cq.toml, exit 0 + a removed-paths summary on io.out;
 *     the sentinel sibling under root SURVIVES (bounded delete, no path escape);
 *     NO ledger is recreated (docs/ is gone, not reinitialised).
 *   - non-TTY without --yes: REFUSES (exit 2) and deletes NOTHING.
 *   - safety: an empty root (no docs/, no cq.toml) REFUSES (exit 2) rather than
 *     silently succeeding.
 *
 * The tree is seeded with FsLedgerStore (the same reader/writer the production
 * path uses) so docs/.locks/, ledgers.yaml and the active *.md exist for real;
 * the store is disposed before erase so no lock collides.
 */

import { describe, it, expect, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FsLedgerStore, type LedgerSchema } from "@cq/ledger";
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
 * Seed a tmp root with: a populated docs/ tree (canonical + a custom `ops`
 * ledger with one item, an archived milestone, a docs/.backup/ snapshot dir,
 * docs/logs/), a cq.toml, and a sentinel sibling file + dir under the root.
 */
async function seedTree(): Promise<{ root: string; docsDir: string; configFile: string }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "cq-erase-"));
  dirs.push(root);

  const store = new FsLedgerStore({ root });
  await store.init();
  await store.createLedger("ops", opsSchema);
  await store.createMilestone({ id: "M1", title: "m1" });
  await store.createItem("ops", "M1", { status: "done", fields: { headline: "seeded" } });
  await store.dispose();

  const docsDir = path.join(root, "docs");
  // Populate archive/ + logs/ + .backup/ so the test asserts erase removes ALL
  // of them (the store already wrote docs/ledgers.yaml, ops.md, .locks/).
  await fs.mkdir(path.join(docsDir, "archive", "ops"), { recursive: true });
  await fs.writeFile(path.join(docsDir, "archive", "ops", "M1.md"), "# archived\n");
  await fs.mkdir(path.join(docsDir, "logs"), { recursive: true });
  await fs.mkdir(path.join(docsDir, ".backup", "20260101-000000"), { recursive: true });
  await fs.writeFile(path.join(docsDir, ".backup", "20260101-000000", "ops.md"), "# backed up\n");
  await fs.writeFile(path.join(docsDir, "logs", "session.log"), "log line\n");

  // The config file at <root>/cq.toml.
  const configFile = path.join(root, "cq.toml");
  await fs.writeFile(configFile, "[ledger]\nname = \"demo\"\n");

  // Sentinel siblings under the root that MUST survive a bounded erase.
  await fs.writeFile(path.join(root, SENTINEL), "do not delete\n");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.ts"), "export const x = 1;\n");

  return { root, docsDir, configFile };
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
  it("(a) --yes removes docs/ ENTIRELY (incl. archive/.backup/logs) + deletes cq.toml; sentinel survives; no reinit", async () => {
    const { root, docsDir, configFile } = await seedTree();

    // Precondition: the full set exists before erase.
    expect(await exists(docsDir)).toBe(true);
    expect(await exists(path.join(docsDir, "archive"))).toBe(true);
    expect(await exists(path.join(docsDir, ".backup"))).toBe(true);
    expect(await exists(path.join(docsDir, "logs"))).toBe(true);
    expect(await exists(configFile)).toBe(true);

    const io = recordingIo(false); // non-TTY, but --yes overrides
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);

    expect(outcome.exitCode).toBe(0);

    // docs/ gone in its ENTIRETY (not just emptied, not reinitialised).
    expect(await exists(docsDir)).toBe(false);
    expect(await exists(path.join(docsDir, "archive"))).toBe(false);
    expect(await exists(path.join(docsDir, ".backup"))).toBe(false);
    expect(await exists(path.join(docsDir, "logs"))).toBe(false);
    expect(await exists(path.join(docsDir, "ledgers.yaml"))).toBe(false);
    // cq.toml deleted.
    expect(await exists(configFile)).toBe(false);

    // Bounded: the root itself + sibling files survive (no whole-root wipe).
    expect(await exists(root)).toBe(true);
    expect(await exists(path.join(root, SENTINEL))).toBe(true);
    expect(await exists(path.join(root, "src", "index.ts"))).toBe(true);

    // Summary reports what was removed.
    const joined = io.outs.join("\n");
    expect(joined).toContain(`removed: ${docsDir}`);
    expect(joined).toContain(`removed: ${configFile}`);
  });

  it("(a') erase does NOT recreate any ledger — docs/ is absent, not a fresh canonical set", async () => {
    const { root, docsDir } = await seedTree();
    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
    expect(outcome.exitCode).toBe(0);
    // No init() ran: docs/ledgers.yaml is not regenerated.
    expect(await exists(docsDir)).toBe(false);
  });

  it("(b) non-TTY without --yes REFUSES (exit 2) and deletes NOTHING", async () => {
    const { root, docsDir, configFile } = await seedTree();
    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", root], io);

    expect(outcome.exitCode).toBe(2);
    expect(io.errs.join("\n")).toContain("--yes");

    // Nothing deleted: docs/ + cq.toml + sentinel all intact.
    expect(await exists(docsDir)).toBe(true);
    expect(await exists(path.join(docsDir, "archive"))).toBe(true);
    expect(await exists(configFile)).toBe(true);
    expect(await exists(path.join(root, SENTINEL))).toBe(true);
  });

  it("(c) bounded to <root>/docs + <root>/cq.toml — no sibling under root is touched", async () => {
    const { root, docsDir, configFile } = await seedTree();
    // Snapshot the sibling set before erase.
    const before = (await fs.readdir(root)).filter((e) => e !== "docs" && e !== "cq.toml").sort();

    const io = recordingIo(false);
    const outcome = await dispatch(["erase", "--cwd", root, "--yes"], io);
    expect(outcome.exitCode).toBe(0);

    // docs/ + cq.toml gone; the remaining root entries are EXACTLY the siblings.
    const after = (await fs.readdir(root)).sort();
    expect(after).toEqual(before);
    expect(after).not.toContain("docs");
    expect(after).not.toContain("cq.toml");
    expect(await exists(docsDir)).toBe(false);
    expect(await exists(configFile)).toBe(false);
  });

  it("(d) safety: empty root (no docs/, no cq.toml) REFUSES (exit 2) rather than silently succeed", async () => {
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
    expect(await exists(yesRoot.docsDir)).toBe(false);

    const noRoot = await seedTree();
    const ioNo = recordingIo(true, "n");
    expect((await dispatch(["erase", "--cwd", noRoot.root], ioNo)).exitCode).toBe(1);
    expect(await exists(noRoot.docsDir)).toBe(true);
  });
});
