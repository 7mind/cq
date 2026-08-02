import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isProcessGroupAlive,
  isProcessIdentityAlive,
  readProcessIdentity,
  settleProcessGroups,
  type ProcessGroupRegistration,
} from "./processGroup.js";

const IDENTITY_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2;
const FAILURE_KILL_GRACE_MS = 1_000;
const FAILURE_EXIT_WAIT_MS = 1_000;

/**
 * Adapter-neutral description of the fenced bootstrap process. Adapters must
 * apply `detached: true`: that makes the bootstrap PID the process-group ID.
 * Mapping `stdio` unchanged gives the eventual target the adapter's requested
 * inherited descriptors or pipes.
 */
export interface RegisteredLaunchBootstrapSpecification<TStdio> {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly detached: true;
  readonly stdio: TStdio;
}

/** A Bun subprocess or Node ChildProcess plus the small common control surface. */
export interface RegisteredLaunchBootstrap<TProcess, TExit> {
  readonly process: TProcess;
  readonly pid: number | undefined;
  /**
   * Resolves after process closure and every piped descriptor has drained.
   * Node adapters use ChildProcess `close`; Bun adapters must explicitly drain
   * configured output streams in addition to awaiting Subprocess.exited.
   */
  readonly closed: Promise<TExit>;
  terminate(signal: NodeJS.Signals): Promise<void> | void;
}

export interface LaunchRegisteredProcessGroupOptions<TProcess, TExit, TStdio> {
  /** Exact target executable followed by its argument vector. */
  readonly argv: readonly string[];
  /** Target working directory, with direct-spawn relative-path semantics. */
  readonly cwd: string;
  /** Exact environment to give both the transparent bootstrap and target. */
  readonly env: NodeJS.ProcessEnv;
  /** Adapter-specific stdio configuration, forwarded unchanged to the bootstrap. */
  readonly stdio: TStdio;
  /**
   * Spawn the supplied bootstrap specification and return its native handle.
   * Bun and Node adapters implement this with Bun.spawn and child_process.spawn
   * respectively.
   */
  readonly launchBootstrap: (
    specification: RegisteredLaunchBootstrapSpecification<TStdio>,
  ) => RegisteredLaunchBootstrap<TProcess, TExit>;
  /** Publish the mandatory registration while the bootstrap leader is fenced. */
  readonly register: (registration: ProcessGroupRegistration) => Promise<void>;
}

export interface LaunchedRegisteredProcessGroup<TProcess, TExit> {
  readonly process: TProcess;
  readonly registration: ProcessGroupRegistration;
  /** Resolves with the adapter result only after target closure and stdio drain. */
  readonly exited: Promise<TExit>;
}

interface BootstrapStatus {
  readonly nonce: string;
  readonly pgid: number;
  readonly state: "launched" | "failed";
  readonly error?: string;
}

interface ExitObservation {
  settled: boolean;
  error: unknown;
}

function nodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertTarget(argv: readonly string[], cwd: string): void {
  if (argv.length === 0 || argv[0] === undefined || argv[0] === "") {
    throw new Error("@cq/process-control: registered launch target must not be empty");
  }
  if (cwd === "") {
    throw new Error("@cq/process-control: registered launch cwd must not be empty");
  }
}

function targetCwd(cwd: string): string {
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function waitForLeaderIdentity(
  pid: number,
  exit: ExitObservation,
): Promise<ProcessGroupRegistration> {
  const deadline = Date.now() + IDENTITY_TIMEOUT_MS;
  for (;;) {
    const leader = await readProcessIdentity(pid);
    if (leader !== null) {
      if (!isProcessGroupAlive(pid)) {
        throw new Error(
          `@cq/process-control: bootstrap ${pid} is not a detached process-group leader`,
        );
      }
      return { pgid: pid, leader };
    }
    if (exit.settled) {
      if (exit.error !== undefined) throw exit.error;
      throw new Error(
        `@cq/process-control: registered-launch bootstrap ${pid} exited before identity capture`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `@cq/process-control: registered-launch bootstrap ${pid} exposed no process identity`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
}

function parseStatus(value: unknown, nonce: string, pgid: number): BootstrapStatus {
  if (typeof value !== "object" || value === null) {
    throw new Error("@cq/process-control: malformed registered-launch bootstrap status");
  }
  const status = value as Record<string, unknown>;
  if (status["nonce"] !== nonce || status["pgid"] !== pgid) {
    throw new Error("@cq/process-control: registered-launch bootstrap status identity mismatch");
  }
  if (status["state"] !== "launched" && status["state"] !== "failed") {
    throw new Error("@cq/process-control: malformed registered-launch bootstrap status");
  }
  if (status["error"] !== undefined && typeof status["error"] !== "string") {
    throw new Error("@cq/process-control: malformed registered-launch bootstrap status");
  }
  return {
    nonce,
    pgid,
    state: status["state"],
    ...(typeof status["error"] === "string" ? { error: status["error"] } : {}),
  };
}

async function waitForBootstrapStatus(
  statusPath: string,
  nonce: string,
  pgid: number,
  exit: ExitObservation,
): Promise<void> {
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  for (;;) {
    try {
      const status = parseStatus(JSON.parse(await readFile(statusPath, "utf8")), nonce, pgid);
      if (status.state === "failed") {
        throw new Error(
          `@cq/process-control: target launch failed${status.error === undefined ? "" : `: ${status.error}`}`,
        );
      }
      return;
    } catch (error) {
      if (!nodeError(error, "ENOENT")) throw error;
    }
    if (exit.settled) {
      if (exit.error !== undefined) throw exit.error;
      throw new Error(
        "@cq/process-control: registered-launch bootstrap exited before target launch acknowledgement",
      );
    }
    if (Date.now() >= deadline) {
      throw new Error("@cq/process-control: timed out waiting for target launch acknowledgement");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
}

async function waitForBootstrapExit<TProcess, TExit>(
  bootstrap: RegisteredLaunchBootstrap<TProcess, TExit>,
): Promise<void> {
  await new Promise<void>((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      rejectExit(new Error("@cq/process-control: fenced bootstrap did not exit after SIGKILL"));
    }, FAILURE_EXIT_WAIT_MS);
    void bootstrap.closed.then(
      () => {
        clearTimeout(timeout);
        resolveExit();
      },
      () => {
        clearTimeout(timeout);
        resolveExit();
      },
    );
  });
}

async function failClosed<TProcess, TExit>(
  cause: unknown,
  bootstrap: RegisteredLaunchBootstrap<TProcess, TExit> | null,
  registration: ProcessGroupRegistration | null,
): Promise<never> {
  let settlementFailure: unknown;
  try {
    if (registration !== null) {
      const result = await settleProcessGroups([registration], {
        termGraceMs: 0,
        killGraceMs: FAILURE_KILL_GRACE_MS,
      });
      if (result.survivors.length > 0) {
        throw new Error(
          `@cq/process-control: fenced group did not settle: ${result.survivors.join(", ")}`,
        );
      }
    } else if (bootstrap !== null) {
      await bootstrap.terminate("SIGKILL");
      await waitForBootstrapExit(bootstrap);
    }
  } catch (error) {
    settlementFailure = error;
  }
  if (settlementFailure !== undefined) {
    throw new AggregateError(
      [cause, settlementFailure],
      `@cq/process-control: registered launch failed and fenced-group settlement failed: ${errorMessage(cause)}`,
    );
  }
  throw cause;
}

/**
 * Launch a target behind a stable detached process-group leader.
 *
 * The target cannot execute or exit until its leader PID/start-time identity
 * has been captured and `register` has completed. A nonce-qualified release is
 * then acknowledged only after the target spawn succeeds. Every failure path
 * settles the owned fenced group; no ambient or subsequently-created setsid
 * process is discovered or claimed.
 */
export async function launchRegisteredProcessGroup<TProcess, TExit, TStdio>(
  options: LaunchRegisteredProcessGroupOptions<TProcess, TExit, TStdio>,
): Promise<LaunchedRegisteredProcessGroup<TProcess, TExit>> {
  assertTarget(options.argv, options.cwd);
  const cwd = targetCwd(options.cwd);
  const protocolDirectory = await mkdtemp(join(tmpdir(), "cq-registered-launch-"));
  const nonce = randomUUID();
  const releasePath = join(protocolDirectory, "release.json");
  const statusPath = join(protocolDirectory, "status.json");
  const bootstrapExecutable = fileURLToPath(new URL("./commandBootstrap.ts", import.meta.url));
  let bootstrap: RegisteredLaunchBootstrap<TProcess, TExit> | null = null;
  let registration: ProcessGroupRegistration | null = null;

  try {
    const specification: RegisteredLaunchBootstrapSpecification<TStdio> = {
      argv: [process.execPath, bootstrapExecutable, protocolDirectory, nonce, cwd, ...options.argv],
      cwd,
      env: { ...options.env },
      detached: true,
      stdio: options.stdio,
    };
    bootstrap = options.launchBootstrap(specification);
    const exit: ExitObservation = { settled: false, error: undefined };
    void bootstrap.closed.then(
      () => {
        exit.settled = true;
      },
      (error: unknown) => {
        exit.error = error;
        exit.settled = true;
      },
    );
    const pid = bootstrap.pid;
    if (pid === undefined) {
      throw new Error("@cq/process-control: registered-launch bootstrap returned no PID");
    }

    registration = await waitForLeaderIdentity(pid, exit);
    await options.register(registration);
    if (!(await isProcessIdentityAlive(registration.leader))) {
      throw new Error("@cq/process-control: registered-launch bootstrap exited before release");
    }
    await writeJsonAtomic(releasePath, { nonce, pgid: registration.pgid });
    await waitForBootstrapStatus(statusPath, nonce, registration.pgid, exit);
    return {
      process: bootstrap.process,
      registration,
      exited: bootstrap.closed,
    };
  } catch (error) {
    return await failClosed(error, bootstrap, registration);
  } finally {
    await rm(protocolDirectory, { recursive: true, force: true });
  }
}
