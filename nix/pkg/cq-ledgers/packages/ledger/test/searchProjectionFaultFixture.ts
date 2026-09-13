import { SearchProjectionCoordinator } from "../src/search/SearchProjection.js";
import type { SearchProjectionCommand, SearchProjection } from "../src/search/SearchProjection.js";
import { searchProjectionWorkerTransport } from "../src/search/WorkerSearchProjection.js";

export type ProjectionFault = "crash" | "exit" | "timeout";
const WORKER_DEADLINE_MS = 1_000;

export class FaultableWorkerProjection {
  readonly commands: SearchProjectionCommand[] = [];
  readonly injected = Promise.withResolvers<void>();
  readonly projection: SearchProjection;
  fault: ProjectionFault | null = null;

  constructor() {
    const workerFactory = searchProjectionWorkerTransport(
      new URL("./searchProjectionFaultWorker.ts", import.meta.url),
    );
    this.projection = new SearchProjectionCoordinator((receiver) => {
      const worker = workerFactory(receiver);
      return {
        send: (request) => {
          this.commands.push(structuredClone(request.command));
          if (request.command.kind === "delta" && this.fault !== null) {
            const fault = this.fault;
            this.fault = null;
            worker.send({ ...request, command: { kind: "search", query: fault, options: {} } });
            this.injected.resolve();
          } else worker.send(request);
        },
        close: () => worker.close(),
      };
    }, WORKER_DEADLINE_MS);
  }
}
