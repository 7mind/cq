import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

export type SupportedPlatform = "linux" | "darwin";

export interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
}

export interface ProcessGroupRegistration {
  readonly pgid: number;
  readonly leader: ProcessIdentity;
}

export interface ProcessGroupOperations {
  isAlive(registration: ProcessGroupRegistration): Promise<boolean>;
  signal(registration: ProcessGroupRegistration, signal: NodeJS.Signals): Promise<void> | void;
  delay(milliseconds: number): Promise<void>;
}

export interface SettleProcessGroupsOptions {
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly pollIntervalMs?: number;
  readonly operations?: ProcessGroupOperations;
}

export interface SettleProcessGroupsResult {
  readonly signaled: readonly number[];
  readonly survivors: readonly number[];
}

const DEFAULT_TERM_GRACE_MS = 3_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

export function assertSupportedPlatform(platform: string = process.platform): SupportedPlatform {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`@cq/process-control: unsupported platform ${JSON.stringify(platform)}`);
  }
  return platform;
}

export function parseLinuxProcessStartTime(stat: string): string {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) {
    throw new Error("@cq/process-control: malformed /proc stat (missing command terminator)");
  }
  const fieldsAfterCommand = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const startTime = fieldsAfterCommand[19];
  if (startTime === undefined || !/^\d+$/u.test(startTime)) {
    throw new Error("@cq/process-control: malformed /proc stat (missing process start time)");
  }
  return startTime;
}

function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`@cq/process-control: refusing unsafe process id ${String(pid)}`);
  }
}

function darwinIdentity(pid: number, helper: string | null): ProcessIdentity | null {
  if (helper !== null) {
    const result = spawnSync(helper, [String(pid)], { encoding: "utf8" });
    if (result.status === 3) return null;
    if (result.status !== 0) {
      throw new Error(
        `@cq/process-control: Darwin proc_pidinfo helper failed for pid ${pid}: ${result.stderr.trim()}`,
      );
    }
    const startTime = result.stdout.trim();
    if (!/^\d+\.\d+$/u.test(startTime)) {
      throw new Error(
        "@cq/process-control: Darwin proc_pidinfo helper returned malformed identity",
      );
    }
    return { pid, startTime };
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || result.stdout.trim() === "") return null;
  return { pid, startTime: result.stdout.trim().replace(/\s+/gu, " ") };
}

export async function readProcessIdentityWithDarwinHelper(
  pid: number,
  darwinHelper: string | null,
): Promise<ProcessIdentity | null> {
  validatePid(pid);
  const platform = assertSupportedPlatform();
  if (platform === "darwin") return darwinIdentity(pid, darwinHelper);
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return { pid, startTime: parseLinuxProcessStartTime(stat) };
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ESRCH")) return null;
    throw error;
  }
}

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  const configuredHelper = process.env["CQ_PROCESS_IDENTITY_HELPER"];
  const darwinHelper =
    configuredHelper === undefined || configuredHelper === "" ? null : configuredHelper;
  return await readProcessIdentityWithDarwinHelper(pid, darwinHelper);
}

export async function isProcessIdentityAlive(identity: ProcessIdentity): Promise<boolean> {
  const observed = await readProcessIdentity(identity.pid);
  return observed !== null && observed.startTime === identity.startTime;
}

export function isProcessGroupAlive(pgid: number): boolean {
  validatePid(pgid);
  assertSupportedPlatform();
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false;
    if (isNodeError(error, "EPERM")) return true;
    throw error;
  }
}

export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  validatePid(pgid);
  assertSupportedPlatform();
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (!isNodeError(error, "ESRCH")) throw error;
  }
}

export async function isRegisteredProcessGroupAlive(
  registration: ProcessGroupRegistration,
): Promise<boolean> {
  validateRegistration(registration);
  const observedLeader = await readProcessIdentity(registration.leader.pid);
  if (observedLeader !== null && observedLeader.startTime !== registration.leader.startTime) {
    return false;
  }
  return isProcessGroupAlive(registration.pgid);
}

export const productionProcessGroupOperations: ProcessGroupOperations = {
  isAlive: isRegisteredProcessGroupAlive,
  signal: (registration, signal) => signalProcessGroup(registration.pgid, signal),
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function validateRegistration(registration: ProcessGroupRegistration): void {
  validatePid(registration.pgid);
  validatePid(registration.leader.pid);
  if (registration.pgid !== registration.leader.pid) {
    throw new Error("@cq/process-control: process-group leader pid must equal its PGID");
  }
  if (registration.leader.startTime === "") {
    throw new Error("@cq/process-control: process-group leader identity requires a start time");
  }
}

async function aliveRegistrations(
  registrations: readonly ProcessGroupRegistration[],
  operations: ProcessGroupOperations,
): Promise<ProcessGroupRegistration[]> {
  const states = await Promise.all(
    registrations.map(async (registration) => ({
      registration,
      alive: await operations.isAlive(registration),
    })),
  );
  return states.filter(({ alive }) => alive).map(({ registration }) => registration);
}

async function waitUntilDead(
  registrations: readonly ProcessGroupRegistration[],
  timeoutMs: number,
  pollIntervalMs: number,
  operations: ProcessGroupOperations,
): Promise<ProcessGroupRegistration[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = await aliveRegistrations(registrations, operations);
  while (alive.length > 0 && Date.now() < deadline) {
    await operations.delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    alive = await aliveRegistrations(alive, operations);
  }
  return alive;
}

export async function settleProcessGroups(
  registrations: readonly ProcessGroupRegistration[],
  options: SettleProcessGroupsOptions = {},
): Promise<SettleProcessGroupsResult> {
  const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (
    !Number.isFinite(termGraceMs) ||
    !Number.isFinite(killGraceMs) ||
    !Number.isFinite(pollIntervalMs) ||
    termGraceMs < 0 ||
    killGraceMs < 0 ||
    pollIntervalMs <= 0
  ) {
    throw new Error(
      "@cq/process-control: settlement durations must be bounded finite values",
    );
  }

  const operations = options.operations ?? productionProcessGroupOperations;
  const unique = new Map<number, ProcessGroupRegistration>();
  for (const registration of registrations) {
    validateRegistration(registration);
    unique.set(registration.pgid, registration);
  }
  const owned = [...unique.values()];
  if (owned.length === 0) return { signaled: [], survivors: [] };

  let alive = await aliveRegistrations(owned, operations);
  const signaled = alive.map(({ pgid }) => pgid);
  await Promise.all(alive.map((registration) => operations.signal(registration, "SIGTERM")));
  alive = await waitUntilDead(alive, termGraceMs, pollIntervalMs, operations);
  if (alive.length > 0) {
    await Promise.all(alive.map((registration) => operations.signal(registration, "SIGSTOP")));
    alive = await aliveRegistrations(alive, operations);
    await Promise.all(alive.map((registration) => operations.signal(registration, "SIGKILL")));
    alive = await waitUntilDead(alive, killGraceMs, pollIntervalMs, operations);
  }
  return { signaled, survivors: alive.map(({ pgid }) => pgid) };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
