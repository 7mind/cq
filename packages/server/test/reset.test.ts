import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CANONICAL_LEDGERS } from "@cq/ledger";
import { runReset, collectArtifacts, type ResetDeps } from "../src/reset";

/**
 * Per-test temp cwd. Seeds a realistic docs/ tree: the bootstrap artifacts
 * (ledgers.yaml + per-ledger .md + .locks/ + an archive/<ledger>/ dir for one
 * ledger) PLUS tracked-style docs that must survive (docs/drafts/x.md and a
 * flat docs/archive/tasks-M0.md).
 */
async function seedDocs(cwd: string): Promise<void> {
  const docs = path.join(cwd, "docs");
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(path.join(docs, "ledgers.yaml"), "version: 1\n");
  for (const { name } of CANONICAL_LEDGERS) {
    await fs.writeFile(path.join(docs, `${name}.md`), `# ${name}\n`);
  }
  // .locks dir with a lockfile.
  await fs.mkdir(path.join(docs, ".locks"), { recursive: true });
  await fs.writeFile(path.join(docs, ".locks", "tasks.lock"), "pid\n");
  // archive/<ledger>/ subdir for ONE bootstrap ledger (in scope) ...
  await fs.mkdir(path.join(docs, "archive", "tasks"), { recursive: true });
  await fs.writeFile(path.join(docs, "archive", "tasks", "M9.md"), "archived\n");
  // ... and a flat docs/archive/tasks-M0.md (TRACKED — must survive).
  await fs.writeFile(path.join(docs, "archive", "tasks-M0.md"), "# M0 archive\n");
  // A tracked-style draft that must survive.
  await fs.mkdir(path.join(docs, "drafts"), { recursive: true });
  await fs.writeFile(path.join(docs, "drafts", "x.md"), "# draft\n");
}

function makeDeps(over: Partial<ResetDeps> = {}): {
  deps: ResetDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const deps: ResetDeps = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    confirm: async () => true,
    now: () => "2026-05-30T12-00-00.000Z",
    stdinIsTty: () => true,
    ...over,
  };
  return { deps, out, err };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

describe("cq reset", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cq-reset-"));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("collectArtifacts derives exactly the bootstrap set (no tracked docs)", async () => {
    await seedDocs(cwd);
    const arts = await collectArtifacts(path.join(cwd, "docs"));
    const rels = arts.map((a) => a.rel).sort();
    const expected = [
      "ledgers.yaml",
      ...CANONICAL_LEDGERS.map((l) => `${l.name}.md`),
      path.join("archive", "tasks"),
      ".locks",
    ].sort();
    expect(rels).toEqual(expected);
    // The flat tracked file is NOT an artifact.
    expect(rels).not.toContain(path.join("archive", "tasks-M0.md"));
    expect(rels.some((r) => r.startsWith("drafts"))).toBe(false);
  });

  it("default run backs up bootstrap files; tracked docs survive", async () => {
    await seedDocs(cwd);
    const { deps, out } = makeDeps();
    const res = await runReset({ cwd, yes: false, backup: true }, deps);
    expect(res.code).toBe(0);

    const docs = path.join(cwd, "docs");
    // Originals gone.
    expect(await exists(path.join(docs, "ledgers.yaml"))).toBe(false);
    expect(await exists(path.join(docs, "tasks.md"))).toBe(false);
    expect(await exists(path.join(docs, ".locks"))).toBe(false);
    expect(await exists(path.join(docs, "archive", "tasks"))).toBe(false);
    // Tracked docs survive.
    expect(await exists(path.join(docs, "drafts", "x.md"))).toBe(true);
    expect(await exists(path.join(docs, "archive", "tasks-M0.md"))).toBe(true);
    // Backed up under .ledger-backup/<ts>/ preserving layout.
    const backupRoot = path.join(docs, ".ledger-backup", "2026-05-30T12-00-00.000Z");
    expect(await exists(path.join(backupRoot, "ledgers.yaml"))).toBe(true);
    expect(await exists(path.join(backupRoot, "tasks.md"))).toBe(true);
    expect(await exists(path.join(backupRoot, ".locks", "tasks.lock"))).toBe(true);
    expect(await exists(path.join(backupRoot, "archive", "tasks", "M9.md"))).toBe(true);
    expect(out.some((l) => l.includes("backed up to"))).toBe(true);
  });

  it("--no-backup removes without a backup dir", async () => {
    await seedDocs(cwd);
    const { deps, out } = makeDeps();
    const res = await runReset({ cwd, yes: false, backup: false }, deps);
    expect(res.code).toBe(0);
    const docs = path.join(cwd, "docs");
    expect(await exists(path.join(docs, "ledgers.yaml"))).toBe(false);
    expect(await exists(path.join(docs, ".ledger-backup"))).toBe(false);
    // Tracked docs still survive.
    expect(await exists(path.join(docs, "drafts", "x.md"))).toBe(true);
    expect(await exists(path.join(docs, "archive", "tasks-M0.md"))).toBe(true);
    expect(out.some((l) => l.includes("removed"))).toBe(true);
  });

  it("confirmation `n` (confirm returns false) aborts; files untouched", async () => {
    await seedDocs(cwd);
    const { deps, out } = makeDeps({ confirm: async () => false });
    const res = await runReset({ cwd, yes: false, backup: true }, deps);
    expect(res.code).toBe(0);
    expect(out).toContain("Aborted.");
    const docs = path.join(cwd, "docs");
    expect(await exists(path.join(docs, "ledgers.yaml"))).toBe(true);
    expect(await exists(path.join(docs, ".ledger-backup"))).toBe(false);
  });

  it("--yes proceeds without invoking confirm", async () => {
    await seedDocs(cwd);
    let called = false;
    const { deps } = makeDeps({
      confirm: async () => {
        called = true;
        return true;
      },
    });
    const res = await runReset({ cwd, yes: true, backup: true }, deps);
    expect(res.code).toBe(0);
    expect(called).toBe(false);
    const docs = path.join(cwd, "docs");
    expect(await exists(path.join(docs, "ledgers.yaml"))).toBe(false);
  });

  it("non-TTY without --yes refuses (no hang), exit non-zero, files untouched", async () => {
    await seedDocs(cwd);
    let confirmCalled = false;
    const { deps, err } = makeDeps({
      stdinIsTty: () => false,
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    const res = await runReset({ cwd, yes: false, backup: true }, deps);
    expect(res.code).toBe(1);
    expect(confirmCalled).toBe(false);
    expect(err.join("\n")).toContain("refusing to reset without confirmation");
    const docs = path.join(cwd, "docs");
    expect(await exists(path.join(docs, "ledgers.yaml"))).toBe(true);
  });

  it("nothing-to-reset prints a clean message and exits 0", async () => {
    await fs.mkdir(path.join(cwd, "docs"), { recursive: true });
    const { deps, out } = makeDeps();
    const res = await runReset({ cwd, yes: true, backup: true }, deps);
    expect(res.code).toBe(0);
    expect(out.join("\n")).toContain("No bootstrapped ledger files to reset");
  });

  it("does not remove a docs/archive/<ledger> entry that is a flat file (not a dir)", async () => {
    // Edge: a same-named flat file under archive must be left untouched —
    // only a directory whose name matches a canonical ledger is in scope.
    const docs = path.join(cwd, "docs");
    await fs.mkdir(path.join(docs, "archive"), { recursive: true });
    await fs.writeFile(path.join(docs, "archive", "tasks"), "flat not dir\n");
    const arts = await collectArtifacts(docs);
    expect(arts.some((a) => a.rel === path.join("archive", "tasks"))).toBe(false);
  });
});
