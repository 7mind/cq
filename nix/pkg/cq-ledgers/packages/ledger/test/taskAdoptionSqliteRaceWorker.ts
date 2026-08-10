import { SqliteLedgerStore, TASKS_LEDGER } from "../src/index.js";

interface RaceWorkerInput {
  readonly dbPath: string;
  readonly taskId: string;
  readonly control: SharedArrayBuffer;
}

declare const self: Worker;

self.onmessage = (event: MessageEvent<RaceWorkerInput>): void => {
  void run(event.data);
};

async function run(input: RaceWorkerInput): Promise<void> {
  const control = new Int32Array(input.control);
  const store = new SqliteLedgerStore({ dbPath: input.dbPath });
  try {
    await store.init();
    self.postMessage({ type: "ready" });
    Atomics.wait(control, 0, 0);
    Atomics.store(control, 0, 2);
    Atomics.notify(control, 0);
    await store.updateItem(TASKS_LEDGER, input.taskId, {
      fields: { resultCommit: "c".repeat(40) },
    });
    self.postMessage({ type: "done" });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await store.dispose();
  }
}
