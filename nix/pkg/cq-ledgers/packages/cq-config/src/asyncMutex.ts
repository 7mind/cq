/**
 * A minimal FIFO in-process mutex (T720).
 *
 * The attestation adapters need it for one reason: a single durable connection
 * (a bun:sqlite `Database`, one lockfile holder, one Postgres transaction slot)
 * cannot hold two overlapping units of work. A cross-process lock does not help
 * here — two `await`-interleaved calls on ONE handle are the same process and
 * the same lock holder — so the in-process serialization has to be explicit.
 *
 * Deliberately not the ledger's `store/mutex.ts`: `@cq/ledger` depends on
 * `@cq/config`, never the other way around.
 */

/** Serializes async sections in call order. */
export class AsyncMutex {
  /** Never rejects: every queued section's failure is absorbed here. */
  private tail: Promise<void> = Promise.resolve();

  /**
   * Run `section` once every previously queued section has settled. A throwing
   * section does not poison the queue: the rejection is delivered to its own
   * caller and the next section still runs.
   */
  run<T>(section: () => Promise<T>): Promise<T> {
    const gate = this.tail;
    const result = (async (): Promise<T> => {
      await gate;
      return section();
    })();
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
