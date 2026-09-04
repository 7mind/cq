import {
  PostgresLedgerStore,
  TASKS_LEDGER,
  type LedgerStore,
} from "../src/index.js";
import { openPgPool } from "../src/store/postgres/connection.js";
import type { SQL } from "bun";

type PersistentRaceWorkerInput =
  {
    readonly backend: "postgres";
    readonly pgUrl: string;
    readonly projectKey: string;
    readonly taskId: string;
    readonly control: SharedArrayBuffer;
  };

declare const self: Worker;

self.onmessage = (event: MessageEvent<PersistentRaceWorkerInput>): void => {
  void run(event.data);
};

async function run(input: PersistentRaceWorkerInput): Promise<void> {
  const control = new Int32Array(input.control);
  let store: LedgerStore | null = null;
  let observer: SQL | null = null;
  try {
    const opened = openStore(input, control);
    store = opened.store;
    observer = opened.observer;
    await store.init();
    self.postMessage({ type: "ready" });
    Atomics.wait(control, 0, 0);
    if (observer === null || opened.applicationName === null) {
      throw new Error("PostgreSQL race worker opened without its lock observer");
    }
    await updateAfterPostgresLockWait(store, observer, opened.applicationName, input, control);
    self.postMessage({ type: "done" });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (store !== null) await store.dispose();
    if (observer !== null) await observer.close({ timeout: 0 });
  }
}

interface OpenedStore {
  readonly store: LedgerStore;
  readonly observer: SQL | null;
  readonly applicationName: string | null;
}

function openStore(input: PersistentRaceWorkerInput, _control: Int32Array): OpenedStore {
  const applicationName = `cq-task-adoption-${crypto.randomUUID()}`;
  const storeUrl = new URL(input.pgUrl);
  storeUrl.searchParams.set("application_name", applicationName);
  return {
    store: new PostgresLedgerStore({
      pool: openPgPool(storeUrl.href),
      projectKey: input.projectKey,
      displayName: input.projectKey,
    }),
    observer: openPgPool(input.pgUrl),
    applicationName,
  };
}

async function updateAfterPostgresLockWait(
  store: LedgerStore,
  observer: SQL,
  applicationName: string,
  input: PersistentRaceWorkerInput,
  control: Int32Array,
): Promise<void> {
  let settled = false;
  let failure: unknown;
  const mutation = updateResultCommit(store, input.taskId);
  void mutation.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      failure = error;
    },
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await observer<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE application_name = ${applicationName}
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query ILIKE '%UPDATE items%'
      ) AS waiting
    `;
    if (rows[0]?.waiting === true) break;
    if (settled) {
      if (failure !== undefined) throw failure;
      throw new Error("PostgreSQL contender completed before reaching its row-lock boundary");
    }
    if (Date.now() >= deadline) {
      throw new Error("PostgreSQL contender did not reach its row-lock boundary");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  acknowledgeBoundary(control);
  await mutation;
}

function updateResultCommit(store: LedgerStore, taskId: string): Promise<unknown> {
  return store.updateItem(TASKS_LEDGER, taskId, {
    fields: { resultCommit: "c".repeat(40) },
  });
}

function acknowledgeBoundary(control: Int32Array): void {
  if (Atomics.compareExchange(control, 0, 1, 2) !== 1) return;
  Atomics.notify(control, 0);
}
