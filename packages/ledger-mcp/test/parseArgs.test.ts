/**
 * parseArgs ledger-root resolution: --cwd > $LEDGER_ROOT > process CWD, with
 * relative values resolved against the CWD. The CWD default is what lets one
 * global install serve per-repo ledgers.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "../src/main.js";

const savedEnv = process.env["LEDGER_ROOT"];
afterEach(() => {
  if (savedEnv === undefined) delete process.env["LEDGER_ROOT"];
  else process.env["LEDGER_ROOT"] = savedEnv;
});

describe("parseArgs ledger-root resolution", () => {
  it("defaults to the process CWD when nothing is given", () => {
    delete process.env["LEDGER_ROOT"];
    expect(parseArgs([]).cwd).toBe(process.cwd());
  });

  it("uses $LEDGER_ROOT when set and no --cwd", () => {
    process.env["LEDGER_ROOT"] = "/srv/ledgers";
    expect(parseArgs([]).cwd).toBe("/srv/ledgers");
  });

  it("--cwd takes precedence over $LEDGER_ROOT", () => {
    process.env["LEDGER_ROOT"] = "/srv/ledgers";
    expect(parseArgs(["--cwd", "/work/repo"]).cwd).toBe("/work/repo");
  });

  it("resolves a relative --cwd against the process CWD", () => {
    delete process.env["LEDGER_ROOT"];
    expect(parseArgs(["--cwd", "sub/dir"]).cwd).toBe(path.resolve("sub/dir"));
  });

  it("keeps an absolute --cwd unchanged and still parses --http", () => {
    const a = parseArgs(["--cwd", "/abs/root", "--http", "7777"]);
    expect(a.cwd).toBe("/abs/root");
    expect(a.http).toEqual({ host: "127.0.0.1", port: 7777 });
  });

  it("defaults reset/yes to false", () => {
    delete process.env["LEDGER_ROOT"];
    const a = parseArgs([]);
    expect(a.reset).toBe(false);
    expect(a.yes).toBe(false);
  });

  it("recognises --reset and honours --cwd root resolution", () => {
    delete process.env["LEDGER_ROOT"];
    const a = parseArgs(["--cwd", "sub/dir", "--reset"]);
    expect(a.reset).toBe(true);
    expect(a.yes).toBe(false);
    expect(a.cwd).toBe(path.resolve("sub/dir"));
  });

  it("recognises --yes and the -y alias", () => {
    expect(parseArgs(["--reset", "--yes"]).yes).toBe(true);
    expect(parseArgs(["--reset", "-y"]).yes).toBe(true);
  });
});
