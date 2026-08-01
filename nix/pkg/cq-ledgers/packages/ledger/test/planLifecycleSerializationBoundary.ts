import type { PlanLifecycleSerializationContender } from "../src/store/planLifecycleSerialization.js";

const DEFAULT_BOUNDARY_TIMEOUT_MS = 5_000;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface ArmedBoundary {
  readonly expected: PlanLifecycleSerializationContender;
  readonly held: Deferred<void>;
  readonly release: Deferred<void>;
  readonly arrivals: PlanLifecycleSerializationContender[];
}

export interface SerializationRaceResult<Holder, Peer> {
  readonly holder: Holder;
  readonly peer: Peer;
  readonly arrivals: readonly PlanLifecycleSerializationContender[];
}

export type SerializationLaunchRole = "holder" | "peer";

export class OneShotSerializationBoundary {
  private armed: ArmedBoundary | null = null;
  private launchRole: SerializationLaunchRole | null = null;

  readonly hook = async (contender: PlanLifecycleSerializationContender): Promise<void> => {
    if (this.armed === null || this.armed.arrivals.length !== 0) return;
    await this.arrive(contender);
  };

  currentLaunchRole(): SerializationLaunchRole | null {
    return this.launchRole;
  }

  expectedContender(): PlanLifecycleSerializationContender | null {
    return this.armed?.expected ?? null;
  }

  async arrive(contender: PlanLifecycleSerializationContender): Promise<void> {
    const armed = this.armed;
    if (armed === null) {
      throw new Error(`serialization boundary arrival was not armed: ${contender}`);
    }
    if (contender !== armed.expected) {
      throw new Error(
        `wrong serialization boundary arrival: expected ${armed.expected}, received ${contender}`,
      );
    }
    if (armed.arrivals.length !== 0) {
      throw new Error(`duplicate serialization boundary arrival: ${contender}`);
    }
    armed.arrivals.push(contender);
    armed.held.resolve();
    await armed.release.promise;
  }

  async race<Holder, Peer>(
    contender: PlanLifecycleSerializationContender,
    startHolder: () => Promise<Holder>,
    startPeer: () => Promise<Peer>,
    timeoutMs?: number,
  ): Promise<SerializationRaceResult<Holder, Peer>> {
    if (this.armed !== null) {
      throw new Error(`serialization boundary is already armed for ${this.armed.expected}`);
    }
    const armed: ArmedBoundary = {
      expected: contender,
      held: deferred<void>(),
      release: deferred<void>(),
      arrivals: [],
    };
    this.armed = armed;
    const boundaryTimeoutMs = timeoutMs ?? DEFAULT_BOUNDARY_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(
          new Error(
            `timed out after ${String(boundaryTimeoutMs)}ms waiting for ${contender} serialization boundary`,
          ),
        );
      }, boundaryTimeoutMs);
    });
    const holder = Promise.resolve().then(() => this.launch("holder", startHolder));
    const holderSettledBeforeBoundary = holder.then(
      () => {
        throw new Error(`${contender} holder completed before reaching its serialization boundary`);
      },
      (error: unknown) => Promise.reject(error),
    );
    try {
      await Promise.race([armed.held.promise, holderSettledBeforeBoundary, timedOut]);
      const peerStarted = deferred<void>();
      const peer = Promise.resolve().then(() =>
        this.launch("peer", () => {
          peerStarted.resolve();
          return startPeer();
        }),
      );
      await peerStarted.promise;
      armed.release.resolve();
      const [holderResult, peerResult] = await Promise.all([holder, peer]);
      if (armed.arrivals.length !== 1) {
        throw new Error(
          `expected one ${contender} serialization boundary arrival, received ${String(armed.arrivals.length)}`,
        );
      }
      return {
        holder: holderResult,
        peer: peerResult,
        arrivals: [...armed.arrivals],
      };
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      armed.release.resolve();
      if (this.armed === armed) this.armed = null;
    }
  }

  private launch<T>(role: SerializationLaunchRole, start: () => Promise<T>): Promise<T> {
    this.launchRole = role;
    try {
      return start();
    } finally {
      this.launchRole = null;
    }
  }
}
