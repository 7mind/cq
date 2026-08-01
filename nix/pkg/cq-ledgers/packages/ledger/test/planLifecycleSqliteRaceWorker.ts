import { SqliteLedgerStore, TASKS_LEDGER } from "../src/index.js";
import type { PlanLifecycleSerializationContender } from "../src/store/planLifecycleSerialization.js";
import type {
  SqliteRaceWorkerRequest,
  SqliteRaceWorkerResponse,
} from "./planLifecycleSqliteRaceProtocol.js";

const HOLD_STATE_INDEX = 0;
const HOLDING = 1;
const RELEASED = 2;
const WORKER_HOLD_TIMEOUT_MS = 15_000;

function send(response: SqliteRaceWorkerResponse): void {
  postMessage(response);
}

function holdTransaction(
  request: SqliteRaceWorkerRequest,
  contender: PlanLifecycleSerializationContender,
): void {
  if (request.expected === null || request.holdBuffer === null) return;
  if (contender !== request.expected) {
    throw new Error(
      `wrong serialization boundary arrival: expected ${request.expected}, received ${contender}`,
    );
  }
  const state = new Int32Array(request.holdBuffer);
  const previous = Atomics.compareExchange(state, HOLD_STATE_INDEX, 0, HOLDING);
  if (previous !== 0) {
    throw new Error(`duplicate serialization boundary arrival: ${contender}`);
  }
  send({ type: "held", contender });
  const waitResult = Atomics.wait(state, HOLD_STATE_INDEX, HOLDING, WORKER_HOLD_TIMEOUT_MS);
  if (waitResult === "timed-out") {
    throw new Error(
      `timed out after ${String(WORKER_HOLD_TIMEOUT_MS)}ms holding ${contender} serialization boundary`,
    );
  }
  if (Atomics.load(state, HOLD_STATE_INDEX) !== RELEASED) {
    throw new Error(`invalid release state for ${contender} serialization boundary`);
  }
}

self.onmessage = (event: MessageEvent<SqliteRaceWorkerRequest>): void => {
  const request = event.data;
  void (async () => {
    const store = new SqliteLedgerStore({
      dbPath: request.dbPath,
      planSerializationBoundaryHook: (contender) => holdTransaction(request, contender),
    });
    try {
      await store.init();
      switch (request.operation.kind) {
        case "task-start":
          await store.updateItem(TASKS_LEDGER, request.operation.taskId, {
            status: "wip",
            author: request.operation.provenance.author,
            ...(request.operation.provenance.session === undefined
              ? {}
              : { session: request.operation.provenance.session }),
          });
          send({ type: "result", result: undefined });
          break;
        case "task-block":
          await store.updateItem(TASKS_LEDGER, request.operation.taskId, {
            status: "blocked",
            author: request.operation.provenance.author,
            ...(request.operation.provenance.session === undefined
              ? {}
              : { session: request.operation.provenance.session }),
          });
          send({ type: "result", result: undefined });
          break;
        case "follow-up-claim":
          send({
            type: "result",
            result: await store.claimPlan(request.operation.input),
          });
          break;
      }
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await store.dispose();
    }
  })();
};
