import { describe, expect, test } from "bun:test";
import { SearchProjectionEngine } from "../src/search/DirectSearchProjection.js";
import { SearchProjectionCoordinator } from "../src/search/SearchProjection.js";
import type {
  SearchProjectionReceiver,
  SearchProjectionRequest,
  SearchProjectionTransport,
  SearchProjectionTransportFactory,
} from "../src/search/SearchProjection.js";
import { searchProjectionWorkerTransport } from "../src/search/WorkerSearchProjection.js";

const FAULT_DEADLINE_MS = 500;

/** In-memory delivery queue; faults affect delivery, not the index implementation. */
class QueuedProjectionTransport implements SearchProjectionTransport {
  private readonly requests: SearchProjectionRequest[] = [];
  private readonly engine = new SearchProjectionEngine();
  private closed = false;
  private held = false;

  constructor(private readonly receiver: SearchProjectionReceiver) {}

  send(request: SearchProjectionRequest): void {
    if (this.closed) throw new Error("Cannot send through a closed transport");
    this.requests.push(structuredClone(request));
    queueMicrotask(() => this.drain());
  }

  close(): void {
    this.closed = true;
    this.requests.length = 0;
  }

  private drain(): void {
    if (this.closed || this.held) return;
    const request = this.requests.shift();
    if (request === undefined) return;
    if (request.command.kind === "search") {
      switch (request.command.query) {
        case "crash":
        case "exit":
          this.held = true;
          this.receiver.fail(new Error("injected search worker failure"));
          return;
        case "timeout":
          this.held = true;
          return;
        case "out-of-order":
          this.receiver.acknowledge({
            ...this.engine.execute(request),
            commandId: request.commandId + 1,
          });
          return;
      }
    }
    this.receiver.acknowledge(structuredClone(this.engine.execute(request)));
  }
}

function faultContract(factory: SearchProjectionTransportFactory): void {
  for (const [fault, reason] of [
    ["crash", "generation-failed"],
    ["exit", "generation-failed"],
    ["timeout", "deadline"],
    ["out-of-order", "protocol"],
  ] as const) {
    test(`${fault} settles every pending command once; only a snapshot starts a fresh generation [Blackbox-Group]`, async () => {
      const projection = new SearchProjectionCoordinator(factory, FAULT_DEADLINE_MS);
      try {
        await projection.execute({ kind: "snapshot", buckets: [] });
        let settlements = 0;
        const failed = await Promise.allSettled(
          [
            projection.execute({ kind: "search", query: fault, options: {} }),
            projection.execute({ kind: "health" }),
            projection.execute({ kind: "health" }),
          ].map((command) =>
            command.finally(() => {
              settlements += 1;
            }),
          ),
        );
        expect(settlements).toBe(3);
        for (const result of failed) {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected") expect(result.reason.reason).toBe(reason);
        }
        expect(projection.health()).toMatchObject({
          state: "recovering",
          pendingCommands: 0,
          generation: 1,
        });
        await expect(projection.execute({ kind: "health" })).rejects.toMatchObject({
          reason: "unavailable",
        });
        const rebuilt = await projection.execute({ kind: "snapshot", buckets: [] });
        expect(rebuilt.generation).toBe(2);
        expect(rebuilt.commandId).toBeGreaterThan(4);
        expect(projection.health().state).toBe("current");
        await projection.execute({ kind: "health" });
        expect(settlements).toBe(3);
      } finally {
        await projection.execute({ kind: "close" });
      }
    });
  }
}

describe("queued dummy transport", () =>
  faultContract((receiver) => new QueuedProjectionTransport(receiver)));
describe("Bun worker transport", () =>
  faultContract(
    searchProjectionWorkerTransport(new URL("./searchProjectionFaultWorker.ts", import.meta.url)),
  ));

test("invalid command deadlines reject at construction [Blackbox-Atomic]", () => {
  for (const deadline of [0, -1, Infinity, NaN]) {
    expect(
      () =>
        new SearchProjectionCoordinator(
          (receiver) => new QueuedProjectionTransport(receiver),
          deadline,
        ),
    ).toThrow("finite and positive");
  }
});
