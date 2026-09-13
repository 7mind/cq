import { SearchProjectionCoordinator } from "./SearchProjection.js";
import type {
  SearchProjection,
  SearchProjectionAcknowledgement,
  SearchProjectionTransportFactory,
} from "./SearchProjection.js";

export function searchProjectionWorkerTransport(workerUrl: URL): SearchProjectionTransportFactory {
  return (receiver) => {
    const worker = new Worker(workerUrl.href, { name: "cq-sqlite-search" });
    worker.onmessage = (event: MessageEvent<SearchProjectionAcknowledgement>) =>
      receiver.acknowledge(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      receiver.fail(new Error(event.message));
    };
    worker.onmessageerror = () =>
      receiver.fail(new Error("Search projection worker message could not be deserialized"));
    worker.addEventListener("close", () =>
      receiver.fail(new Error("Search projection worker exited")),
    );
    return { send: (request) => worker.postMessage(request), close: () => worker.terminate() };
  };
}

export function createWorkerSearchProjection(deadlineMs: number): SearchProjection {
  return new SearchProjectionCoordinator(
    searchProjectionWorkerTransport(new URL("./searchProjectionWorker.ts", import.meta.url)),
    deadlineMs,
  );
}
