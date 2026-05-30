/**
 * Humane startup wrapper around `FsLedgerStore.init()`.
 *
 * Changing a bootstrapped ledger's canonical schema makes `init()` throw a
 * `BootstrapViolationError` against an existing `docs/<ledger>.md` written
 * under the previous schema. Surfacing that as a raw stack trace is not
 * actionable. This wrapper catches ONLY `BootstrapViolationError`, prints a
 * clear instruction to run `cq reset`, and exits non-zero without a stack
 * trace. Every other error propagates unchanged.
 */

import { BootstrapViolationError } from "@cq/ledger";

/** Minimal surface needed from the store — keeps the wrapper test-friendly. */
export type Initable = Readonly<{ init: () => Promise<void> }>;

export type LedgerInitDeps = Readonly<{
  stderr: (s: string) => void;
  exit: (code: number) => never;
}>;

/**
 * Extract the diverged ledger name from a `BootstrapViolationError`. The throw
 * site message is `"... existing <name> ledger has a different schema ..."`.
 * Returns the captured name, or null if the message does not match (in which
 * case the generic guidance is shown without a specific ledger name).
 */
function divergedLedgerName(message: string): string | null {
  const m = /existing (\S+) ledger has a different schema/.exec(message);
  return m?.[1] ?? null;
}

/**
 * Await `store.init()`. On `BootstrapViolationError`, print an actionable
 * message and exit non-zero. The default `deps` use process stderr/exit;
 * tests inject sinks and a throwing `exit` to assert without terminating.
 */
export async function initLedgerStoreOrExit(
  store: Initable,
  deps: LedgerInitDeps = {
    stderr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  },
): Promise<void> {
  try {
    await store.init();
  } catch (err: unknown) {
    if (err instanceof BootstrapViolationError) {
      const name = divergedLedgerName(err.message);
      const ledger = name ?? "<ledger>";
      deps.stderr(
        `cq: cannot start — the ${ledger} ledger's on-disk schema differs from ` +
          `the current build (a schema change).\n` +
          `Run \`cq reset\` to back up and regenerate the ledger files, or remove ` +
          `docs/${ledger}.md + docs/ledgers.yaml manually.\n`,
      );
      deps.exit(1);
      return; // unreachable in production (exit throws); keeps tests honest.
    }
    throw err;
  }
}
