/**
 * A trivial async mutex. Use:
 *   const release = await mutex.acquire();
 *   try { ... } finally { release(); }
 *
 * Or as a wrapper:
 *   await mutex.run(async () => { ... });
 */
export class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async acquire(onQueued?: () => void): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this.chain;
    this.chain = next;
    onQueued?.();
    await prior;
    return release;
  }

  async run<T>(fn: () => Promise<T>, onQueued?: () => void): Promise<T> {
    const release = await this.acquire(onQueued);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
