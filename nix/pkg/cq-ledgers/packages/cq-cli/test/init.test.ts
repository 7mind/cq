/**
 * T189 + T338: `cq init` — idempotent create-empty-ledgers-if-none + cq.toml write.
 *
 * T189 asserts (backend PINNED to 'fs' via a pre-existing cq.toml, T501: a
 * fresh `cq init` now defaults to backend='xdg' — see init-xdg.test.ts for
 * that path — so these two FS-legacy-path tests pre-write cq.toml exactly
 * like init-git-object.test.ts pins 'git-object', keeping their original,
 * still-supported-legacy-path intent unaffected by the new default):
 *   (a) On an empty dir, creates .cq/ledgers.yaml + canonical .cq/*.md files.
 *   (b) Running again is a no-op that preserves items written between runs.
 *
 * T338 asserts, on a truly FRESH init (git repo + XDG_STATE_HOME override, so
 * the new xdg default resolves and nothing touches the real machine state):
 *   (c) `cq init` on a fresh root creates cq.toml whose content === CQ_TOML_TEMPLATE.
 *   (d) A second `cq init` leaves cq.toml byte-identical and emits the skip message (exit 0).
 *   (e) `cq init --force` overwrites a modified cq.toml back to the template.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  dispatch,
  CQ_CONFIG_FILENAME,
  type ConfirmIo,
  type DispatchIo,
} from "../src/main.js";
import { CQ_TOML_TEMPLATE } from "../src/cqTomlTemplate.js";
import { FsLedgerStore, CANONICAL_LEDGERS, MILESTONES_AMBIENT_ID, LEDGER_STORAGE_DIRNAME } from "@cq/ledger";

const exec = promisify(execFile);
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const silentConfirm: ConfirmIo = {
  isTty: false,
  out: () => {},
  err: () => {},
  prompt: async () => "",
};

function recordingIo(): DispatchIo & { outs: string[] } {
  const outs: string[] = [];
  return {
    outs,
    out: (l) => outs.push(l),
    err: () => {},
    confirm: silentConfirm,
  };
}

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-init-"));
  dirs.push(dir);
  return dir;
}

/** A throwaway initialised git repo with one commit (needed for the xdg default, T501). */
async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-init-git-"));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# repo\n");
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("cq init", () => {
  it("(a) creates .cq/ledgers.yaml + canonical .cq/*.md on an empty dir (backend='fs' pinned)", async () => {
    const root = await makeTmpDir();
    await writeFile(path.join(root, CQ_CONFIG_FILENAME), '[ledger]\nbackend = "fs"\n', "utf8");
    const io = recordingIo();

    const outcome = await dispatch(["init", "--cwd", root], io);
    expect(outcome.exitCode).toBe(0);

    // .cq/ledgers.yaml must exist
    expect((await stat(path.join(root, LEDGER_STORAGE_DIRNAME, "ledgers.yaml"))).isFile()).toBe(true);

    // Every canonical ledger file must exist
    for (const { name } of CANONICAL_LEDGERS) {
      expect((await stat(path.join(root, LEDGER_STORAGE_DIRNAME, `${name}.md`))).isFile()).toBe(true);
    }

    // Some output was printed
    expect(io.outs.length).toBeGreaterThan(0);
  });

  it("(b) idempotent: second run preserves items written between runs (backend='fs' pinned)", async () => {
    const root = await makeTmpDir();
    await writeFile(path.join(root, CQ_CONFIG_FILENAME), '[ledger]\nbackend = "fs"\n', "utf8");

    // First init
    await dispatch(["init", "--cwd", root], recordingIo());

    // Write an item between runs via the store directly
    const store = new FsLedgerStore({ root });
    await store.init();
    const created = await store.createItem("tasks", MILESTONES_AMBIENT_ID, {
      status: "planned",
      fields: { headline: "sentinel task" },
    });
    await store.dispose();

    // Second init (should be a no-op)
    const io2 = recordingIo();
    const outcome2 = await dispatch(["init", "--cwd", root], io2);
    expect(outcome2.exitCode).toBe(0);

    // The sentinel item must still be present
    const store2 = new FsLedgerStore({ root });
    await store2.init();
    const fetched = store2.fetchItem("tasks", created.id);
    await store2.dispose();

    expect(fetched.fields["headline"]).toBe("sentinel task");
  });

  describe("on a fresh root (xdg default, T501)", () => {
    let originalXdgStateHome: string | undefined;

    beforeEach(async () => {
      originalXdgStateHome = process.env["XDG_STATE_HOME"];
      const xdgHome = await mkdtemp(path.join(tmpdir(), "cq-init-xdg-home-"));
      dirs.push(xdgHome);
      process.env["XDG_STATE_HOME"] = xdgHome;
    });

    afterEach(() => {
      if (originalXdgStateHome === undefined) {
        delete process.env["XDG_STATE_HOME"];
      } else {
        process.env["XDG_STATE_HOME"] = originalXdgStateHome;
      }
    });

    it("(c) cq init creates cq.toml with content === CQ_TOML_TEMPLATE", async () => {
      const root = await gitRepo();
      const io = recordingIo();
      const outcome = await dispatch(["init", "--cwd", root], io);
      expect(outcome.exitCode).toBe(0);

      const configPath = path.join(root, CQ_CONFIG_FILENAME);
      const content = await readFile(configPath, "utf8");
      expect(content).toBe(CQ_TOML_TEMPLATE);

      // output should mention writing the config file
      expect(io.outs.some((l) => l.includes("wrote") && l.includes(CQ_CONFIG_FILENAME))).toBe(true);
    });

    it("(d) second cq init leaves cq.toml byte-identical and emits skip message (exit 0)", async () => {
      const root = await gitRepo();
      await dispatch(["init", "--cwd", root], recordingIo());

      const configPath = path.join(root, CQ_CONFIG_FILENAME);
      const before = await readFile(configPath, "utf8");
      expect(before).toBe(CQ_TOML_TEMPLATE);

      const io2 = recordingIo();
      const outcome2 = await dispatch(["init", "--cwd", root], io2);
      expect(outcome2.exitCode).toBe(0);

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(before);

      // skip message should mention --force
      expect(io2.outs.some((l) => l.includes("already exists") && l.includes("--force"))).toBe(true);
    });

    it("(e) cq init --force overwrites a modified cq.toml back to the template", async () => {
      const root = await gitRepo();
      await dispatch(["init", "--cwd", root], recordingIo());

      const configPath = path.join(root, CQ_CONFIG_FILENAME);
      // Modify the file
      await writeFile(configPath, "# modified\n", "utf8");
      const modified = await readFile(configPath, "utf8");
      expect(modified).toBe("# modified\n");

      const io2 = recordingIo();
      const outcome2 = await dispatch(["init", "--cwd", root, "--force"], io2);
      expect(outcome2.exitCode).toBe(0);

      const after = await readFile(configPath, "utf8");
      expect(after).toBe(CQ_TOML_TEMPLATE);

      // output should mention overwriting
      expect(io2.outs.some((l) => l.includes("overwrote") && l.includes(CQ_CONFIG_FILENAME))).toBe(true);
    });
  });
});
