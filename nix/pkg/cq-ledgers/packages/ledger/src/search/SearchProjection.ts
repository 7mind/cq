import type { Item } from "../types.js";
import { LedgerError } from "../types.js";
import type { FtsSearchHit, FtsSearchOpts } from "./LedgerSearchIndex.js";

export const SEARCH_PROJECTION_COMMAND_DEADLINE_MS = 30_000;

export interface SearchProjectionBucket {
  readonly ledgerId: string;
  readonly archived: boolean;
  readonly items: readonly Item[];
}

export type SearchProjectionChange =
  | {
      readonly kind: "upsert";
      readonly ledgerId: string;
      readonly archived: boolean;
      readonly item: Item;
    }
  | {
      readonly kind: "remove";
      readonly ledgerId: string;
      readonly archived: boolean;
      readonly itemId: string;
    }
  | { readonly kind: "replace-bucket"; readonly bucket: SearchProjectionBucket }
  | { readonly kind: "remove-ledger"; readonly ledgerId: string };

export type SearchProjectionCommand =
  | { readonly kind: "snapshot"; readonly buckets: readonly SearchProjectionBucket[] }
  | { readonly kind: "delta"; readonly changes: readonly SearchProjectionChange[] }
  | { readonly kind: "search"; readonly query: string; readonly options: FtsSearchOpts }
  | { readonly kind: "health" }
  | { readonly kind: "close" };

export interface SearchProjectionHealth {
  readonly state: "current" | "pending" | "recovering" | "closed";
  readonly generation: number;
  readonly acknowledgedCommandId: number;
  readonly pendingCommands: number;
  readonly failure: string | null;
}

export type SearchProjectionResult =
  | { readonly kind: "snapshot" | "delta" | "close" }
  | { readonly kind: "search"; readonly hits: FtsSearchHit[] }
  | { readonly kind: "health"; readonly health: SearchProjectionHealth };

export interface SearchProjectionRequest {
  readonly generation: number;
  readonly commandId: number;
  readonly command: SearchProjectionCommand;
}

export interface SearchProjectionAcknowledgement {
  readonly generation: number;
  readonly commandId: number;
  readonly result: SearchProjectionResult;
}

export interface SearchProjection {
  execute(command: SearchProjectionCommand): Promise<SearchProjectionAcknowledgement>;
  health(): SearchProjectionHealth;
}

export class SearchProjectionError extends LedgerError {
  override readonly name = "SearchProjectionError";

  constructor(
    readonly reason: "closed" | "unavailable" | "generation-failed" | "deadline" | "protocol",
    message: string,
  ) {
    super(message);
  }
}

export interface SearchProjectionTransport {
  send(request: SearchProjectionRequest): void;
  close(): void;
}

export interface SearchProjectionReceiver {
  acknowledge(acknowledgement: SearchProjectionAcknowledgement): void;
  fail(error: Error): void;
}

export type SearchProjectionTransportFactory = (
  receiver: SearchProjectionReceiver,
) => SearchProjectionTransport;

interface PendingCommand {
  readonly kind: SearchProjectionCommand["kind"];
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (acknowledgement: SearchProjectionAcknowledgement) => void;
  readonly reject: (error: SearchProjectionError) => void;
}

/** A failed generation stays unavailable until its owner supplies a fresh snapshot. */
export class SearchProjectionCoordinator implements SearchProjection {
  private generation = 0;
  private commandId = 0;
  private acknowledgedCommandId = 0;
  private ready = false;
  private closed = false;
  private failure: string | null = null;
  private transport: SearchProjectionTransport | null = null;
  private readonly pending = new Map<number, PendingCommand>();

  constructor(
    private readonly createTransport: SearchProjectionTransportFactory,
    private readonly deadlineMs: number,
  ) {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new LedgerError("Search projection command deadline must be finite and positive");
    }
  }

  health(): SearchProjectionHealth {
    return {
      state: this.closed
        ? "closed"
        : !this.ready
          ? "recovering"
          : this.pending.size > 0
            ? "pending"
            : "current",
      generation: this.generation,
      acknowledgedCommandId: this.acknowledgedCommandId,
      pendingCommands: this.pending.size,
      failure: this.failure,
    };
  }

  execute(command: SearchProjectionCommand): Promise<SearchProjectionAcknowledgement> {
    if (this.closed)
      return Promise.reject(new SearchProjectionError("closed", "Search projection is closed"));
    const commandId = ++this.commandId;
    if (command.kind === "close") {
      this.closed = true;
      this.failGeneration(
        new SearchProjectionError("closed", "Search projection closed with pending commands"),
      );
      this.acknowledgedCommandId = commandId;
      return Promise.resolve({ generation: this.generation, commandId, result: { kind: "close" } });
    }
    if (this.transport === null) {
      if (command.kind !== "snapshot") {
        return Promise.reject(
          new SearchProjectionError(
            "unavailable",
            "Search projection requires an acknowledged snapshot",
          ),
        );
      }
      const generation = ++this.generation;
      this.failure = null;
      try {
        this.transport = this.createTransport({
          acknowledge: (ack) => {
            if (generation === this.generation) this.acknowledge(ack);
          },
          fail: (error) => {
            if (generation === this.generation && this.transport !== null)
              this.failGeneration(new SearchProjectionError("generation-failed", error.message));
          },
        });
      } catch (error) {
        const failure = new SearchProjectionError("generation-failed", String(error));
        this.failGeneration(failure);
        return Promise.reject(failure);
      }
    }
    const transport = this.transport;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failGeneration(
          new SearchProjectionError(
            "deadline",
            `Search projection command ${commandId} exceeded ${this.deadlineMs}ms deadline`,
          ),
        );
      }, this.deadlineMs);
      this.pending.set(commandId, { kind: command.kind, timer, resolve, reject });
      try {
        transport.send({ generation: this.generation, commandId, command });
      } catch (error) {
        this.failGeneration(new SearchProjectionError("generation-failed", String(error)));
      }
    });
  }

  private acknowledge(ack: SearchProjectionAcknowledgement): void {
    if (this.closed || this.transport === null || ack.generation !== this.generation) return;
    const first = this.pending.entries().next().value;
    if (first === undefined || first[0] !== ack.commandId || first[1].kind !== ack.result.kind) {
      this.failGeneration(
        new SearchProjectionError(
          "protocol",
          "Search projection acknowledgement is out of order or has the wrong result kind",
        ),
      );
      return;
    }
    const pending = first[1];
    this.pending.delete(ack.commandId);
    clearTimeout(pending.timer);
    this.acknowledgedCommandId = ack.commandId;
    if (ack.result.kind === "snapshot") this.ready = true;
    pending.resolve(
      ack.result.kind === "health"
        ? { ...ack, result: { kind: "health", health: this.health() } }
        : ack,
    );
  }

  private failGeneration(error: SearchProjectionError): void {
    const transport = this.transport;
    this.transport = null;
    this.ready = false;
    this.failure = error.message;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (transport !== null) transport.close();
  }
}
