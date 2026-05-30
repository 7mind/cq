import { describe, it, expect } from "bun:test";
import { BootstrapViolationError } from "@cq/ledger";
import { initLedgerStoreOrExit, type LedgerInitDeps } from "../src/ledgerInit";

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
}

function makeDeps(): { deps: LedgerInitDeps; err: string[] } {
  const err: string[] = [];
  const deps: LedgerInitDeps = {
    stderr: (s) => err.push(s),
    exit: (code) => {
      throw new ExitSignal(code);
    },
  };
  return { deps, err };
}

describe("initLedgerStoreOrExit", () => {
  it("passes through a successful init() with no output and no exit", async () => {
    const { deps, err } = makeDeps();
    let called = false;
    await initLedgerStoreOrExit(
      {
        init: async () => {
          called = true;
        },
      },
      deps,
    );
    expect(called).toBe(true);
    expect(err).toEqual([]);
  });

  it("catches BootstrapViolationError, prints actionable msg naming the ledger, exits 1", async () => {
    const { deps, err } = makeDeps();
    const store = {
      init: async () => {
        throw new BootstrapViolationError(
          "existing goals ledger has a different schema than its canonical bootstrap schema",
        );
      },
    };
    let exitCode: number | undefined;
    try {
      await initLedgerStoreOrExit(store, deps);
    } catch (e) {
      if (e instanceof ExitSignal) exitCode = e.code;
      else throw e;
    }
    expect(exitCode).toBe(1);
    const msg = err.join("");
    // Actionable + names the diverged ledger + points at `cq reset`.
    expect(msg).toContain("goals ledger");
    expect(msg).toContain("cq reset");
    expect(msg).toContain("docs/goals.md");
    // No raw stack trace markers.
    expect(msg).not.toContain("at ");
    expect(msg).not.toContain("BootstrapViolationError:");
  });

  it("does NOT reformat a non-bootstrap error — it propagates unchanged", async () => {
    const { deps, err } = makeDeps();
    const boom = new Error("disk on fire");
    const store = {
      init: async () => {
        throw boom;
      },
    };
    let caught: unknown;
    try {
      await initLedgerStoreOrExit(store, deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
    // No actionable message was printed for a non-bootstrap error.
    expect(err).toEqual([]);
  });

  it("falls back to generic guidance when the message has no ledger name", async () => {
    const { deps, err } = makeDeps();
    const store = {
      init: async () => {
        throw new BootstrapViolationError("some other bootstrap invariant");
      },
    };
    try {
      await initLedgerStoreOrExit(store, deps);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
    const msg = err.join("");
    expect(msg).toContain("cq reset");
    expect(msg).toContain("<ledger>");
  });
});
