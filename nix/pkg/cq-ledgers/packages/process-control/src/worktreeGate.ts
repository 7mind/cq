import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSupportedPlatform,
  isProcessGroupAlive,
  isProcessIdentityAlive,
  readProcessIdentity,
  settleProcessGroups,
  signalProcessGroup,
  type ProcessGroupRegistration,
  type ProcessIdentity,
  type SettleProcessGroupsOptions,
  type SettleProcessGroupsResult,
} from "./processGroup.js";

const HOLDER_FILENAME = "holder.json";
const COMMANDS_DIRECTORY = "commands";
const CLOSING_FILENAME = "closing.json";
const RECORD_VERSION = 1;
const IDENTITY_RETRY_COUNT = 100;
const IDENTITY_RETRY_DELAY_MS = 2;
const PENDING_REGISTRATION_PREFIX = ".pending-";
const REGISTRATION_SETTLE_TIMEOUT_MS = 30_000;
const REGISTRATION_SETTLE_POLL_MS = 2;

export interface AcquireWorktreeGateOptions {
  readonly worktree: string;
  readonly commandCwd: string;
  readonly stateDir?: string;
}

export interface WorktreeGateLease {
  readonly worktree: string;
  readonly commandCwd: string;
  readonly gateDir: string;
  readonly nonce: string;
}

export interface WorktreeGateCapability {
  readonly gateDir: string;
  readonly nonce: string;
}

interface HolderRecord {
  readonly version: number;
  readonly worktree: string;
  readonly nonce: string;
  readonly holder: ProcessIdentity;
}

interface CommandRecord {
  readonly version: number;
  readonly nonce: string;
  readonly registration: ProcessGroupRegistration;
}

export interface LaunchedGateCommand {
  readonly registration: ProcessGroupRegistration;
  readonly exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

export class GateBusyError extends Error {
  readonly holder: ProcessIdentity;

  constructor(worktree: string, holder: ProcessIdentity) {
    super(`cq gate: canonical worktree ${worktree} already has a live holder (pid ${holder.pid})`);
    this.name = "GateBusyError";
    this.holder = holder;
  }
}

function gateStateRoot(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  return join(tmpdir(), `cq-worktree-gates-${uid}`);
}

function gateDirectory(root: string, worktree: string): string {
  const key = createHash("sha256").update(worktree).digest("hex");
  return join(root, key);
}

async function resolveWorktree(candidate: string): Promise<string> {
  const candidateRealpath = await realpath(candidate);
  const candidateStat = await stat(candidateRealpath);
  if (!candidateStat.isDirectory()) throw new Error("cq gate: --worktree must name a directory");
  const git = spawnSync("git", ["-C", candidateRealpath, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (git.status !== 0 || git.stdout.trim() === "") {
    throw new Error(`cq gate: --worktree does not resolve to a Git worktree: ${candidate}`);
  }
  return realpath(git.stdout.trim());
}

async function resolveCommandCwd(worktree: string, candidate: string): Promise<string> {
  const commandCwd = await realpath(candidate);
  const commandStat = await stat(commandCwd);
  if (!commandStat.isDirectory()) throw new Error("cq gate: --command-cwd must name a directory");
  const displacement = relative(worktree, commandCwd);
  const contained =
    displacement === "" ||
    (!isAbsolute(displacement) &&
      displacement !== ".." &&
      !displacement.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
  if (!contained) {
    throw new Error(
      `cq gate: --command-cwd must resolve to a directory contained in worktree ${worktree}`,
    );
  }
  return commandCwd;
}

async function writeJsonFile(target: string, value: unknown): Promise<void> {
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeJsonFile(temporary, value);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readHolder(gateDir: string): Promise<HolderRecord> {
  const parsed: unknown = JSON.parse(await readFile(join(gateDir, HOLDER_FILENAME), "utf8"));
  if (!isHolderRecord(parsed)) throw new Error(`cq gate: malformed holder identity in ${gateDir}`);
  return parsed;
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity["pid"] === "number" &&
    Number.isSafeInteger(identity["pid"]) &&
    identity["pid"] > 1 &&
    typeof identity["startTime"] === "string" &&
    identity["startTime"] !== ""
  );
}

function isRegistration(value: unknown): value is ProcessGroupRegistration {
  if (typeof value !== "object" || value === null) return false;
  const registration = value as Record<string, unknown>;
  return (
    typeof registration["pgid"] === "number" &&
    isProcessIdentity(registration["leader"]) &&
    registration["pgid"] === registration["leader"].pid
  );
}

function isHolderRecord(value: unknown): value is HolderRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["version"] === RECORD_VERSION &&
    typeof record["worktree"] === "string" &&
    typeof record["nonce"] === "string" &&
    record["nonce"] !== "" &&
    isProcessIdentity(record["holder"])
  );
}

function isCommandRecord(value: unknown): value is CommandRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["version"] === RECORD_VERSION &&
    typeof record["nonce"] === "string" &&
    isRegistration(record["registration"])
  );
}

async function publishLease(
  stateRoot: string,
  gateDir: string,
  holder: HolderRecord,
): Promise<boolean> {
  const staging = join(stateRoot, `.staging-${process.pid}-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await mkdir(join(staging, COMMANDS_DIRECTORY), { mode: 0o700 });
    await writeJsonAtomic(join(staging, HOLDER_FILENAME), holder);
    try {
      await rename(staging, gateDir);
      return true;
    } catch (error) {
      if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY")) return false;
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function writeClosingMarker(lease: WorktreeGateCapability): Promise<void> {
  try {
    await writeJsonFile(join(lease.gateDir, CLOSING_FILENAME), { nonce: lease.nonce });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
}

async function waitForPendingRegistrations(gateDir: string): Promise<void> {
  const commandsDirectory = join(gateDir, COMMANDS_DIRECTORY);
  const deadline = Date.now() + REGISTRATION_SETTLE_TIMEOUT_MS;
  for (;;) {
    const pending = (await readdir(commandsDirectory)).some((name) =>
      name.startsWith(PENDING_REGISTRATION_PREFIX),
    );
    if (!pending) return;
    if (Date.now() >= deadline) {
      throw new Error("cq gate: timed out waiting for command identity publication");
    }
    await new Promise((resolve) => setTimeout(resolve, REGISTRATION_SETTLE_POLL_MS));
  }
}

async function settleRegisteredProcessGroups(
  lease: WorktreeGateCapability,
  options: SettleProcessGroupsOptions,
): Promise<SettleProcessGroupsResult> {
  await waitForPendingRegistrations(lease.gateDir);
  const registrations = await readRegisteredProcessGroups(lease);
  const result = await settleProcessGroups(registrations, options);
  if (result.survivors.length > 0) {
    throw new Error(`cq gate: process groups did not settle: ${result.survivors.join(", ")}`);
  }
  return result;
}

async function reclaimDeadGate(
  gateDir: string,
  stateRoot: string,
  observed: HolderRecord,
): Promise<boolean> {
  const lease: WorktreeGateCapability = { gateDir, nonce: observed.nonce };
  await writeClosingMarker(lease);
  try {
    await settleRegisteredProcessGroups(lease, {});
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  const tombstone = join(stateRoot, `.stale-${process.pid}-${randomUUID()}`);
  try {
    await rename(gateDir, tombstone);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  const movedHolder = await readHolder(tombstone);
  if (movedHolder.nonce !== observed.nonce) {
    throw new Error("cq gate: holder nonce changed during stale-gate reclaim");
  }
  await rm(tombstone, { recursive: true, force: true });
  return true;
}

export async function acquireWorktreeGate(
  options: AcquireWorktreeGateOptions,
): Promise<WorktreeGateLease> {
  assertSupportedPlatform();
  const worktree = await resolveWorktree(options.worktree);
  const commandCwd = await resolveCommandCwd(worktree, options.commandCwd);
  const stateRoot = gateStateRoot(options.stateDir);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const gateDir = gateDirectory(stateRoot, worktree);
  const holderIdentity = await readProcessIdentity(process.pid);
  if (holderIdentity === null) throw new Error("cq gate: could not read holder process identity");

  for (;;) {
    const nonce = randomUUID();
    const holder: HolderRecord = {
      version: RECORD_VERSION,
      worktree,
      nonce,
      holder: holderIdentity,
    };
    if (await publishLease(stateRoot, gateDir, holder)) {
      return { worktree, commandCwd, gateDir, nonce };
    }

    let observed: HolderRecord;
    try {
      observed = await readHolder(gateDir);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
    if (await isProcessIdentityAlive(observed.holder))
      throw new GateBusyError(worktree, observed.holder);
    await reclaimDeadGate(gateDir, stateRoot, observed);
  }
}

async function assertLeaseNonce(lease: WorktreeGateCapability): Promise<HolderRecord> {
  const holder = await readHolder(lease.gateDir);
  if (holder.nonce !== lease.nonce) throw new Error("cq gate: lease nonce does not match holder");
  return holder;
}

export async function registerProcessGroup(
  lease: WorktreeGateCapability,
  registration: ProcessGroupRegistration,
): Promise<void> {
  if (!isRegistration(registration)) {
    throw new Error(
      "cq gate: command process-group registration requires matching leader PID and PGID",
    );
  }
  await assertLeaseNonce(lease);
  if (!(await isProcessIdentityAlive(registration.leader))) {
    throw new Error("cq gate: command process-group registration has a dead or recycled leader");
  }
  if (!isProcessGroupAlive(registration.pgid)) {
    throw new Error("cq gate: command process-group registration has no live process group");
  }
  const closingPath = join(lease.gateDir, CLOSING_FILENAME);
  if (await pathExists(closingPath))
    throw new Error("cq gate: cannot register a command group after close");
  const record: CommandRecord = { version: RECORD_VERSION, nonce: lease.nonce, registration };
  const target = join(
    lease.gateDir,
    COMMANDS_DIRECTORY,
    `${registration.pgid}-${randomUUID()}.json`,
  );
  const pending = join(
    lease.gateDir,
    COMMANDS_DIRECTORY,
    `${PENDING_REGISTRATION_PREFIX}${process.pid}-${randomUUID()}`,
  );
  try {
    await writeJsonFile(pending, record);
    if (await pathExists(closingPath)) {
      throw new Error("cq gate: command group raced with gate close");
    }
    await rename(pending, target);
  } finally {
    await rm(pending, { force: true });
  }
  if (await pathExists(closingPath)) {
    throw new Error("cq gate: command group raced with gate close");
  }
}

export function worktreeGateCapabilityFromEnvironment(): WorktreeGateCapability {
  const gateDir = process.env["CQ_GATE_DIR"];
  const nonce = process.env["CQ_GATE_NONCE"];
  if (gateDir === undefined || gateDir === "" || nonce === undefined || nonce === "") {
    throw new Error("cq gate: CQ_GATE_DIR and CQ_GATE_NONCE are required for command registration");
  }
  return { gateDir, nonce };
}

export async function registerProcessGroupFromEnvironment(
  registration: ProcessGroupRegistration,
): Promise<void> {
  await registerProcessGroup(worktreeGateCapabilityFromEnvironment(), registration);
}

export async function readRegisteredProcessGroups(
  lease: WorktreeGateCapability,
): Promise<ProcessGroupRegistration[]> {
  await assertLeaseNonce(lease);
  const directory = join(lease.gateDir, COMMANDS_DIRECTORY);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const registrations: ProcessGroupRegistration[] = [];
  for (const name of names) {
    const parsed: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
    if (!isCommandRecord(parsed)) throw new Error(`cq gate: malformed command identity ${name}`);
    if (parsed.nonce !== lease.nonce)
      throw new Error(`cq gate: command identity nonce mismatch ${name}`);
    registrations.push(parsed.registration);
  }
  return registrations;
}

async function waitForIdentity(pid: number): Promise<ProcessIdentity> {
  for (let attempt = 0; attempt < IDENTITY_RETRY_COUNT; attempt += 1) {
    const identity = await readProcessIdentity(pid);
    if (identity !== null) return identity;
    await new Promise((resolve) => setTimeout(resolve, IDENTITY_RETRY_DELAY_MS));
  }
  throw new Error(`cq gate: launched process ${pid} never exposed a process identity`);
}

function childExit(
  child: ChildProcess,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

export async function launchRegisteredGateCommand(
  lease: WorktreeGateLease,
  command: readonly string[],
): Promise<LaunchedGateCommand> {
  if (command.length === 0 || command[0] === undefined || command[0] === "") {
    throw new Error("cq gate: command after -- must not be empty");
  }
  await assertLeaseNonce(lease);
  const barrier = join(lease.gateDir, `.exec-${randomUUID()}`);
  const bootstrap = fileURLToPath(new URL("./commandBootstrap.ts", import.meta.url));
  const child = spawn(process.execPath, ["run", bootstrap, barrier, lease.commandCwd, ...command], {
    cwd: lease.commandCwd,
    detached: true,
    stdio: "inherit",
    env: {
      ...process.env,
      CQ_GATE_DIR: lease.gateDir,
      CQ_GATE_NONCE: lease.nonce,
    },
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("cq gate: command bootstrap did not return a PID");

  try {
    const leader = await waitForIdentity(pid);
    const registration: ProcessGroupRegistration = { pgid: pid, leader };
    await registerProcessGroup(lease, registration);
    await writeJsonAtomic(barrier, { nonce: lease.nonce, pgid: pid });
    return { registration, exited: childExit(child) };
  } catch (error) {
    signalProcessGroup(pid, "SIGKILL");
    await rm(barrier, { force: true });
    throw error;
  }
}

export async function closeWorktreeGate(
  lease: WorktreeGateLease,
  options: SettleProcessGroupsOptions = {},
): Promise<SettleProcessGroupsResult> {
  await assertLeaseNonce(lease);
  await writeClosingMarker(lease);
  const result = await settleRegisteredProcessGroups(lease, options);
  if (!(await releaseWorktreeGate(lease)))
    throw new Error("cq gate: lease nonce changed before release");
  return result;
}

export async function releaseWorktreeGate(lease: WorktreeGateLease): Promise<boolean> {
  let holder: HolderRecord;
  try {
    holder = await readHolder(lease.gateDir);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  if (holder.nonce !== lease.nonce) return false;
  const stateRoot = join(lease.gateDir, "..");
  const tombstone = join(stateRoot, `.released-${process.pid}-${randomUUID()}`);
  try {
    await rename(lease.gateDir, tombstone);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  const movedHolder = await readHolder(tombstone);
  if (movedHolder.nonce !== lease.nonce) {
    throw new Error("cq gate: holder nonce changed during release");
  }
  await rm(tombstone, { recursive: true, force: true });
  return true;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
