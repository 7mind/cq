/**
 * T839 — per-runtime lease over startXdgCoherenceWatcher.
 * Zero-to-one starts one persistent PRAGMA data_version watcher; one-to-zero closes it.
 */
import type { LedgerStore } from "./LedgerStore.js";
import {
  startXdgCoherenceWatcher,
  type XdgCoherenceWatcher,
} from "./createLedgerStore.js";

export type XdgWatcherFactory = (
  store: LedgerStore,
  dbPath: string,
  pollMs: number,
  onChange?: (ledgerId: string | null) => void,
) => XdgCoherenceWatcher;

export interface XdgWatcherLease {
  acquire(): void;
  release(): void;
  readonly holders: number;
  readonly active: boolean;
}

export interface CreateXdgWatcherLeaseOptions {
  readonly store: LedgerStore;
  readonly dbPath: string;
  readonly pollMs: number;
  readonly onChange?: (ledgerId: string | null) => void;
  readonly startWatcher?: XdgWatcherFactory;
}

export function createXdgWatcherLease(options: CreateXdgWatcherLeaseOptions): XdgWatcherLease {
  const start = options.startWatcher ?? startXdgCoherenceWatcher;
  let holders = 0;
  let watcher: XdgCoherenceWatcher | undefined;
  let starting = false;

  return {
    get holders(): number {
      return holders;
    },
    get active(): boolean {
      return watcher !== undefined;
    },
    acquire(): void {
      if (holders < 0) {
        throw new Error("xdg watcher lease is corrupted");
      }
      holders += 1;
      if (holders !== 1 || starting) return;
      starting = true;
      try {
        watcher = start(options.store, options.dbPath, options.pollMs, options.onChange);
        for (const ledgerId of options.store.enumerate()) {
          void options.store.invalidate(ledgerId);
        }
      } catch (error) {
        holders -= 1;
        watcher = undefined;
        throw error;
      } finally {
        starting = false;
      }
    },
    release(): void {
      if (holders === 0) return;
      holders -= 1;
      if (holders !== 0) return;
      const current = watcher;
      watcher = undefined;
      current?.close();
    },
  };
}
