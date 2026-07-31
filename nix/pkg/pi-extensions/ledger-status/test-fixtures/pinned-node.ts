import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

export const MAX_WRAPPER_DEPTH = 16;
export const PINNED_NODE_VERSION = "v24.18.0";

export interface PinnedNodeResolution {
  readonly piPath: string;
  readonly hops: readonly string[];
  readonly nodePath: string;
  readonly version: string;
}

function resolutionFailure(message: string, cause?: unknown): Error {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new Error(`CQ_TEST_PINNED_NODE: ${message}${detail}`);
}

function canonicalExecutable(candidate: string): string {
  try {
    accessSync(candidate, constants.X_OK);
    return realpathSync(candidate);
  } catch (cause) {
    throw resolutionFailure(`cannot use executable ${candidate}`, cause);
  }
}

function firstTwoBytes(path: string): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const header = Buffer.alloc(2);
    readSync(descriptor, header, 0, header.length, 0);
    return header.toString("utf8");
  } catch (cause) {
    throw resolutionFailure(`cannot inspect ${path}`, cause);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function wrapperTarget(wrapperPath: string): string | undefined {
  if (firstTwoBytes(wrapperPath) !== "#!") return undefined;

  let wrapper: string;
  try {
    wrapper = readFileSync(wrapperPath, "utf8");
  } catch (cause) {
    throw resolutionFailure(`cannot read wrapper ${wrapperPath}`, cause);
  }
  const execLine = wrapper.split(/\r?\n/).find((line) => /^\s*exec\b/.test(line));
  if (execLine === undefined) {
    throw resolutionFailure(`wrapper ${wrapperPath} has no exec line`);
  }
  const match = execLine.match(
    /^\s*exec\s+(?:-a\s+(?:"[^"]*"|'[^']*'|\S+)\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/,
  );
  const target = match?.[1] ?? match?.[2] ?? match?.[3];
  if (target === undefined || !isAbsolute(target)) {
    throw resolutionFailure(`wrapper ${wrapperPath} has no absolute exec target`);
  }
  return target;
}

export function resolveNodeFromExecutable(startPath: string, expectedVersion = PINNED_NODE_VERSION): Omit<PinnedNodeResolution, "piPath"> {
  const hops: string[] = [];
  const visited = new Set<string>();
  let current = startPath;
  let wrapperDepth = 0;

  while (true) {
    const canonical = canonicalExecutable(current);
    if (visited.has(canonical)) {
      throw resolutionFailure(`wrapper cycle at ${canonical}`);
    }
    visited.add(canonical);
    hops.push(canonical);

    const target = wrapperTarget(canonical);
    if (target !== undefined) {
      if (wrapperDepth >= MAX_WRAPPER_DEPTH) {
        throw resolutionFailure(`wrapper chain exceeds MAX_WRAPPER_DEPTH=${MAX_WRAPPER_DEPTH}`);
      }
      wrapperDepth += 1;
      current = target;
      continue;
    }

    let version: string;
    try {
      version = execFileSync(canonical, ["--version"], { encoding: "utf8" }).trim();
    } catch (cause) {
      throw resolutionFailure(`cannot execute ${canonical} --version`, cause);
    }
    if (version !== expectedVersion) {
      throw resolutionFailure(`expected ${expectedVersion}, got ${version} from ${canonical}`);
    }
    return { hops, nodePath: canonical, version };
  }
}

export function findPiOnPath(pathValue: string | undefined): string {
  if (pathValue === undefined) {
    throw resolutionFailure("PATH is unavailable while locating pi");
  }
  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory.length === 0 ? "." : directory, "pi");
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue only while searching PATH; all selected candidates fail loudly.
    }
  }
  throw resolutionFailure("could not locate executable pi on PATH");
}

export function resolvePinnedNode(environment: NodeJS.ProcessEnv = process.env): PinnedNodeResolution {
  const piPath = environment.CQ_TEST_PINNED_NODE ?? findPiOnPath(environment.PATH);
  const resolved = resolveNodeFromExecutable(piPath);
  return { piPath: canonicalExecutable(piPath), ...resolved };
}

function writeWrapper(path: string, target: string): void {
  writeFileSync(path, `#!/bin/sh\nexec -a "$0" "${target}" "$@"\n`);
  chmodSync(path, 0o755);
}

function expectFailure(label: string, action: () => void, expression: RegExp): void {
  try {
    action();
  } catch (cause) {
    if (expression.test(String(cause))) return;
    throw resolutionFailure(`${label} control failed with unexpected diagnostic`, cause);
  }
  throw resolutionFailure(`${label} control unexpectedly resolved`);
}

/** Direct controls for cycle detection and the MAX_WRAPPER_DEPTH boundary. */
export function runResolverControls(): readonly string[] {
  const root = mkdtempSync(join(tmpdir(), "cq-pinned-node-"));
  try {
    const cycleA = join(root, "cycle-a");
    const cycleB = join(root, "cycle-b");
    writeWrapper(cycleA, cycleB);
    writeWrapper(cycleB, cycleA);
    expectFailure("cycle", () => resolveNodeFromExecutable(cycleA), /wrapper cycle/);

    const wrappers = Array.from({ length: MAX_WRAPPER_DEPTH + 1 }, (_, index) => join(root, `depth-${index}`));
    for (let index = 0; index < wrappers.length; index += 1) {
      writeWrapper(wrappers[index], index + 1 < wrappers.length ? wrappers[index + 1] : process.execPath);
    }
    expectFailure("depth", () => resolveNodeFromExecutable(wrappers[0], process.version), /exceeds MAX_WRAPPER_DEPTH/);
    return ["CONTROL-CYCLE=pass", "CONTROL-DEPTH=pass"];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const resolution = resolvePinnedNode();
console.log(`PATH-RESOLVED-PI=${resolution.piPath}`);
for (const [index, hop] of resolution.hops.entries()) console.log(`HOP[${index}]=${hop}`);
console.log(`FINAL-NODE-PATH=${resolution.nodePath}`);
console.log(`NODE-VERSION=${resolution.version}`);
for (const line of runResolverControls()) console.log(line);
