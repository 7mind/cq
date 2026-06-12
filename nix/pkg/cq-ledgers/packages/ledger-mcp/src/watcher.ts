/**
 * Filesystem watcher for a ledger root.
 *
 * Watches `<root>/docs` for changes to ledger files (`<ledger>.md`,
 * `ledgers.yaml`) and, after a short debounce, invalidates the store's
 * in-memory cache for the affected ledger and notifies a callback. This is
 * what makes one server process notice writes made by ANOTHER process (the
 * agent's own stdio ledger-mcp, a second UI, a git pull, a hand-edit) — the
 * cache no longer goes stale across processes.
 *
 * Used by both transports: stdio (invalidate only, keeps the agent's reads
 * fresh) and HTTP (invalidate + broadcast a WS `changed` event to UIs).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LEDGER_STORAGE_DIRNAME, type LedgerStore } from "@cq/ledger";

const DEBOUNCE_MS = 150;

export interface LedgerWatcher {
  close(): void;
}

/**
 * Start watching `<root>/docs`. `onChange(ledgerId)` fires after the store
 * cache has been invalidated; `ledgerId` is null for non-ledger-specific
 * changes (e.g. the `ledgers.yaml` registry). Returns a handle to stop it.
 * Never throws — an unwatchable directory yields an inert handle.
 */
export function startLedgerWatcher(
  store: LedgerStore,
  root: string,
  onChange?: (ledgerId: string | null) => void,
): LedgerWatcher {
  const docsDir = path.join(root, LEDGER_STORAGE_DIRNAME);
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: fs.FSWatcher | null = null;

  const fire = (ledgerId: string | null): void => {
    const key = ledgerId ?? "*";
    const existing = pending.get(key);
    if (existing !== undefined) clearTimeout(existing);
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        void (async () => {
          try {
            if (ledgerId !== null) await store.invalidate(ledgerId);
          } catch {
            // A torn read mid-write resolves on the next event; ignore.
          }
          onChange?.(ledgerId);
        })();
      }, DEBOUNCE_MS),
    );
  };

  try {
    // persistent:false so the watcher alone never keeps the process alive
    // (the transport/server does); avoids hanging short-lived runs.
    // The store writes atomically: a temp `<ledger>.md.tmp-<pid>-<ts>-<rand>`
    // renamed onto `<ledger>.md`. inotify surfaces the temp name, so match both
    // the final file and the temp suffix; the debounce then re-reads the final
    // renamed file. Same for the `ledgers.yaml` registry.
    const LEDGER_FILE = /^(.+)\.md(\.tmp-.*)?$/;
    watcher = fs.watch(docsDir, { persistent: false }, (_event, filename) => {
      if (filename === null) return;
      const name = filename.toString();
      const m = LEDGER_FILE.exec(name);
      if (m !== null) fire(m[1]!);
      else if (name === "ledgers.yaml" || name.startsWith("ledgers.yaml.tmp-")) fire(null);
    });
  } catch {
    // docs/ missing or fs.watch unsupported here → inert handle.
  }

  return {
    close(): void {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      watcher?.close();
    },
  };
}
