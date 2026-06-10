/**
 * Ref-sha coherence watcher for the git-object ledger backend.
 *
 * Polls `refs/heads/<branch>` for sha changes via `git rev-parse --verify`
 * (git resolves loose/packed/indirection itself — never a hard-coded
 * `.git/refs/heads/…` path, safe under linked worktrees and GIT_DIR overrides)
 * and, on a change, calls `store.invalidate(<ledgerId>)` for each known ledger
 * then fires the optional `onChange` callback (same shape as startLedgerWatcher)
 * so the HTTP host can broadcast the WS `ledger.changed` frame.
 *
 * The poll interval reuses DEBOUNCE_MS from the existing fs-watcher so both
 * coherence paths share the same latency budget. A `GitRunner` is injected so
 * tests can drive it deterministically against a throwaway repo without relying
 * on a real filesystem clock.
 *
 * Usage mirrors {@link startLedgerWatcher}: call it at startup, keep the
 * returned handle, call `.close()` to stop polling. Per-backend wiring (which
 * transport uses which watcher) is owned by the construction site (T357); THIS
 * module only defines and exports the watcher.
 */

import type { LedgerStore } from "@cq/ledger";
import type { GitRunner } from "@cq/ledger";

/** Shared poll/debounce cadence (milliseconds), mirrors DEBOUNCE_MS in watcher.ts. */
export const REF_POLL_MS = 150;

/** Stop handle returned by {@link startLedgerRefWatcher}. */
export interface LedgerRefWatcher {
  close(): void;
}

/**
 * Start polling `refs/heads/<branch>` for sha changes. On each poll, if the
 * sha differs from the last observed value:
 *  - calls `store.invalidate(ledgerId)` for every ledger currently known to the
 *    store;
 *  - calls `onChange(ledgerId)` for each such ledger (null if there are none,
 *    matching the convention of startLedgerWatcher for registry-only changes).
 *
 * The ref is resolved via `git rev-parse --verify refs/heads/<branch>` so git
 * handles loose/packed-refs and git-dir indirection transparently — no
 * `.git/refs/…` path is ever constructed.
 *
 * @param store     The store to invalidate on ref advance.
 * @param branch    Short branch name (default `"cq-ledger"`).
 * @param runner    Injected {@link GitRunner} bound to the repo root. When
 *                  omitted the watcher is inert (useful for tests that want to
 *                  skip git entirely).
 * @param onChange  Optional callback fired after each per-ledger invalidate,
 *                  matching the shape of startLedgerWatcher's onChange.
 * @param pollMs    Override poll interval (default {@link REF_POLL_MS}).
 */
export function startLedgerRefWatcher(
  store: LedgerStore,
  branch: string = "cq-ledger",
  runner?: GitRunner,
  onChange?: (ledgerId: string | null) => void,
  pollMs: number = REF_POLL_MS,
): LedgerRefWatcher {
  if (runner === undefined) {
    // No runner injected — return an inert handle.
    return { close() {} };
  }

  const ref = `refs/heads/${branch}`;
  let lastSha: string | null | undefined = undefined; // undefined = not yet polled
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const readRef = async (): Promise<string | null> => {
    const res = await runner(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (res.code !== 0) return null;
    const sha = res.stdout.trim();
    return sha.length > 0 ? sha : null;
  };

  const poll = (): void => {
    if (closed) return;
    void (async () => {
      try {
        const sha = await readRef();
        if (lastSha !== undefined && sha !== lastSha) {
          // The ref advanced — invalidate every known ledger then notify.
          const ledgerIds = store.enumerate();
          if (ledgerIds.length === 0) {
            onChange?.(null);
          } else {
            for (const id of ledgerIds) {
              try {
                await store.invalidate(id);
              } catch {
                // A torn read mid-write resolves on the next poll; ignore.
              }
              onChange?.(id);
            }
          }
        }
        lastSha = sha;
      } catch {
        // Transient git error — skip this poll, try again next interval.
      }
      if (!closed) {
        timer = setTimeout(poll, pollMs);
      }
    })();
  };

  // Start the first poll after one interval (lets the store finish init first).
  timer = setTimeout(poll, pollMs);

  return {
    close(): void {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
