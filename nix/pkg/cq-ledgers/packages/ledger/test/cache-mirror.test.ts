/**
 * Tests for the ~/.cache mirror writer (T312).
 *
 * FsLedgerStore mirrors the file(s) each mutation touched into a per-root dir
 * under $XDG_CACHE_HOME, overwriting a single latest copy in place. The mirror
 * is best-effort and non-blocking: it is fired-and-forgotten after lockfile
 * release (so it can neither block nor unwind the write path) and tracked so
 * `dispose()` drains it. A mirror failure is swallowed so the write still
 * succeeds.
 *
 * These tests redirect the mirror into a tmp dir via XDG_CACHE_HOME (the
 * sanctioned test seam — no FsLedgerStoreOpts flag) and `dispose()` to await
 * the in-flight mirror before asserting. They check:
 *   - the mirrored .cq/<ledger>.md matches the in-repo file byte-for-byte;
 *   - the computed cache dir NAME is `<basename>-<12 lowercase hex>`;
 *   - on archive the archive file + ledgers.yaml also appear under the mirror;
 *   - a deliberately-induced mirror error is swallowed (the write still lands);
 *   - the mirror write is atomic (no torn/`.tmp-` files survive).
 */

import { afterEach, describe, it, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  FsLedgerStore,
  cacheMirrorDir,
  DEFECTS_LEDGER,
  LEDGER_STORAGE_DIRNAME,
} from "../src/index.js";

const dirs: string[] = [];
const savedXdg = process.env.XDG_CACHE_HOME;

afterEach(async () => {
  if (savedXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedXdg;
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tmpDir(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** The expected mirror dir for `absRoot` under `xdg`, computed independently. */
function expectedMirrorDir(xdg: string, absRoot: string): string {
  const suffix = createHash("sha256").update(absRoot).digest("hex").slice(0, 12);
  return path.join(xdg, "cq", "ledgers", `${path.basename(absRoot)}-${suffix}`);
}

describe("cacheMirrorDir — shared path scheme (reused by restore CLI T313)", () => {
  it("computes <basename>-<12 lowercase hex> under $XDG_CACHE_HOME/cq/ledgers", () => {
    const xdg = "/tmp/xdg-cache-home";
    process.env.XDG_CACHE_HOME = xdg;
    const absRoot = "/var/data/my-ledgers";
    const dir = cacheMirrorDir(absRoot);
    expect(dir).toBe(expectedMirrorDir(xdg, absRoot));
    const name = path.basename(dir);
    expect(name).toMatch(/^my-ledgers-[0-9a-f]{12}$/);
  });

  it("disambiguates two roots that share a basename via the hash suffix", () => {
    process.env.XDG_CACHE_HOME = "/tmp/xdg";
    const a = cacheMirrorDir("/a/ledgers");
    const b = cacheMirrorDir("/b/ledgers");
    expect(a).not.toBe(b);
    expect(path.basename(a)).toStartWith("ledgers-");
    expect(path.basename(b)).toStartWith("ledgers-");
  });
});

describe("FsLedgerStore — cache mirror on mutation", () => {
  it("mirrors .cq/<ledger>.md byte-for-byte after create then update", async () => {
    const root = await tmpDir("ledger-mirror-root-");
    const xdg = await tmpDir("ledger-mirror-xdg-");
    process.env.XDG_CACHE_HOME = xdg;

    const store = new FsLedgerStore({ root });
    await store.init();
    const m = await store.createMilestone({ title: "mirror target" });
    const it = await store.createItem(DEFECTS_LEDGER, m.id, {
      status: "open",
      fields: { headline: "d1", severity: "minor" },
    });
    // Update mutates the same file; the mirror must track the latest bytes.
    await store.updateItem(DEFECTS_LEDGER, it.id, { status: "wip" });
    // dispose() drains the fire-and-forget mirror, giving a deterministic
    // post-condition for the assertions below.
    await store.dispose();

    const mirrorDir = expectedMirrorDir(xdg, root);
    // Acceptance: the cache dir NAME is exactly <basename>-<12 lowercase hex>.
    const expectedName = `${path.basename(root)}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
    expect(path.basename(mirrorDir)).toBe(expectedName);
    expect(/^.+-[0-9a-f]{12}$/.test(path.basename(mirrorDir))).toBe(true);

    const repoFile = path.join(root, LEDGER_STORAGE_DIRNAME, `${DEFECTS_LEDGER}.md`);
    const mirrorFile = path.join(mirrorDir, LEDGER_STORAGE_DIRNAME, `${DEFECTS_LEDGER}.md`);
    expect(await readFile(mirrorFile)).toEqual(await readFile(repoFile));
  });

  it("mirrors the archive file + ledgers.yaml on archive", async () => {
    const root = await tmpDir("ledger-mirror-arch-root-");
    const xdg = await tmpDir("ledger-mirror-arch-xdg-");
    process.env.XDG_CACHE_HOME = xdg;

    const store = new FsLedgerStore({ root });
    await store.init();
    const m = await store.createMilestone({ title: "to archive" });
    const it = await store.createItem(DEFECTS_LEDGER, m.id, {
      status: "open",
      fields: { headline: "d1", severity: "minor" },
    });
    await store.updateItem(DEFECTS_LEDGER, it.id, { status: "resolved" });
    await store.updateMilestone(m.id, { status: "done" });
    await store.archiveMilestone(m.id, "done");
    await store.dispose();

    const mirrorDir = expectedMirrorDir(xdg, root);
    // The defects-group archive file appears under the mirror.
    const repoArchive = path.join(root, LEDGER_STORAGE_DIRNAME, "archive", DEFECTS_LEDGER, `${m.id}.md`);
    const mirrorArchive = path.join(mirrorDir, LEDGER_STORAGE_DIRNAME, "archive", DEFECTS_LEDGER, `${m.id}.md`);
    expect(await readFile(mirrorArchive)).toEqual(await readFile(repoArchive));
    // The registry (rewritten on archive) is re-mirrored.
    const repoRegistry = path.join(root, LEDGER_STORAGE_DIRNAME, "ledgers.yaml");
    const mirrorRegistry = path.join(mirrorDir, LEDGER_STORAGE_DIRNAME, "ledgers.yaml");
    expect(await readFile(mirrorRegistry)).toEqual(await readFile(repoRegistry));
  });

  it("mirrors ledgers.yaml on createLedger", async () => {
    const root = await tmpDir("ledger-mirror-create-root-");
    const xdg = await tmpDir("ledger-mirror-create-xdg-");
    process.env.XDG_CACHE_HOME = xdg;

    const store = new FsLedgerStore({ root });
    await store.init();
    await store.createLedger("xledger", {
      statusValues: ["open", "done"],
      terminalStatuses: ["done"],
      fields: { headline: { type: "string", required: true } },
    });
    await store.dispose();

    const mirrorDir = expectedMirrorDir(xdg, root);
    const repoRegistry = path.join(root, LEDGER_STORAGE_DIRNAME, "ledgers.yaml");
    const mirrorRegistry = path.join(mirrorDir, LEDGER_STORAGE_DIRNAME, "ledgers.yaml");
    expect(await readFile(mirrorRegistry)).toEqual(await readFile(repoRegistry));
  });

  it("swallows a mirror error: the write still succeeds and the item is present", async () => {
    const root = await tmpDir("ledger-mirror-fail-root-");
    // Point XDG_CACHE_HOME at a path whose ancestor is a regular FILE, so the
    // mirror's mkdir/atomicWrite throws ENOTDIR. This is a deliberately-induced
    // mirror failure that must be swallowed (post-lock isolation).
    const blockerDir = await tmpDir("ledger-mirror-fail-xdg-");
    const blockerFile = path.join(blockerDir, "not-a-dir");
    await writeFile(blockerFile, "x", "utf8");
    process.env.XDG_CACHE_HOME = path.join(blockerFile, "cache");

    const store = new FsLedgerStore({ root });
    await store.init();
    const m = await store.createMilestone({ title: "mirror should fail" });
    const it = await store.createItem(DEFECTS_LEDGER, m.id, {
      status: "open",
      fields: { headline: "survives", severity: "minor" },
    });

    // The write succeeded despite the (scheduled) mirror failure: the item is
    // present in-memory AND on disk.
    expect(it.fields["headline"]).toBe("survives");
    const onDisk = store.fetchItem(DEFECTS_LEDGER, it.id);
    expect(onDisk.fields["headline"]).toBe("survives");
    const repoFile = path.join(root, LEDGER_STORAGE_DIRNAME, `${DEFECTS_LEDGER}.md`);
    expect((await readFile(repoFile, "utf8")).includes("survives")).toBe(true);

    // dispose() drains the failed mirror without throwing (error swallowed).
    await store.dispose();
  });

  it("writes the mirror atomically — no stray .tmp- files survive", async () => {
    const root = await tmpDir("ledger-mirror-atomic-root-");
    const xdg = await tmpDir("ledger-mirror-atomic-xdg-");
    process.env.XDG_CACHE_HOME = xdg;

    const store = new FsLedgerStore({ root });
    await store.init();
    const m = await store.createMilestone({ title: "atomic" });
    await store.createItem(DEFECTS_LEDGER, m.id, {
      status: "open",
      fields: { headline: "d1", severity: "minor" },
    });
    await store.dispose();

    const mirrorDir = expectedMirrorDir(xdg, root);
    const docsMirror = path.join(mirrorDir, LEDGER_STORAGE_DIRNAME);
    const names = await readdir(docsMirror);
    // The final file landed via rename; no temp artifacts remain.
    expect(names.some((n) => n.includes(".tmp-"))).toBe(false);
    const mirrorFile = path.join(docsMirror, `${DEFECTS_LEDGER}.md`);
    expect((await stat(mirrorFile)).isFile()).toBe(true);
  });
});
