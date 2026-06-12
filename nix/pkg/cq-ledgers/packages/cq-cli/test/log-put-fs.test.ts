/**
 * T410: `cq log put` — fs-backend write path integration tests.
 *
 * Acceptance:
 *   - With no cq.toml (fs default), `cq log put --stdin --dest logs/raw/<name>.jsonl`
 *     on a transcript containing a fake AKIA… key produces a file whose content
 *     is redacted ([REDACTED:aws-key]) and otherwise byte-identical.
 *   - A malformed (pretty-printed) .jsonl input exits non-zero citing the
 *     offending line and writes NOTHING.
 *   - A .md summary dest is written redacted but without jsonl validation.
 *   - The atomic write leaves no .tmp orphans on success or failure.
 */

import { describe, it, expect, afterAll } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { runLogPut, parseLogPutArgs, type LogPutIo } from "../src/logPut.js";
import { LEDGER_STORAGE_DIRNAME } from "@cq/ledger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of tmpDirs)
    await fsPromises.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function makeTmpDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(tmpdir(), "cq-log-put-fs-"));
  tmpDirs.push(dir);
  return dir;
}

function makeIo(stdinContent: string): LogPutIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return {
    outs,
    errs,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    readStdin: async () => stdinContent,
  };
}

/**
 * Find any .tmp files directly inside `dir` or any subdirectory.
 * Used to assert atomicWrite leaves no orphans.
 */
async function findTmpOrphans(dir: string): Promise<string[]> {
  const orphans: string[] = [];
  async function walk(d: string): Promise<void> {
    let names: string[];
    try {
      names = await fsPromises.readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(d, name);
      let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
      try {
        stat = await fsPromises.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(full);
      } else if (name.includes(".tmp-")) {
        orphans.push(full);
      }
    }
  }
  await walk(dir);
  return orphans;
}

// ---------------------------------------------------------------------------
// Valid JSONL with redaction
// ---------------------------------------------------------------------------

describe("cq log put fs — .jsonl with redaction", () => {
  it("writes redacted content; AKIA key replaced; byte-identical otherwise", async () => {
    const root = await makeTmpDir();
    const realKey = "AKIAIOSFODNN7EXAMPLE";
    // Two valid JSONL lines; second contains a fake AWS key.
    const rawInput = [
      `{"event":"start","ts":1}`,
      `{"event":"auth","key":"${realKey}"}`,
    ].join("\n") + "\n";

    const expectedRedacted = [
      `{"event":"start","ts":1}`,
      `{"event":"auth","key":"[REDACTED:aws-key]"}`,
    ].join("\n") + "\n";

    const io = makeIo(rawInput);
    const args = parseLogPutArgs(root, [
      "--stdin",
      "--dest",
      "logs/raw/20260101-abc.jsonl",
    ]);
    const outcome = await runLogPut(args, io);

    expect(outcome.exitCode).toBe(0);
    expect(io.errs).toEqual([]);

    const destAbs = path.join(root, LEDGER_STORAGE_DIRNAME, "logs", "raw", "20260101-abc.jsonl");
    const written = await fsPromises.readFile(destAbs, "utf8");
    expect(written).toBe(expectedRedacted);

    // The printed path should be the absolute dest path.
    expect(io.outs).toEqual([destAbs]);

    // No .tmp orphans.
    expect(await findTmpOrphans(root)).toEqual([]);
  });

  it("is idempotent: running again overwrites with same content", async () => {
    const root = await makeTmpDir();
    const rawInput = '{"event":"ok"}\n';
    const args = parseLogPutArgs(root, ["--stdin", "--dest", "logs/raw/idem.jsonl"]);

    const io1 = makeIo(rawInput);
    const outcome1 = await runLogPut(args, io1);
    expect(outcome1.exitCode).toBe(0);

    const io2 = makeIo(rawInput);
    const outcome2 = await runLogPut(args, io2);
    expect(outcome2.exitCode).toBe(0);

    const destAbs = path.join(root, LEDGER_STORAGE_DIRNAME, "logs", "raw", "idem.jsonl");
    const written = await fsPromises.readFile(destAbs, "utf8");
    expect(written).toBe(rawInput);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSONL
// ---------------------------------------------------------------------------

describe("cq log put fs — malformed .jsonl input", () => {
  it("exits non-zero, reports line+reason, writes NOTHING", async () => {
    const root = await makeTmpDir();
    // Pretty-printed JSON is not valid JSONL (multi-line value → second line
    // is not standalone JSON).
    const prettyPrinted = '{\n  "event": "bad"\n}\n';

    const io = makeIo(prettyPrinted);
    const args = parseLogPutArgs(root, [
      "--stdin",
      "--dest",
      "logs/raw/bad.jsonl",
    ]);
    const outcome = await runLogPut(args, io);

    expect(outcome.exitCode).not.toBe(0);
    // Error message must cite the offending line number and a reason.
    expect(io.errs.join("\n")).toMatch(/line \d+/);
    expect(io.errs.join("\n")).toContain("malformed JSONL");

    // The file must NOT have been created.
    const destAbs = path.join(root, LEDGER_STORAGE_DIRNAME, "logs", "raw", "bad.jsonl");
    await expect(fsPromises.stat(destAbs)).rejects.toThrow();

    // No .tmp orphans.
    expect(await findTmpOrphans(root)).toEqual([]);
  });

  it("does not write partial content on validation failure", async () => {
    const root = await makeTmpDir();
    // First line valid, second line is a blank (forbidden in middle of JSONL).
    const input = '{"a":1}\n\n{"b":2}\n';

    const io = makeIo(input);
    const args = parseLogPutArgs(root, ["--stdin", "--dest", "logs/raw/partial.jsonl"]);
    const outcome = await runLogPut(args, io);

    expect(outcome.exitCode).not.toBe(0);

    const destAbs = path.join(root, LEDGER_STORAGE_DIRNAME, "logs", "raw", "partial.jsonl");
    await expect(fsPromises.stat(destAbs)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// .md summary: redacted but no JSONL check
// ---------------------------------------------------------------------------

describe("cq log put fs — .md summary destination", () => {
  it("writes redacted content without JSONL validation", async () => {
    const root = await makeTmpDir();
    // Content that would fail JSONL validation (not JSON) but is valid Markdown.
    const mdContent =
      "# Session Summary\n\nAuth token: AKIAIOSFODNN7EXAMPLE\n\nAll done.\n";
    const expectedRedacted =
      "# Session Summary\n\nAuth token: [REDACTED:aws-key]\n\nAll done.\n";

    const io = makeIo(mdContent);
    const args = parseLogPutArgs(root, [
      "--stdin",
      "--dest",
      "logs/summary/20260101.md",
    ]);
    const outcome = await runLogPut(args, io);

    expect(outcome.exitCode).toBe(0);
    expect(io.errs).toEqual([]);

    const destAbs = path.join(root, LEDGER_STORAGE_DIRNAME, "logs", "summary", "20260101.md");
    const written = await fsPromises.readFile(destAbs, "utf8");
    expect(written).toBe(expectedRedacted);

    // No .tmp orphans.
    expect(await findTmpOrphans(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// From file path (not --stdin)
// ---------------------------------------------------------------------------

describe("cq log put fs — positional src file path", () => {
  it("reads from a file, redacts, and writes to dest", async () => {
    const root = await makeTmpDir();
    // Write a source file with a fake AWS key.
    const srcDir = await fsPromises.mkdtemp(path.join(tmpdir(), "cq-log-src-"));
    tmpDirs.push(srcDir);
    const srcFile = path.join(srcDir, "input.jsonl");
    const rawInput = '{"event":"auth","token":"AKIAIOSFODNN7EXAMPLE"}\n';
    await fsPromises.writeFile(srcFile, rawInput, "utf8");

    const io = makeIo(""); // stdin not used
    const args = parseLogPutArgs(root, [
      srcFile,
      "--dest",
      "logs/raw/from-file.jsonl",
    ]);
    const outcome = await runLogPut(args, io);

    expect(outcome.exitCode).toBe(0);

    const destAbs = path.join(root, LEDGER_STORAGE_DIRNAME, "logs", "raw", "from-file.jsonl");
    const written = await fsPromises.readFile(destAbs, "utf8");
    expect(written).toContain("[REDACTED:aws-key]");
    expect(written).not.toContain("AKIAIOSFODNN7EXAMPLE");

    // No .tmp orphans.
    expect(await findTmpOrphans(root)).toEqual([]);
  });
});
