/**
 * read_log tests (T147 / Q87 / D26).
 *
 * Exercises the FS-store-backed `read_log` capability via the SDK tool factory:
 *  - happy path: reads a file under <root>/docs/logs/
 *  - rejects `..` traversal escaping docs/logs/
 *  - rejects absolute paths resolving outside docs/logs/
 *  - truncates an oversized file and sets `truncated: true`
 *  - rejects a symlink inside docs/logs/ whose target escapes the root (D26)
 *  - surfaces ENOENT for a genuinely missing file (not masked as escape) (D26)
 *
 * The confinement root is the EXPLICIT FsLedgerStore root, not the generic
 * LedgerStore interface (R137 #6); the in-memory not-implemented behaviour is
 * asserted in mcp-tools.test.ts.
 */

import { describe, it, expect, afterAll, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, symlink, unlink, realpath as origRealpath } from "node:fs/promises";
import { promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  createLedgerMcpTools,
  MAX_READ_LOG_BYTES,
  type ReadLogResult,
} from "../src/index.js";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function buildFsStore(): Promise<{ store: FsLedgerStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-readlog-"));
  dirs.push(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  const store = new FsLedgerStore({ root });
  await store.init();
  return { store, root };
}

function callTool(
  tools: ReturnType<typeof createLedgerMcpTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool not found: ${name}`);
  return t.handler(args as never, null) as Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

function decode<T>(result: { content: Array<{ type: string; text: string }> }): T {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

describe("read_log (FS-backed)", () => {
  it("returns the content of a file under <root>/docs/logs/", async () => {
    const { store, root } = await buildFsStore();
    const logsDir = path.join(root, "docs", "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(path.join(logsDir, "session.md"), "hello log\n", "utf8");

    const tools = createLedgerMcpTools(store, (p) => store.readLog(p));
    const res = decode<ReadLogResult>(
      await callTool(tools, "read_log", { path: "session.md" }),
    );
    expect(res.path).toBe("session.md");
    expect(res.content).toBe("hello log\n");
    expect(res.truncated).toBeUndefined();
  });

  it("accepts a repo-relative docs/logs/ path without doubling the prefix", async () => {
    const { store, root } = await buildFsStore();
    const logsDir = path.join(root, "docs", "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(path.join(logsDir, "session.md"), "hello log\n", "utf8");

    const tools = createLedgerMcpTools(store, (p) => store.readLog(p));
    // sessionLogs stores REPO-relative paths ("docs/logs/<file>"). read_log
    // resolves against logsDir, so it must strip a leading docs/logs/ instead of
    // doubling it into <root>/docs/logs/docs/logs/<file> (ENOENT).
    const res = decode<ReadLogResult>(
      await callTool(tools, "read_log", { path: "docs/logs/session.md" }),
    );
    expect(res.content).toBe("hello log\n");
  });

  it("rejects `..` traversal escaping docs/logs/", async () => {
    const { store, root } = await buildFsStore();
    // A secret file directly under docs/ (one level above docs/logs/).
    await writeFile(path.join(root, "docs", "secret.md"), "TOP SECRET", "utf8");
    await mkdir(path.join(root, "docs", "logs"), { recursive: true });

    const tools = createLedgerMcpTools(store, (p) => store.readLog(p));
    await expect(
      callTool(tools, "read_log", { path: "../secret.md" }),
    ).rejects.toThrow(/escapes docs\/logs/);
  });

  it("rejects an absolute path resolving outside docs/logs/", async () => {
    const { store } = await buildFsStore();
    const tools = createLedgerMcpTools(store, (p) => store.readLog(p));
    await expect(
      callTool(tools, "read_log", { path: "/etc/passwd" }),
    ).rejects.toThrow(/absolute paths are not allowed/);
  });

  it("truncates an oversized file and sets truncated:true", async () => {
    const { store, root } = await buildFsStore();
    const logsDir = path.join(root, "docs", "logs");
    await mkdir(logsDir, { recursive: true });
    const big = "x".repeat(MAX_READ_LOG_BYTES + 1024);
    await writeFile(path.join(logsDir, "big.log"), big, "utf8");

    const tools = createLedgerMcpTools(store, (p) => store.readLog(p));
    const res = decode<ReadLogResult>(
      await callTool(tools, "read_log", { path: "big.log" }),
    );
    expect(res.truncated).toBe(true);
    expect(res.content.length).toBe(MAX_READ_LOG_BYTES);
  });

  // D26 regression: symlink escape via realpath
  it("rejects a symlink inside docs/logs/ whose target escapes the root (D26)", async () => {
    const { store, root } = await buildFsStore();
    const logsDir = path.join(root, "docs", "logs");
    await mkdir(logsDir, { recursive: true });
    // Write a "secret" file outside the confinement root (one level above root).
    const outsideFile = path.join(root, "..", "outside-secret.txt");
    await writeFile(outsideFile, "SECRET CONTENT", "utf8");
    // Place a symlink inside docs/logs/ pointing to the outside file.
    await symlink(outsideFile, path.join(logsDir, "escape-link.log"));

    await expect(
      store.readLog("escape-link.log"),
    ).rejects.toThrow(/escapes docs\/logs/);
  });

  // D26 regression: a genuinely missing file must NOT be masked as an escape
  it("surfaces ENOENT for a genuinely missing file (not masked as escape)", async () => {
    const { store, root } = await buildFsStore();
    await mkdir(path.join(root, "docs", "logs"), { recursive: true });

    let threw = false;
    try {
      await store.readLog("nonexistent.log");
    } catch (e: unknown) {
      threw = true;
      // Must NOT be a false "escape" error — it should be an ENOENT from the FS.
      expect(e instanceof Error && e.message.includes("escapes docs/logs")).toBe(false);
      // The error should carry ENOENT in some form.
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as NodeJS.ErrnoException).code;
      const isEnoent = code === "ENOENT" || msg.includes("ENOENT") || msg.includes("no such file");
      expect(isEnoent).toBe(true);
    }
    expect(threw).toBe(true);
  });

  // D28 regression: readLog must read the validated canonical path (`real`),
  // not the raw `resolved` (symlink-bearing) path.  This test reproduces the
  // TOCTOU deterministically: it injects a symlink swap BETWEEN the realpath
  // check and the readFile by spying on fs.realpath.  The spy calls the real
  // realpath, then re-points the symlink to a different target, then returns the
  // canonical result.
  //
  // With the fix (`fs.readFile(real ?? resolved)`): `real` was captured before
  // the swap, so it points to originalTarget.log → content "ORIGINAL" ✓.
  // With the bug (`fs.readFile(resolved)`): `resolved` is the symlink path
  // which now points to swappedTarget.log → content "SWAPPED" ✗.
  //
  // The spy only triggers on the first realpath call (the `resolved` path) so
  // that the second call (`this.logsDir`) is not affected.
  it("reads the canonical (realpath'd) target of an in-root symlink under a post-check swap (D28 TOCTOU)", async () => {
    const { store, root } = await buildFsStore();
    const logsDir = path.join(root, "docs", "logs");
    await mkdir(logsDir, { recursive: true });

    // Two distinct target files with different content.
    const originalTarget = path.join(logsDir, "originalTarget.log");
    const swappedTarget = path.join(logsDir, "swappedTarget.log");
    const linkPath = path.join(logsDir, "link.log");

    await writeFile(originalTarget, "ORIGINAL", "utf8");
    await writeFile(swappedTarget, "SWAPPED", "utf8");
    // link.log initially points at originalTarget.log.
    await symlink(originalTarget, linkPath);

    // Spy on fs.realpath: after resolving link.log → originalTarget, atomically
    // re-point link.log at swappedTarget.log BEFORE readFile executes.  The spy
    // only fires on the FIRST call (the `resolved` path); subsequent calls
    // (for this.logsDir and any retries) pass through to the real implementation.
    let swapDone = false;
    const spy = spyOn(fsPromises, "realpath");
    spy.mockImplementation(async (p, ...rest) => {
      // @ts-expect-error — rest is a valid optional argument
      const canonical = await origRealpath(p as string, ...rest);
      if (!swapDone) {
        swapDone = true;
        // Atomically swap the symlink: link.log now points at swappedTarget.
        await unlink(linkPath);
        await symlink(swappedTarget, linkPath);
      }
      return canonical;
    });

    let result: Awaited<ReturnType<typeof store.readLog>>;
    try {
      result = await store.readLog("link.log");
    } finally {
      spy.mockRestore();
    }

    // With the fix, `real` was captured as originalTarget.log BEFORE the swap.
    // readFile(real) reads originalTarget.log → "ORIGINAL".
    expect(result.content).toBe("ORIGINAL");
    expect(result.path).toBe("link.log");
    expect(result.truncated).toBeUndefined();
  });

  // D26 round-1 regression: readLog must succeed when the store root sits under
  // a symlinked parent directory (e.g. macOS /var -> /private/var, container
  // bind-mounts, /home symlinks). In round-0 the realpath of the target was
  // compared against the lexical this.logsDir; if any parent of the root was
  // itself a symlink, realpath(target) would resolve the symlink in the path
  // while this.logsDir remained lexical, causing a false escape rejection.
  it("succeeds when the store root is accessed via a symlinked parent (D26 round-1)", async () => {
    // Create the real directory.
    const realRoot = await mkdtemp(path.join(tmpdir(), "ledger-readlog-real-"));
    dirs.push(realRoot);
    // Create a symlink that points at realRoot (simulates a symlinked parent).
    const symlinkRoot = path.join(tmpdir(), `ledger-readlog-sym-${process.pid}-${Date.now()}`);
    await symlink(realRoot, symlinkRoot);
    dirs.push(symlinkRoot);

    // Build the store rooted through the SYMLINK path, not the real path.
    const store = new FsLedgerStore({ root: symlinkRoot });
    await store.init();

    // Write a legitimate log file under docs/logs/ (inside the real root).
    const logsDir = path.join(realRoot, "docs", "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(path.join(logsDir, "legit.log"), "legitimate content", "utf8");

    // readLog must SUCCEED — it must NOT falsely reject the read as an escape.
    const result = await store.readLog("legit.log");
    expect(result.content).toBe("legitimate content");
    expect(result.path).toBe("legit.log");
    expect(result.truncated).toBeUndefined();
  });
});
