import { LedgerError } from "../types.js";
import type {
  SearchProjection,
  SearchProjectionBucket,
  SearchProjectionChange,
  SearchProjectionHealth,
} from "./SearchProjection.js";
import type { SqliteOperationMeasurement } from "../store/sqlite/operationObservability.js";

export const PROJECTION_RETRY_MIN_MS = 25;
export const PROJECTION_RETRY_MAX_MS = 1_000;

export interface ProjectionChangeFrame {
  readonly version: number;
  readonly changes: readonly SearchProjectionChange[];
  readonly foreignLedgers: readonly string[];
  readonly snapshot: readonly SearchProjectionBucket[] | null;
}

export interface ProjectionRecoverySource {
  load(afterVersion: number, rebuild: boolean): ProjectionChangeFrame;
  notify(frame: ProjectionChangeFrame, signal: AbortSignal): Promise<void>;
}

export class ProjectionUnavailableError extends LedgerError {
  override readonly name = "ProjectionUnavailableError";
}

/** The cursor covers both projection acknowledgement and notification enqueue. */
export class SearchProjectionRecovery {
  private cursor = 0;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private pending = 0;
  private failure: string | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryMs = PROJECTION_RETRY_MIN_MS;
  private readonly shutdown = new AbortController();

  constructor(
    private readonly projection: SearchProjection,
    private readonly source: ProjectionRecoverySource,
    private readonly notificationDeadlineMs: number,
  ) {
    if (!Number.isFinite(notificationDeadlineMs) || notificationDeadlineMs <= 0)
      throw new LedgerError("Projection notification deadline must be finite and positive");
  }

  acknowledgedVersion(): number {
    return this.cursor;
  }

  health(): SearchProjectionHealth {
    const health = this.projection.health();
    return {
      ...health,
      state: this.closed
        ? "closed"
        : this.failure !== null || this.pending > 0
          ? "pending"
          : health.state,
      failure: this.failure ?? health.failure,
    };
  }

  async initialize(): Promise<void> {
    const frame = this.source.load(0, true);
    if (frame.snapshot === null)
      throw new LedgerError("Cold projection load did not return a snapshot");
    await this.projection.execute({ kind: "snapshot", buckets: frame.snapshot });
    this.cursor = frame.version;
    await this.reconcile();
  }

  reconcile(measurement?: SqliteOperationMeasurement): Promise<void> {
    if (this.closed)
      return Promise.reject(new ProjectionUnavailableError("Search projection is closed"));
    this.pending += 1;
    const run = this.tail
      .then(async () => {
        if (this.closed) throw new ProjectionUnavailableError("Search projection is closed");
        const rebuild = this.projection.health().state === "recovering";
        const frame = this.source.load(this.cursor, rebuild);
        if (frame.version < this.cursor)
          throw new LedgerError("Projection source version regressed");
        const project = async (): Promise<void> => {
          if (frame.snapshot !== null)
            await this.projection.execute({ kind: "snapshot", buckets: frame.snapshot });
          else if (frame.changes.length > 0)
            await this.projection.execute({ kind: "delta", changes: frame.changes });
        };
        if (measurement === undefined) await project();
        else await measurement.measureAsync("projectionMs", project);
        if (this.closed)
          throw new ProjectionUnavailableError("Search projection closed before notification");
        if (measurement === undefined) await this.notify(frame);
        else await measurement.measureAsync("notificationMs", () => this.notify(frame));
        if (this.closed)
          throw new ProjectionUnavailableError(
            "Search projection closed before cursor acknowledgement",
          );
        this.cursor = frame.version;
        this.failure = null;
        this.retryMs = PROJECTION_RETRY_MIN_MS;
        if (this.retry !== null) {
          clearTimeout(this.retry);
          this.retry = null;
        }
      })
      .catch((error: unknown) => {
        this.failure = error instanceof Error ? error.message : String(error);
        this.scheduleRetry();
        throw new ProjectionUnavailableError(`Search projection unavailable: ${this.failure}`);
      })
      .finally(() => {
        this.pending -= 1;
      });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shutdown.abort(new ProjectionUnavailableError("Search projection is closed"));
    if (this.retry !== null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    await this.projection.execute({ kind: "close" });
    await this.tail;
  }

  private async notify(frame: ProjectionChangeFrame): Promise<void> {
    const notification = new AbortController();
    const cancel = (): void => notification.abort(this.shutdown.signal.reason);
    this.shutdown.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(
      () =>
        notification.abort(
          new ProjectionUnavailableError(
            `Projection notification exceeded ${this.notificationDeadlineMs}ms deadline`,
          ),
        ),
      this.notificationDeadlineMs,
    );
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(notification.signal.reason);
      notification.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([this.source.notify(frame, notification.signal), aborted]);
    } finally {
      clearTimeout(timeout);
      notification.signal.removeEventListener("abort", onAbort);
      this.shutdown.signal.removeEventListener("abort", cancel);
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry !== null) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.reconcile().catch(() => undefined);
    }, this.retryMs);
    this.retry.unref();
    this.retryMs = Math.min(this.retryMs * 2, PROJECTION_RETRY_MAX_MS);
  }
}
