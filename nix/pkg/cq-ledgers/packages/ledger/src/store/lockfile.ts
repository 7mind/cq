/**
 * Advisory lockfile with stale-PID reclaim.
 *
 * Layout: one lockfile per ledger at `<root>/.cq/.locks/<ledger>.lock`.
 * Content: JSON `{ pid, hostname, startedAt }`.
 *
 * Acquire algorithm:
 *  1. Ensure `.locks/` exists.
 *  2. Open the lockfile with `O_CREAT | O_EXCL | O_WRONLY`.
 *     - On success: write {pid, hostname, startedAt}, fsync, return release().
 *     - On EEXIST: read holder JSON.
 *       - If `pid` is not alive (probed by `process.kill(pid, 0)` which throws
 *         ESRCH), unlink the lockfile and retry the atomic acquire.
 *       - If `pid` IS alive, WAIT: poll the atomic acquire on a short interval
 *         until either it succeeds or `acquireTimeoutMs` elapses, then throw
 *         LedgerBusyError. cq has two legitimate concurrent ledger writers on
 *         one cwd (the in-process FsLedgerStore in the cq server and the
 *         long-lived cq-mcp child); the write-through critical section is short,
 *         so a bounded wait serialises them instead of failing the second writer
 *         (LOCK-D01). The timeout stays bounded so a genuinely stuck holder still
 *         surfaces LedgerBusyError.
 *
 * The `isPidAlive`, `now`, and `sleep` injection points let tests drive a live
 * holder, a fake clock, and deterministic polling without forking a real
 * process or sleeping in real time.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LedgerBusyError } from "../types.js";

export interface LockHolder {
  pid: number;
  hostname: string;
  startedAt: number;
}

/**
 * Outcome of probing the on-disk lockfile body during a contended acquire.
 * `gone` — file absent; `transient` — present but empty/unparseable (holder
 * mid-write); `holder` — a well-formed holder record.
 */
type HolderProbe =
  | { kind: "gone" }
  | { kind: "transient" }
  | { kind: "holder"; holder: LockHolder };

/** Default bounded wait for a live holder before declaring the ledger busy. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5000;
/** Default poll cadence while waiting for a live holder to release. */
const DEFAULT_POLL_INTERVAL_MS = 25;

export interface LockfileOpts {
  /** Override for tests. Defaults to `process.kill(pid, 0)` probe. */
  isPidAlive?: (pid: number) => boolean;
  /** Override for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Override for tests. Defaults to `process.pid`. */
  selfPid?: number;
  /** Override for tests. Defaults to `os.hostname()`. */
  selfHostname?: string;
  /**
   * Maximum time to wait for a LIVE holder to release before throwing
   * LedgerBusyError. Defaults to 5000 ms. Must be bounded so a stuck
   * holder still surfaces an error.
   */
  acquireTimeoutMs?: number;
  /** Poll cadence while waiting for a live holder. Defaults to 25 ms. */
  pollIntervalMs?: number;
  /**
   * Override for tests. Defaults to a real `setTimeout`-based delay. Tests
   * inject a fake clock-advancing sleep so waiting is deterministic and does
   * not consume real time.
   */
  sleep?: (ms: number) => Promise<void>;
}

export class Lockfile {
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly selfPid: number;
  private readonly selfHostname: string;
  private readonly acquireTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: LockfileOpts = {}) {
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.now = opts.now ?? Date.now;
    this.selfPid = opts.selfPid ?? process.pid;
    this.selfHostname = opts.selfHostname ?? os.hostname();
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /**
   * Acquire the lock for `ledgerId` under `locksDir`. Returns a release
   * function which removes the lockfile.
   *
   * On contention with a DEAD holder the stale lockfile is reclaimed
   * (unlink + retry). On contention with a LIVE holder the acquire is
   * polled on `pollIntervalMs` until it succeeds or `acquireTimeoutMs`
   * elapses, after which `LedgerBusyError` is thrown (LOCK-D01).
   */
  async acquire(locksDir: string, ledgerId: string): Promise<() => Promise<void>> {
    await fs.mkdir(locksDir, { recursive: true });
    const lockPath = path.join(locksDir, `${ledgerId}.lock`);

    const tryOnce = async (): Promise<"acquired" | "exists"> => {
      let fh;
      try {
        fh = await fs.open(lockPath, "wx");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return "exists";
        throw e;
      }
      try {
        const holder: LockHolder = {
          pid: this.selfPid,
          hostname: this.selfHostname,
          startedAt: this.now(),
        };
        await fh.writeFile(JSON.stringify(holder), "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      return "acquired";
    };

    const release = async (): Promise<void> => {
      await fs.unlink(lockPath).catch(() => undefined);
    };

    let result = await tryOnce();
    if (result === "acquired") return release;

    // Contended. Wait (with bounded timeout) for the holder to free the lock,
    // reclaiming on the way if the holder is/becomes dead. The deadline is
    // anchored once so an injected fake clock advanced by `sleep` makes the
    // wait deterministic. O_CREAT|O_EXCL (tryOnce) remains the sole arbiter of
    // acquisition, so concurrent waiters cannot both win.
    //
    // `lastHolder` carries the most recently observed concrete holder so the
    // timeout error names the contender even if the final read was transient.
    const deadline = this.now() + this.acquireTimeoutMs;
    let lastHolder: LockHolder = { pid: 0, hostname: "unknown", startedAt: 0 };
    for (;;) {
      const probe = await this.readHolder(lockPath, ledgerId);
      if (probe.kind === "holder") {
        lastHolder = probe.holder;
        if (!this.isPidAlive(probe.holder.pid)) {
          // Confirmed dead holder: reclaim and retry. `unlink().catch(undefined)`
          // tolerates a racing reclaimer; the subsequent tryOnce is the real
          // arbiter, so no double-unlink hazard and no two-acquirer hazard.
          await fs.unlink(lockPath).catch(() => undefined);
          result = await tryOnce();
          if (result === "acquired") return release;
          // Lost the reclaim race to another waiter — fall through to wait.
        }
        // else: a LIVE holder — wait it out (do NOT reclaim).
      }
      // probe.kind === "transient": the lockfile exists but its body is empty
      // or unparseable — a holder is mid-write (between O_EXCL open and the
      // writeFile landing). Do NOT reclaim (that would yank a live holder's
      // in-flight lock and risk two acquirers); just poll again so the holder
      // can finish. probe.kind === "gone": the file vanished; the next tryOnce
      // (below) will simply acquire it.
      if (this.now() >= deadline) {
        throw new LedgerBusyError(ledgerId, lastHolder);
      }
      await this.sleep(this.pollIntervalMs);
      result = await tryOnce();
      if (result === "acquired") return release;
      // Still contended: loop to re-read the holder, re-probe liveness, and
      // re-check the deadline.
    }
  }

  /**
   * Inspect the on-disk lockfile body.
   *  - `gone`: the file does not exist (ENOENT). The next acquire attempt will
   *    just take it.
   *  - `transient`: the file exists but its body is empty or unparseable — a
   *    holder is MID-WRITE (observed after `open(O_CREAT|O_EXCL)` but before its
   *    `writeFile` lands). The caller must NOT reclaim (that would yank a live
   *    holder's in-flight lock and risk two acquirers); it should poll again.
   *  - `holder`: a well-formed holder record; the caller decides reclaim (dead)
   *    vs. wait (live) from its pid liveness.
   * A genuine I/O error (EACCES, EIO, …) is NOT transient and is surfaced as
   * `LedgerBusyError`.
   */
  private async readHolder(lockPath: string, ledgerId: string): Promise<HolderProbe> {
    let text: string;
    try {
      text = await fs.readFile(lockPath, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Disappeared between EEXIST and read.
        return { kind: "gone" };
      }
      // A genuine I/O error (EACCES, EIO, …) — be conservative and report as
      // busy by an unknown holder. This is NOT a transient parse race.
      throw new LedgerBusyError(ledgerId, { pid: 0, hostname: "unknown", startedAt: 0 });
    }

    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      // Empty or partially-written body (mid-write race) or hand-corrupted
      // JSON — transient; poll again rather than reclaiming.
      return { kind: "transient" };
    }
    if (
      obj === null ||
      typeof obj !== "object" ||
      typeof (obj as Record<string, unknown>)["pid"] !== "number"
    ) {
      // Well-formed JSON but missing a numeric pid — treat as transient too;
      // a holder may be in the middle of writing a partial-but-valid-JSON
      // prefix, and we must not reclaim a possibly-live lock.
      return { kind: "transient" };
    }
    const o = obj as Record<string, unknown>;
    return {
      kind: "holder",
      holder: {
        pid: o["pid"] as number,
        hostname: typeof o["hostname"] === "string" ? (o["hostname"] as string) : "unknown",
        startedAt: typeof o["startedAt"] === "number" ? (o["startedAt"] as number) : 0,
      },
    };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    // POSIX semantics: kill(pid, 0) does no signal; throws ESRCH if not alive,
    // EPERM if alive but owned by another user (we treat EPERM as alive).
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}
