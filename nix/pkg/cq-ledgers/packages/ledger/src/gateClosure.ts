import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MANAGED_GATE_CLOSURE_VERSION = 1 as const;
export const MANAGED_GATE_CLOSURE_MANIFEST = "cq-gate-closure.json";

const BUN_LOCK_NAMES = ["bun.lock", "bun.lockb"] as const;
const BUN_CONFIGURATION_NAME = "bunfig.toml";
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".mts", ".cts", ".ts", ".tsx"]);
const SKIPPED_DIRECTORIES = new Set([
  ".cache",
  ".claude",
  ".direnv",
  ".git",
  "dist",
  "node_modules",
]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const BUN_SCRIPT_EDGE_RE = /\bbun\s+run\s+([A-Za-z0-9:_-]+)/gu;
const STATIC_IMPORT_RES = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/gu,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
] as const;
const OPAQUE_PATH_METHODS = new Set([
  "createReadStream",
  "open",
  "openSync",
  "opendir",
  "opendirSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
] as const);
const OPAQUE_SPAWN_METHODS = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "spawn",
  "spawnSync",
] as const);
const FILESYSTEM_MODULE_NAMES = ["node:fs", "node:fs/promises"] as const;
const CHILD_PROCESS_MODULE_NAMES = ["node:child_process"] as const;
const MODULE_MODULE_NAMES = ["node:module", "module"] as const;
const CREATE_REQUIRE_METHODS = new Set(["createRequire"] as const);

export type ManagedGateOpaqueEdgeKind = "dynamic" | "nix" | "path" | "spawn";

export interface ManagedGateOpaqueEdgeDeclaration {
  readonly kind: ManagedGateOpaqueEdgeKind;
  readonly source: string;
  readonly sha256: string;
  /** Source/runtime inputs; each is mapped to its nearest package.json + Bun lock root. */
  readonly targets: readonly string[];
}

export interface ManagedGateClosureManifestV1 {
  readonly version: typeof MANAGED_GATE_CLOSURE_VERSION;
  readonly target: {
    readonly packageJson: string;
    readonly script: string;
    readonly scriptDagSha256: string;
  };
  readonly opaqueEdges: readonly ManagedGateOpaqueEdgeDeclaration[];
}

export type ManagedGateClosureInvalidReason =
  | "bun-configuration-invalid"
  | "bun-configuration-unsupported"
  | "bun-root-incomplete"
  | "edge-source-missing"
  | "edge-target-missing"
  | "manifest-invalid"
  | "manifest-missing"
  | "path-escape"
  | "script-edge-missing"
  | "source-declaration-missing"
  | "source-digest-mismatch"
  | "static-import-unresolved"
  | "target-diverged"
  | "target-package-missing"
  | "target-script-missing";

export type ManagedGateClosureResolution =
  | {
      readonly status: "resolved";
      readonly version: typeof MANAGED_GATE_CLOSURE_VERSION;
      readonly targetPackageJson: string;
      readonly targetScript: string;
      readonly reachableScripts: readonly string[];
      readonly installRoots: readonly string[];
    }
  | {
      readonly status: "invalid";
      readonly reason: ManagedGateClosureInvalidReason;
      readonly detail: string;
    };

interface ScriptDag {
  readonly scripts: readonly string[];
  readonly sha256: string;
}

function invalid(
  reason: ManagedGateClosureInvalidReason,
  detail: string,
): Extract<ManagedGateClosureResolution, { readonly status: "invalid" }> {
  return { status: "invalid", reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRepositoryPath(
  repositoryRoot: string,
  repositoryRelativePath: string,
): { readonly absolute: string; readonly relative: string } | null {
  if (
    repositoryRelativePath.length === 0 ||
    isAbsolute(repositoryRelativePath) ||
    repositoryRelativePath.includes("\\")
  ) {
    return null;
  }
  const absolute = resolve(repositoryRoot, repositoryRelativePath);
  const relation = relative(repositoryRoot, absolute);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return null;
  return { absolute, relative: relation.split(sep).join("/") };
}

function isRepositoryPath(repositoryRoot: string, absolutePath: string): boolean {
  const relation = relative(repositoryRoot, absolutePath);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

async function canonicalRepositoryPath(
  repositoryRoot: string,
  absolutePath: string,
): Promise<string | null> {
  let canonical: string;
  try {
    canonical = await fs.realpath(absolutePath);
  } catch {
    return null;
  }
  return isRepositoryPath(repositoryRoot, canonical) ? canonical : null;
}

function parseManifest(value: unknown): ManagedGateClosureManifestV1 | null {
  if (!isRecord(value) || value.version !== MANAGED_GATE_CLOSURE_VERSION) return null;
  const target = value.target;
  const opaqueEdges = value.opaqueEdges;
  if (
    !isRecord(target) ||
    typeof target.packageJson !== "string" ||
    typeof target.script !== "string" ||
    typeof target.scriptDagSha256 !== "string" ||
    !SHA256_RE.test(target.scriptDagSha256) ||
    !Array.isArray(opaqueEdges)
  ) {
    return null;
  }
  const parsedEdges: ManagedGateOpaqueEdgeDeclaration[] = [];
  for (const edge of opaqueEdges) {
    if (
      !isRecord(edge) ||
      (edge.kind !== "dynamic" &&
        edge.kind !== "nix" &&
        edge.kind !== "path" &&
        edge.kind !== "spawn") ||
      typeof edge.source !== "string" ||
      typeof edge.sha256 !== "string" ||
      !SHA256_RE.test(edge.sha256) ||
      !Array.isArray(edge.targets) ||
      edge.targets.some((entry) => typeof entry !== "string")
    ) {
      return null;
    }
    parsedEdges.push({
      kind: edge.kind,
      source: edge.source,
      sha256: edge.sha256,
      targets: edge.targets as string[],
    });
  }
  return {
    version: MANAGED_GATE_CLOSURE_VERSION,
    target: {
      packageJson: target.packageJson,
      script: target.script,
      scriptDagSha256: target.scriptDagSha256,
    },
    opaqueEdges: parsedEdges,
  };
}

function resolveScriptDag(
  scripts: Readonly<Record<string, string>>,
  targetScript: string,
): ScriptDag | { readonly missing: string; readonly parent: string | null } {
  const pending: { readonly script: string; readonly parent: string | null }[] = [
    { script: targetScript, parent: null },
  ];
  const reachable = new Set<string>();
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (reachable.has(next.script)) continue;
    const command = scripts[next.script];
    if (command === undefined) return { missing: next.script, parent: next.parent };
    reachable.add(next.script);
    for (const match of command.matchAll(BUN_SCRIPT_EDGE_RE)) {
      pending.push({ script: match[1]!, parent: next.script });
    }
  }
  const ordered = [...reachable].sort((left, right) => left.localeCompare(right));
  return {
    scripts: ordered,
    sha256: sha256(JSON.stringify(ordered.map((name) => [name, scripts[name]!]))),
  };
}

export function computeManagedGateScriptDagSha256(
  scripts: Readonly<Record<string, string>>,
  targetScript: string,
): string {
  const dag = resolveScriptDag(scripts, targetScript);
  if ("missing" in dag) {
    throw new Error(
      dag.parent === null
        ? `target script ${JSON.stringify(dag.missing)} is missing`
        : `script ${JSON.stringify(dag.parent)} references missing script ${JSON.stringify(dag.missing)}`,
    );
  }
  return dag.sha256;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

type BunLockResolution =
  | { readonly status: "found" }
  | { readonly status: "missing" }
  | { readonly status: "path-escape"; readonly path: string };

async function resolveBunLock(
  repositoryRoot: string,
  directory: string,
): Promise<BunLockResolution> {
  for (const lock of BUN_LOCK_NAMES) {
    const lockPath = join(directory, lock);
    const canonicalLockPath = await canonicalRepositoryPath(repositoryRoot, lockPath);
    if (canonicalLockPath !== null) {
      try {
        if ((await fs.stat(canonicalLockPath)).isFile()) return { status: "found" };
      } catch {
        // continue
      }
    } else if (await pathExists(lockPath)) {
      return { status: "path-escape", path: lockPath };
    }
  }
  return { status: "missing" };
}

type BunRootResolution =
  | { readonly status: "found"; readonly root: string }
  | { readonly status: "missing" }
  | { readonly status: "path-escape"; readonly path: string };

type BunConfigurationTargetKind = "preload" | "test-root";

interface BunConfigurationTarget {
  readonly kind: BunConfigurationTargetKind;
  readonly path: string;
  readonly relative: string;
}

interface ApplicableBunConfiguration {
  readonly path: string;
  readonly relative: string;
  readonly targets: readonly BunConfigurationTarget[];
}

type BunConfigurationResolution =
  | { readonly status: "absent" }
  | { readonly status: "found"; readonly configuration: ApplicableBunConfiguration }
  | Extract<ManagedGateClosureResolution, { readonly status: "invalid" }>;

function configuredPreloads(
  value: unknown,
  field: string,
):
  | { readonly status: "parsed"; readonly specifiers: readonly string[] }
  | { readonly status: "invalid"; readonly detail: string } {
  if (value === undefined || value === null) return { status: "parsed", specifiers: [] };
  if (typeof value === "string") {
    return { status: "parsed", specifiers: value.length === 0 ? [] : [value] };
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return {
      status: "invalid",
      detail: `${field} must be a string, string array, or null`,
    };
  }
  return {
    status: "parsed",
    specifiers: (value as string[]).filter((entry) => entry.length > 0),
  };
}

async function resolveBunConfigurationTarget(
  repositoryRoot: string,
  targetRoot: string,
  specifier: string,
  kind: BunConfigurationTargetKind,
): Promise<
  | { readonly status: "found"; readonly target: BunConfigurationTarget }
  | Extract<ManagedGateClosureResolution, { readonly status: "invalid" }>
> {
  if (!isAbsolute(specifier) && !specifier.startsWith(".")) {
    return invalid(
      "bun-configuration-unsupported",
      `applicable Bun ${kind} target ${JSON.stringify(specifier)} is not a filesystem path`,
    );
  }
  const unresolved = resolve(targetRoot, specifier);
  if (!isRepositoryPath(repositoryRoot, unresolved)) {
    return invalid(
      "path-escape",
      `applicable Bun ${kind} target escapes the repository: ${specifier}`,
    );
  }
  const canonical = await canonicalRepositoryPath(repositoryRoot, unresolved);
  if (canonical === null) {
    if (await pathExists(unresolved)) {
      return invalid(
        "path-escape",
        `resolved applicable Bun ${kind} target escapes the repository: ${specifier}`,
      );
    }
    return invalid(
      "edge-target-missing",
      `applicable Bun ${kind} target is missing: ${relative(repositoryRoot, unresolved).split(sep).join("/")}`,
    );
  }
  let targetKind: Awaited<ReturnType<typeof fs.stat>>;
  try {
    targetKind = await fs.stat(canonical);
  } catch {
    return invalid(
      "edge-target-missing",
      `applicable Bun ${kind} target is missing: ${relative(repositoryRoot, canonical).split(sep).join("/")}`,
    );
  }
  if (
    (kind === "preload" && !targetKind.isFile()) ||
    (kind === "test-root" && !targetKind.isDirectory())
  ) {
    return invalid(
      "bun-configuration-invalid",
      `applicable Bun ${kind} target has the wrong filesystem type: ${relative(repositoryRoot, canonical).split(sep).join("/")}`,
    );
  }
  if (kind === "preload" && !SOURCE_EXTENSIONS.has(extname(canonical))) {
    return invalid(
      "bun-configuration-unsupported",
      `applicable Bun preload target has an unsupported source extension: ${relative(repositoryRoot, canonical).split(sep).join("/")}`,
    );
  }
  return {
    status: "found",
    target: {
      kind,
      path: canonical,
      relative: relative(repositoryRoot, canonical).split(sep).join("/"),
    },
  };
}

async function resolveApplicableBunConfiguration(
  repositoryRoot: string,
  targetRoot: string,
): Promise<BunConfigurationResolution> {
  const unresolved = join(targetRoot, BUN_CONFIGURATION_NAME);
  const canonical = await canonicalRepositoryPath(repositoryRoot, unresolved);
  if (canonical === null) {
    return (await pathExists(unresolved))
      ? invalid(
          "path-escape",
          `resolved applicable Bun configuration escapes the repository: ${relative(repositoryRoot, unresolved).split(sep).join("/")}`,
        )
      : { status: "absent" };
  }
  let bytes: string;
  try {
    bytes = await fs.readFile(canonical, "utf8");
  } catch (error) {
    return invalid(
      "bun-configuration-invalid",
      `cannot read applicable Bun configuration ${relative(repositoryRoot, canonical).split(sep).join("/")}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let value: unknown;
  try {
    value = Bun.TOML.parse(bytes);
  } catch (error) {
    return invalid(
      "bun-configuration-invalid",
      `cannot parse applicable Bun configuration ${relative(repositoryRoot, canonical).split(sep).join("/")}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) {
    return invalid("bun-configuration-invalid", "applicable Bun configuration is not a table");
  }
  const topLevelPreload = configuredPreloads(value["preload"], "preload");
  if (topLevelPreload.status === "invalid") {
    return invalid("bun-configuration-invalid", topLevelPreload.detail);
  }
  if (topLevelPreload.specifiers.length > 0) {
    return invalid(
      "bun-configuration-unsupported",
      "top-level Bun preload is outside the supported package-script/test configuration domain",
    );
  }
  const install = value["install"];
  if (isRecord(install) && isRecord(install["security"])) {
    const scanner = install["security"]["scanner"];
    if (scanner !== undefined) {
      return invalid(
        "bun-configuration-unsupported",
        "Bun install.security.scanner is an unsupported executable configuration construct",
      );
    }
  }
  const serve = value["serve"];
  if (isRecord(serve) && isRecord(serve["static"]) && serve["static"]["plugins"] !== undefined) {
    return invalid(
      "bun-configuration-unsupported",
      "Bun serve.static.plugins is an unsupported executable configuration construct",
    );
  }
  const test = value["test"];
  if (test !== undefined && !isRecord(test)) {
    return invalid("bun-configuration-invalid", "test must be a table");
  }
  const preloads = configuredPreloads(test?.["preload"], "test.preload");
  if (preloads.status === "invalid") {
    return invalid("bun-configuration-invalid", preloads.detail);
  }
  const specifications: { readonly kind: BunConfigurationTargetKind; readonly value: string }[] =
    preloads.specifiers.map((specifier) => ({ kind: "preload", value: specifier }));
  const testRoot = test?.["root"];
  if (testRoot !== undefined) {
    if (typeof testRoot !== "string") {
      return invalid("bun-configuration-invalid", "test.root must be a string");
    }
    specifications.push({ kind: "test-root", value: testRoot.length === 0 ? "." : testRoot });
  }
  const targets = new Map<string, BunConfigurationTarget>();
  for (const specification of specifications) {
    const resolved = await resolveBunConfigurationTarget(
      repositoryRoot,
      targetRoot,
      specification.value,
      specification.kind,
    );
    if (resolved.status === "invalid") return resolved;
    targets.set(`${resolved.target.kind}\0${resolved.target.path}`, resolved.target);
  }
  return {
    status: "found",
    configuration: {
      path: canonical,
      relative: relative(repositoryRoot, canonical).split(sep).join("/"),
      targets: [...targets.values()],
    },
  };
}

async function nearestBunRoot(
  repositoryRoot: string,
  inputPath: string,
): Promise<BunRootResolution> {
  let current = inputPath;
  try {
    if (!(await fs.stat(current)).isDirectory()) current = dirname(current);
  } catch {
    return { status: "missing" };
  }
  while (true) {
    if (await pathExists(join(current, "package.json"))) {
      const lock = await resolveBunLock(repositoryRoot, current);
      if (lock.status === "path-escape") return lock;
      if (lock.status === "found") return { status: "found", root: current };
    }
    if (current === repositoryRoot) return { status: "missing" };
    const parent = dirname(current);
    if (
      parent === current ||
      !safeRepositoryPath(repositoryRoot, relative(repositoryRoot, parent))
    ) {
      return { status: "missing" };
    }
    current = parent;
  }
}

type SourceFilesResolution =
  | { readonly status: "found"; readonly files: readonly string[] }
  | { readonly status: "path-escape"; readonly path: string };

async function sourceFiles(repositoryRoot: string, root: string): Promise<SourceFilesResolution> {
  const files = new Set<string>();
  const visitedDirectories = new Set<string>();
  async function visit(directory: string): Promise<string | null> {
    if (visitedDirectories.has(directory)) return null;
    visitedDirectories.add(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      let canonical: string;
      try {
        canonical = await fs.realpath(absolute);
      } catch {
        continue;
      }
      if (!isRepositoryPath(repositoryRoot, canonical)) return canonical;
      let kind: Awaited<ReturnType<typeof fs.stat>>;
      try {
        kind = await fs.stat(canonical);
      } catch {
        continue;
      }
      if (kind.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          const escape = await visit(canonical);
          if (escape !== null) return escape;
        }
      } else if (kind.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.add(canonical);
      }
    }
    return null;
  }
  const escape = await visit(root);
  return escape === null
    ? { status: "found", files: [...files].sort((left, right) => left.localeCompare(right)) }
    : { status: "path-escape", path: escape };
}

function staticImportSpecifiers(source: string): readonly string[] {
  const specifiers = new Set<string>();
  for (const pattern of STATIC_IMPORT_RES) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]!);
  }
  for (const specifier of commonJsLiteralLoadSpecifiers(source)) specifiers.add(specifier);
  return [...specifiers];
}

function hasOpaqueDynamicImport(source: string): boolean {
  return hasOpaqueCall(source, ["import"], true);
}

type FirstCallArgument =
  { readonly kind: "literal"; readonly value: string } | { readonly kind: "nonliteral" };

function sourceCodeMask(source: string): string {
  const mask = Array.from({ length: source.length }, () => " ");
  const scanQuoted = (start: number, quote: '"' | "'"): number => {
    let cursor = start + 1;
    while (cursor < source.length) {
      if (source[cursor] === "\\") cursor += 2;
      else if (source[cursor] === quote) return cursor + 1;
      else cursor += 1;
    }
    return cursor;
  };
  const regularExpressionCanStart = (index: number): boolean => {
    let cursor = index - 1;
    while (cursor >= 0 && /\s/u.test(source[cursor] ?? "")) cursor -= 1;
    if (cursor < 0 || /[([{=:;,!?&|+*%^~<>-]/u.test(source[cursor] ?? "")) return true;
    return /\b(?:await|case|delete|in|instanceof|of|return|throw|typeof|void|yield)\s*$/u.test(
      source.slice(0, index),
    );
  };
  const scanRegularExpression = (start: number): number => {
    let cursor = start + 1;
    let characterClass = false;
    while (cursor < source.length) {
      if (source[cursor] === "\\") cursor += 2;
      else if (source[cursor] === "[") {
        characterClass = true;
        cursor += 1;
      } else if (source[cursor] === "]") {
        characterClass = false;
        cursor += 1;
      } else if (source[cursor] === "/" && !characterClass) {
        cursor += 1;
        while (/[A-Za-z]/u.test(source[cursor] ?? "")) cursor += 1;
        return cursor;
      } else cursor += 1;
    }
    return cursor;
  };
  const scanCode = (start: number, templateExpression: boolean): number => {
    let cursor = start;
    let braceDepth = 0;
    while (cursor < source.length) {
      const character = source[cursor]!;
      const next = source[cursor + 1];
      if (character === "/" && next === "/") {
        const end = source.indexOf("\n", cursor + 2);
        cursor = end === -1 ? source.length : end;
        continue;
      }
      if (character === "/" && next === "*") {
        const end = source.indexOf("*/", cursor + 2);
        cursor = end === -1 ? source.length : end + 2;
        continue;
      }
      if (character === "/" && regularExpressionCanStart(cursor)) {
        cursor = scanRegularExpression(cursor);
        continue;
      }
      if (character === '"' || character === "'") {
        cursor = scanQuoted(cursor, character);
        continue;
      }
      if (character === "`") {
        cursor += 1;
        while (cursor < source.length) {
          if (source[cursor] === "\\") {
            cursor += 2;
            continue;
          }
          if (source[cursor] === "`") {
            cursor += 1;
            break;
          }
          if (source[cursor] === "$" && source[cursor + 1] === "{") {
            cursor = scanCode(cursor + 2, true);
            continue;
          }
          cursor += 1;
        }
        continue;
      }
      if (templateExpression && character === "}" && braceDepth === 0) return cursor + 1;
      if (character === "{") braceDepth += 1;
      else if (templateExpression && character === "}") braceDepth -= 1;
      mask[cursor] = character;
      cursor += 1;
    }
    return cursor;
  };
  scanCode(0, false);
  return mask.join("");
}

function skipCallTrivia(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor] ?? "")) {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "/" && source[cursor + 1] === "/") {
      const end = source.indexOf("\n", cursor + 2);
      return end === -1 ? source.length : skipCallTrivia(source, end + 1);
    }
    if (source[cursor] === "/" && source[cursor + 1] === "*") {
      const end = source.indexOf("*/", cursor + 2);
      return end === -1 ? source.length : skipCallTrivia(source, end + 2);
    }
    return cursor;
  }
  return cursor;
}

function firstCallArgument(
  source: string,
  index: number,
  callee: string,
): FirstCallArgument | null {
  if (!source.startsWith(callee, index)) return null;
  if (/[A-Za-z0-9_$]/u.test(source[index - 1] ?? "")) return null;
  if (/[A-Za-z0-9_$]/u.test(source[index + callee.length] ?? "")) return null;
  let cursor = skipCallTrivia(source, index + callee.length);
  if (source[cursor] !== "(") return null;
  cursor = skipCallTrivia(source, cursor + 1);
  const quote = source[cursor];
  if (quote !== '"' && quote !== "'" && quote !== "`") return { kind: "nonliteral" };
  const start = cursor + 1;
  cursor = start;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (quote === "`" && source[cursor] === "$" && source[cursor + 1] === "{") {
      return { kind: "nonliteral" };
    }
    if (source[cursor] === quote) {
      return { kind: "literal", value: source.slice(start, cursor) };
    }
    cursor += 1;
  }
  return { kind: "nonliteral" };
}

function hasCall(
  source: string,
  index: number,
  callee: string,
  nonLiteralFirstArgument: boolean,
): boolean {
  const argument = firstCallArgument(source, index, callee);
  if (argument === null) return false;
  return !nonLiteralFirstArgument || argument.kind === "nonliteral";
}

function hasOpaqueCall(
  source: string,
  callees: readonly string[],
  nonLiteralFirstArgument: boolean,
): boolean {
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) return false;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) return false;
      index = end + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === quote) {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    if (callees.some((callee) => hasCall(source, index, callee, nonLiteralFirstArgument))) {
      return true;
    }
    index += 1;
  }
  return false;
}

function hasOpaqueCodeCall(
  source: string,
  callees: readonly string[],
  nonLiteralFirstArgument: boolean,
): boolean {
  const code = sourceCodeMask(source);
  for (let index = 0; index < source.length; index += 1) {
    if (code[index] === " ") continue;
    if (callees.some((callee) => hasCall(source, index, callee, nonLiteralFirstArgument))) {
      return true;
    }
  }
  return false;
}

function literalCallSpecifiers(source: string, callees: readonly string[]): readonly string[] {
  const specifiers = new Set<string>();
  const code = sourceCodeMask(source);
  for (let index = 0; index < source.length; index += 1) {
    if (code[index] === " ") continue;
    for (const callee of callees) {
      const argument = firstCallArgument(source, index, callee);
      if (argument?.kind === "literal") specifiers.add(argument.value);
    }
  }
  return [...specifiers];
}

function importedCallees(
  source: string,
  moduleNames: readonly string[],
  methods: ReadonlySet<string>,
): readonly string[] {
  const callees = new Set<string>();
  const moduleAlternation = moduleNames.map((name) => name.replaceAll("/", "\\/")).join("|");
  const pattern = new RegExp(
    `(?:^|\\n)\\s*import\\s+(?!type\\b)([^;]*?)\\s+from\\s+["'](?:${moduleAlternation})["']`,
    "gu",
  );
  for (const match of source.matchAll(pattern)) {
    const clause = match[1]!.trim();
    const namespace = clause.match(/(?:^|,)\s*\*\s+as\s+([A-Za-z_$][\w$]*)/u)?.[1];
    if (namespace !== undefined) {
      for (const method of methods) callees.add(`${namespace}.${method}`);
    }
    const defaultImport = clause.match(/^([A-Za-z_$][\w$]*)(?:\s*,|$)/u)?.[1];
    if (defaultImport !== undefined) {
      for (const method of methods) callees.add(`${defaultImport}.${method}`);
    }
    const named = clause.match(/\{([\s\S]*?)\}/u)?.[1];
    if (named === undefined) continue;
    for (const part of named.split(",")) {
      const binding = part.trim().replace(/^type\s+/u, "");
      const parsed = binding.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u);
      if (parsed === null) continue;
      const imported = parsed[1]!;
      const local = parsed[2] ?? imported;
      if (methods.has(imported)) callees.add(local);
      if (imported === "promises") {
        for (const method of methods) callees.add(`${local}.${method}`);
      }
    }
  }
  return [...callees];
}

function commonJsCallees(
  source: string,
  moduleNames: readonly string[],
  methods: ReadonlySet<string>,
): readonly string[] {
  const callees = new Set<string>();
  const moduleAlternation = moduleNames.map((name) => name.replaceAll("/", "\\/")).join("|");
  const requireExpression = `require\\s*\\(\\s*["'](?:${moduleAlternation})["']\\s*\\)`;
  const identifier = "[A-Za-z_$][\\w$]*";
  const statementBoundary = "(?:^|[;\\n])";
  const addDestructuredCallees = (bindings: string): void => {
    for (const part of bindings.split(",")) {
      const parsed = part
        .trim()
        .match(new RegExp(`^(${identifier})(?:\\s*:\\s*(${identifier}))?$`, "u"));
      if (parsed === null) continue;
      const imported = parsed[1]!;
      const local = parsed[2] ?? imported;
      if (methods.has(imported)) callees.add(local);
      if (imported === "promises") {
        for (const method of methods) callees.add(`${local}.${method}`);
      }
    }
  };
  const namespacePattern = new RegExp(
    `${statementBoundary}\\s*(?:const|let|var)\\s+(${identifier})\\s*=\\s*${requireExpression}`,
    "gu",
  );
  const namespaces = new Set<string>();
  for (const match of source.matchAll(namespacePattern)) {
    const namespace = match[1]!;
    namespaces.add(namespace);
    for (const method of methods) callees.add(`${namespace}.${method}`);
  }

  const destructuredPattern = new RegExp(
    `${statementBoundary}\\s*(?:const|let|var)\\s+\\{([\\s\\S]*?)\\}\\s*=\\s*${requireExpression}`,
    "gu",
  );
  for (const match of source.matchAll(destructuredPattern)) {
    addDestructuredCallees(match[1]!);
  }

  for (const namespace of namespaces) {
    const destructuredNamespacePattern = new RegExp(
      `${statementBoundary}\\s*(?:const|let|var)\\s+\\{([\\s\\S]*?)\\}\\s*=\\s*${namespace}(?:\\s*;|\\s*$)`,
      "gu",
    );
    for (const match of source.matchAll(destructuredNamespacePattern)) {
      addDestructuredCallees(match[1]!);
    }
    for (const method of methods) {
      const aliasPattern = new RegExp(
        `${statementBoundary}\\s*(?:const|let|var)\\s+(${identifier})\\s*=\\s*${namespace}\\.${method}(?:\\s*;|\\s*$)`,
        "gu",
      );
      for (const match of source.matchAll(aliasPattern)) callees.add(match[1]!);
    }
  }
  return [...callees];
}

function createdRequireCallees(source: string): readonly string[] {
  const factories = [
    ...importedCallees(source, MODULE_MODULE_NAMES, CREATE_REQUIRE_METHODS),
    ...commonJsCallees(source, MODULE_MODULE_NAMES, CREATE_REQUIRE_METHODS),
  ];
  const callees = new Set<string>();
  const identifier = "[A-Za-z_$][\\w$]*";
  const statementBoundary = "(?:^|[;\\n])";
  for (const factory of factories) {
    const escapedFactory = factory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(
      `${statementBoundary}\\s*(?:const|let|var)\\s+(${identifier})\\s*=\\s*${escapedFactory}\\s*\\(`,
      "gu",
    );
    for (const match of source.matchAll(pattern)) callees.add(match[1]!);
  }
  return [...callees];
}

const COMMON_JS_COMPUTED_PROPERTIES = new Set([
  "apply",
  "bind",
  "cache",
  "call",
  "extensions",
  "main",
  "paths",
  "require",
  "resolve",
]);

interface CommonJsLoaderAliases {
  readonly loaders: readonly string[];
  readonly resolvers: readonly string[];
  readonly referenceRanges: readonly { readonly start: number; readonly end: number }[];
}

interface CommonJsLoaderAnalysis {
  readonly literalSpecifiers: readonly string[];
  readonly opaque: boolean;
}

function normalizeComputedCommonJsProperties(source: string): string {
  const normalized = [...source];
  const code = sourceCodeMask(source);
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "[" || code[index] === " ") continue;
    const match = source.slice(index).match(/^\[\s*(["'])([A-Za-z_$][\w$]*)\1\s*\]/u);
    if (match === null || !COMMON_JS_COMPUTED_PROPERTIES.has(match[2]!)) continue;
    const replacement = `.${match[2]!}`.padEnd(match[0].length, " ");
    normalized.splice(index, match[0].length, ...replacement);
    index += match[0].length - 1;
  }
  return normalized.join("");
}

function canonicalSimpleReference(value: string): string {
  let canonical = value.trim();
  while (/^\(\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\)$/u.test(canonical)) {
    canonical = canonical.slice(1, -1).trim();
  }
  return canonical.replace(/\s*\.\s*/gu, ".");
}

function commonJsLoaderAliases(
  source: string,
  initialLoaders: readonly string[],
  initialResolvers: readonly string[],
): CommonJsLoaderAliases {
  const loaders = new Set(initialLoaders);
  const resolvers = new Set(initialResolvers);
  const referenceRanges: { start: number; end: number }[] = [];
  const code = sourceCodeMask(source);
  let changed = true;
  while (changed) {
    changed = false;
    const declarationPattern =
      /(?:^|[;\n])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+?)\s*(?:;|$)/gu;
    for (const match of source.matchAll(declarationPattern)) {
      const declarationOffset = match[0].search(/\b(?:const|let|var)\b/u);
      if (declarationOffset === -1 || code[match.index + declarationOffset] === " ") continue;
      const local = match[1]!;
      const reference = canonicalSimpleReference(match[2]!);
      const referenceOffset = match[0].indexOf(match[2]!);
      if (loaders.has(reference)) {
        if (!loaders.has(local)) {
          loaders.add(local);
          changed = true;
        }
        referenceRanges.push({
          start: match.index + referenceOffset,
          end: match.index + referenceOffset + match[2]!.length,
        });
      } else if (resolvers.has(reference)) {
        if (!resolvers.has(local)) {
          resolvers.add(local);
          changed = true;
        }
        referenceRanges.push({
          start: match.index + referenceOffset,
          end: match.index + referenceOffset + match[2]!.length,
        });
      }
    }
  }

  const destructuredPattern =
    /(?:^|[;\n])\s*(?:const|let|var)\s+\{\s*require(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*\}\s*=\s*module\s*(?:;|$)/gu;
  for (const match of source.matchAll(destructuredPattern)) {
    const declarationOffset = match[0].search(/\b(?:const|let|var)\b/u);
    if (declarationOffset === -1 || code[match.index + declarationOffset] === " ") continue;
    loaders.add(match[1] ?? "require");
    referenceRanges.push({ start: match.index, end: match.index + match[0].length });
  }

  return { loaders: [...loaders], resolvers: [...resolvers], referenceRanges };
}

function normalizeParenthesizedReferences(source: string, references: readonly string[]): string {
  const normalized = [...source];
  for (const reference of [...references].sort((left, right) => right.length - left.length)) {
    let index = 0;
    while (index < source.length) {
      const current = normalized.join("");
      const code = sourceCodeMask(current);
      index = current.indexOf(reference, index);
      if (index === -1) break;
      if (
        code[index] !== " " &&
        !/[A-Za-z0-9_$]/u.test(current[index - 1] ?? "") &&
        !/[A-Za-z0-9_$]/u.test(current[index + reference.length] ?? "")
      ) {
        let left = index - 1;
        while (/\s/u.test(current[left] ?? "")) left -= 1;
        const right = skipCallTrivia(current, index + reference.length);
        if (current[left] === "(" && current[right] === ")") {
          normalized[left] = " ";
          normalized[right] = " ";
          index = left;
          continue;
        }
      }
      index += reference.length;
    }
  }
  return normalized.join("");
}

interface ArgumentRange {
  readonly start: number;
  readonly end: number;
}

function argumentRanges(
  source: string,
  openIndex: number,
  closing: ")" | "]",
): readonly ArgumentRange[] {
  const ranges: ArgumentRange[] = [];
  const stack: string[] = [closing];
  let start = openIndex + 1;
  let cursor = start;
  while (cursor < source.length) {
    const character = source[cursor]!;
    const next = source[cursor + 1];
    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", cursor + 2);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      cursor += 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor] === quote) {
          cursor += 1;
          break;
        } else cursor += 1;
      }
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      stack.push(character === "(" ? ")" : character === "[" ? "]" : "}");
      cursor += 1;
      continue;
    }
    if (character === stack.at(-1)) {
      if (stack.length === 1) {
        ranges.push({ start, end: cursor });
        return ranges;
      }
      stack.pop();
      cursor += 1;
      continue;
    }
    if (character === "," && stack.length === 1) {
      ranges.push({ start, end: cursor });
      start = cursor + 1;
    }
    cursor += 1;
  }
  return [];
}

function literalArgument(source: string, range: ArgumentRange): FirstCallArgument {
  const start = skipCallTrivia(source, range.start);
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return { kind: "nonliteral" };
  let cursor = start + 1;
  while (cursor < range.end) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (quote === "`" && source[cursor] === "$" && source[cursor + 1] === "{") {
      return { kind: "nonliteral" };
    }
    if (source[cursor] === quote) {
      return /^\s*$/u.test(source.slice(cursor + 1, range.end))
        ? { kind: "literal", value: source.slice(start + 1, cursor) }
        : { kind: "nonliteral" };
    }
    cursor += 1;
  }
  return { kind: "nonliteral" };
}

function indirectLoaderTarget(
  source: string,
  index: number,
  callee: string,
  method: "apply" | "call",
): FirstCallArgument | null {
  const indirectCallee = `${callee}.${method}`;
  if (!source.startsWith(indirectCallee, index)) return null;
  let cursor = skipCallTrivia(source, index + indirectCallee.length);
  if (source[cursor] !== "(") return null;
  const callArguments = argumentRanges(source, cursor, ")");
  const targetRange = callArguments[1];
  if (targetRange === undefined) return { kind: "nonliteral" };
  if (method === "call") return literalArgument(source, targetRange);
  cursor = skipCallTrivia(source, targetRange.start);
  if (source[cursor] !== "[") return { kind: "nonliteral" };
  const appliedArguments = argumentRanges(source, cursor, "]");
  return appliedArguments[0] === undefined
    ? { kind: "nonliteral" }
    : literalArgument(source, appliedArguments[0]);
}

function isReferenceRange(
  index: number,
  ranges: readonly { readonly start: number; readonly end: number }[],
): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function hasOpaqueComputedModuleReference(source: string): boolean {
  const code = sourceCodeMask(source);
  for (let index = 0; index < source.length; index += 1) {
    if (
      code[index] === " " ||
      !source.startsWith("module", index) ||
      /[A-Za-z0-9_$]/u.test(source[index - 1] ?? "") ||
      /[A-Za-z0-9_$]/u.test(source[index + "module".length] ?? "")
    ) {
      continue;
    }
    const cursor = skipCallTrivia(source, index + "module".length);
    if (source[cursor] === "[") return true;
  }
  return false;
}

function hasUnsupportedLoaderReference(
  source: string,
  loaders: readonly string[],
  resolvers: readonly string[],
  referenceRanges: readonly { readonly start: number; readonly end: number }[],
): boolean {
  const references = [...new Set([...loaders, ...resolvers])].sort(
    (left, right) => right.length - left.length,
  );
  const resolverSet = new Set(resolvers);
  const code = sourceCodeMask(source);
  const consumed = new Set<number>();
  for (let index = 0; index < source.length; index += 1) {
    if (code[index] === " " || consumed.has(index)) continue;
    const reference = references.find(
      (candidate) =>
        source.startsWith(candidate, index) &&
        !/[A-Za-z0-9_$]/u.test(source[index - 1] ?? "") &&
        !/[A-Za-z0-9_$]/u.test(source[index + candidate.length] ?? ""),
    );
    if (reference === undefined) continue;
    for (let offset = 0; offset < reference.length; offset += 1) consumed.add(index + offset);
    if (isReferenceRange(index, referenceRanges)) continue;
    const cursor = skipCallTrivia(source, index + reference.length);
    if (source[cursor] === "(") continue;
    if (
      indirectLoaderTarget(source, index, reference, "call") !== null ||
      indirectLoaderTarget(source, index, reference, "apply") !== null
    ) {
      continue;
    }
    const suffix = source.slice(cursor);
    if (resolverSet.has(reference) && /^\.\s*paths\s*\(/u.test(suffix)) continue;
    if (reference === "require" && /^\.\s*(?:cache|extensions)\b/u.test(suffix)) continue;
    if (source[cursor] === "=" && isRequireBinding(source, index)) continue;
    return true;
  }
  return false;
}

function analyzeCommonJsLoaders(source: string): CommonJsLoaderAnalysis {
  let normalized = normalizeComputedCommonJsProperties(source);
  const createdLoaders = createdRequireCallees(source);
  const initialLoaders = ["require", "module.require", "require.main.require", ...createdLoaders];
  const initialResolvers = [
    "require.resolve",
    ...createdLoaders.map((callee) => `${callee}.resolve`),
  ];
  const aliases = commonJsLoaderAliases(normalized, initialLoaders, initialResolvers);
  normalized = normalizeParenthesizedReferences(normalized, [
    ...aliases.loaders,
    ...aliases.resolvers,
  ]);
  const literalSpecifiers = new Set(
    literalCallSpecifiers(normalized, [...aliases.loaders, ...aliases.resolvers]),
  );
  let opaque = hasOpaqueCodeCall(normalized, [...aliases.loaders, ...aliases.resolvers], true);
  const code = sourceCodeMask(normalized);
  for (const loader of aliases.loaders) {
    for (let index = 0; index < normalized.length; index += 1) {
      if (code[index] === " ") continue;
      for (const method of ["call", "apply"] as const) {
        const target = indirectLoaderTarget(normalized, index, loader, method);
        if (target?.kind === "literal") literalSpecifiers.add(target.value);
        else if (target?.kind === "nonliteral") opaque = true;
      }
    }
    if (hasOpaqueCodeCall(normalized, [`${loader}.bind`], false)) opaque = true;
  }
  if (
    hasOpaqueComputedModuleReference(normalized) ||
    hasUnsupportedLoaderReference(
      normalized,
      aliases.loaders,
      aliases.resolvers,
      aliases.referenceRanges,
    )
  ) {
    opaque = true;
  }
  return { literalSpecifiers: [...literalSpecifiers], opaque };
}

function commonJsLiteralLoadSpecifiers(source: string): readonly string[] {
  return analyzeCommonJsLoaders(source).literalSpecifiers;
}

function isRequireBinding(source: string, index: number): boolean {
  const boundary = Math.max(
    source.lastIndexOf(";", index - 1),
    source.lastIndexOf("\n", index - 1),
  );
  return /(?:const|let|var|function)\s*$/u.test(source.slice(boundary + 1, index));
}

function opaqueSourceEdgeKinds(source: string): ReadonlySet<ManagedGateOpaqueEdgeKind> {
  const kinds = new Set<ManagedGateOpaqueEdgeKind>();
  const commonJs = analyzeCommonJsLoaders(source);
  if (hasOpaqueDynamicImport(source) || commonJs.opaque) {
    kinds.add("dynamic");
  }
  const pathCallees = [
    "Bun.file",
    ...importedCallees(source, FILESYSTEM_MODULE_NAMES, OPAQUE_PATH_METHODS),
    ...commonJsCallees(source, FILESYSTEM_MODULE_NAMES, OPAQUE_PATH_METHODS),
  ];
  if (hasOpaqueCall(source, pathCallees, false)) kinds.add("path");
  const spawnCallees = [
    "Bun.spawn",
    "Bun.spawnSync",
    ...importedCallees(source, CHILD_PROCESS_MODULE_NAMES, OPAQUE_SPAWN_METHODS),
    ...commonJsCallees(source, CHILD_PROCESS_MODULE_NAMES, OPAQUE_SPAWN_METHODS),
  ];
  if (hasOpaqueCall(source, spawnCallees, false)) kinds.add("spawn");
  return kinds;
}

async function resolveImportTarget(sourcePath: string, specifier: string): Promise<string | null> {
  const raw = resolve(dirname(sourcePath), specifier);
  const candidates = [raw];
  const extension = extname(raw);
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const stem = raw.slice(0, -extension.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  } else if (extension === "") {
    candidates.push(
      `${raw}.ts`,
      `${raw}.tsx`,
      `${raw}.js`,
      join(raw, "index.ts"),
      join(raw, "index.tsx"),
      join(raw, "index.js"),
    );
  }
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

export async function resolveManagedGateClosure(
  repositoryRootInput: string,
  manifestRelativePath: string = MANAGED_GATE_CLOSURE_MANIFEST,
): Promise<ManagedGateClosureResolution> {
  const unresolvedRepositoryRoot = resolve(repositoryRootInput);
  let repositoryRoot: string;
  try {
    repositoryRoot = await fs.realpath(unresolvedRepositoryRoot);
  } catch {
    repositoryRoot = unresolvedRepositoryRoot;
  }
  const manifestPath = safeRepositoryPath(repositoryRoot, manifestRelativePath);
  if (manifestPath === null) {
    return invalid(
      "path-escape",
      `gate closure manifest path escapes the repository: ${manifestRelativePath}`,
    );
  }
  const canonicalManifestPath = await canonicalRepositoryPath(
    repositoryRoot,
    manifestPath.absolute,
  );
  if (canonicalManifestPath === null) {
    if (await pathExists(manifestPath.absolute)) {
      return invalid(
        "path-escape",
        `resolved gate closure manifest escapes the repository: ${manifestRelativePath}`,
      );
    }
    return invalid(
      "manifest-missing",
      `gate closure manifest is missing at ${manifestPath.relative}`,
    );
  }
  let manifestBytes: string;
  try {
    manifestBytes = await fs.readFile(canonicalManifestPath, "utf8");
  } catch {
    return invalid(
      "manifest-missing",
      `gate closure manifest is missing at ${manifestPath.relative}`,
    );
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes);
  } catch (error) {
    return invalid(
      "manifest-invalid",
      `gate closure manifest is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parseManifest(manifestValue);
  if (manifest === null) {
    return invalid("manifest-invalid", "gate closure manifest does not match version 1");
  }
  const unresolvedPackagePath = safeRepositoryPath(repositoryRoot, manifest.target.packageJson);
  if (unresolvedPackagePath === null) {
    return invalid(
      "path-escape",
      `target package path escapes the repository: ${manifest.target.packageJson}`,
    );
  }
  const canonicalPackagePath = await canonicalRepositoryPath(
    repositoryRoot,
    unresolvedPackagePath.absolute,
  );
  if (canonicalPackagePath === null) {
    if (await pathExists(unresolvedPackagePath.absolute)) {
      return invalid(
        "path-escape",
        `resolved target package escapes the repository: ${manifest.target.packageJson}`,
      );
    }
    return invalid(
      "target-package-missing",
      `target package is missing at ${unresolvedPackagePath.relative}`,
    );
  }
  const packagePath = {
    absolute: canonicalPackagePath,
    relative: relative(repositoryRoot, canonicalPackagePath).split(sep).join("/"),
  };
  let packageBytes: string;
  let packageValue: unknown;
  try {
    packageBytes = await fs.readFile(packagePath.absolute, "utf8");
    packageValue = JSON.parse(packageBytes);
  } catch (error) {
    return invalid(
      "target-package-missing",
      `cannot read target package ${packagePath.relative}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(packageValue) || !isRecord(packageValue.scripts)) {
    return invalid(
      "target-script-missing",
      `target package ${packagePath.relative} has no scripts object`,
    );
  }
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(packageValue.scripts)) {
    if (typeof command === "string") scripts[name] = command;
  }
  const dag = resolveScriptDag(scripts, manifest.target.script);
  if ("missing" in dag) {
    return invalid(
      dag.parent === null ? "target-script-missing" : "script-edge-missing",
      dag.parent === null
        ? `target script ${JSON.stringify(dag.missing)} is missing from ${packagePath.relative}`
        : `script ${JSON.stringify(dag.parent)} references missing script ${JSON.stringify(dag.missing)}`,
    );
  }
  if (dag.sha256 !== manifest.target.scriptDagSha256) {
    return invalid(
      "target-diverged",
      `target script DAG digest ${dag.sha256} does not match declared ${manifest.target.scriptDagSha256}`,
    );
  }
  const targetRoot = dirname(packagePath.absolute);
  const targetLock = await resolveBunLock(repositoryRoot, targetRoot);
  if (targetLock.status === "path-escape") {
    return invalid(
      "path-escape",
      `resolved target Bun lock escapes the repository: ${relative(repositoryRoot, targetLock.path).split(sep).join("/")}`,
    );
  }
  if (targetLock.status === "missing") {
    return invalid(
      "bun-root-incomplete",
      `target ${packagePath.relative} has no sibling bun.lock or bun.lockb`,
    );
  }
  const bunConfiguration = await resolveApplicableBunConfiguration(repositoryRoot, targetRoot);
  if (bunConfiguration.status === "invalid") return bunConfiguration;

  const declarations = new Map<string, Set<ManagedGateOpaqueEdgeKind>>();
  const declarationTargets = new Map<string, Map<ManagedGateOpaqueEdgeKind, Set<string>>>();
  const declaredTargets: string[] = [];
  for (const edge of manifest.opaqueEdges) {
    if (edge.kind === "dynamic" && edge.targets.length === 0) {
      return invalid(
        "edge-target-missing",
        `opaque ${edge.kind} edge source ${edge.source} declares no targets`,
      );
    }
    const source = safeRepositoryPath(repositoryRoot, edge.source);
    if (source === null) {
      return invalid("path-escape", `opaque edge source escapes the repository: ${edge.source}`);
    }
    const canonicalSource = await canonicalRepositoryPath(repositoryRoot, source.absolute);
    if (canonicalSource === null) {
      if (await pathExists(source.absolute)) {
        return invalid(
          "path-escape",
          `resolved opaque edge source escapes the repository: ${edge.source}`,
        );
      }
      return invalid("edge-source-missing", `opaque edge source is missing: ${source.relative}`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(canonicalSource);
    } catch {
      return invalid("edge-source-missing", `opaque edge source is missing: ${source.relative}`);
    }
    const observed = sha256(bytes);
    if (observed !== edge.sha256) {
      return invalid(
        "source-digest-mismatch",
        `opaque ${edge.kind} edge source ${source.relative} digest ${observed} does not match declared ${edge.sha256}`,
      );
    }
    const kinds = declarations.get(canonicalSource) ?? new Set<ManagedGateOpaqueEdgeKind>();
    kinds.add(edge.kind);
    declarations.set(canonicalSource, kinds);
    const targetsByKind =
      declarationTargets.get(canonicalSource) ?? new Map<ManagedGateOpaqueEdgeKind, Set<string>>();
    const kindTargets = targetsByKind.get(edge.kind) ?? new Set<string>();
    for (const target of edge.targets) {
      const resolvedTarget = safeRepositoryPath(repositoryRoot, target);
      if (resolvedTarget === null) {
        return invalid("path-escape", `opaque edge target escapes the repository: ${target}`);
      }
      if (!(await pathExists(resolvedTarget.absolute))) {
        return invalid(
          "edge-target-missing",
          `opaque edge target is missing: ${resolvedTarget.relative}`,
        );
      }
      const canonicalTarget = await canonicalRepositoryPath(
        repositoryRoot,
        resolvedTarget.absolute,
      );
      if (canonicalTarget === null) {
        return invalid(
          "path-escape",
          `resolved opaque edge target escapes the repository: ${target}`,
        );
      }
      declaredTargets.push(canonicalTarget);
      kindTargets.add(canonicalTarget);
    }
    targetsByKind.set(edge.kind, kindTargets);
    declarationTargets.set(canonicalSource, targetsByKind);
  }
  if (dag.scripts.some((name) => /(?:^|\s|&&|;)nix(?:\s|$)/u.test(scripts[name]!))) {
    if (!declarations.get(packagePath.absolute)?.has("nix")) {
      return invalid(
        "source-declaration-missing",
        `reachable Nix command in ${packagePath.relative} lacks a hashed nix edge declaration`,
      );
    }
  }
  const configuredTargets: BunConfigurationTarget[] = [];
  if (bunConfiguration.status === "found") {
    const configured = bunConfiguration.configuration;
    if (!declarations.get(configured.path)?.has("path")) {
      return invalid(
        "source-declaration-missing",
        `applicable Bun configuration ${configured.relative} lacks a hashed path edge declaration`,
      );
    }
    const declaredConfigurationTargets =
      declarationTargets.get(configured.path)?.get("path") ?? new Set<string>();
    const observedConfigurationTargets = new Set(configured.targets.map((target) => target.path));
    if (
      declaredConfigurationTargets.size !== observedConfigurationTargets.size ||
      [...observedConfigurationTargets].some((target) => !declaredConfigurationTargets.has(target))
    ) {
      return invalid(
        "source-declaration-missing",
        `applicable Bun configuration ${configured.relative} path declaration does not exactly cover its executable targets`,
      );
    }
    for (const target of configured.targets) {
      if (target.kind === "preload" && !declarations.get(target.path)?.has("path")) {
        return invalid(
          "source-declaration-missing",
          `applicable Bun preload ${target.relative} lacks a hashed path edge declaration`,
        );
      }
      configuredTargets.push(target);
    }
  }

  const installRoots = new Set<string>([targetRoot]);
  const discoveredSources = await sourceFiles(repositoryRoot, targetRoot);
  if (discoveredSources.status === "path-escape") {
    return invalid(
      "path-escape",
      `resolved source entry ${discoveredSources.path} escapes the repository`,
    );
  }
  const pendingSources = [...discoveredSources.files];
  pendingSources.push(...declaredTargets);
  for (const target of configuredTargets) {
    if (target.kind === "preload") {
      pendingSources.push(target.path);
      continue;
    }
    const configuredSources = await sourceFiles(repositoryRoot, target.path);
    if (configuredSources.status === "path-escape") {
      return invalid(
        "path-escape",
        `resolved source entry ${configuredSources.path} escapes the repository`,
      );
    }
    pendingSources.push(...configuredSources.files);
  }
  const observedSources = new Set<string>();
  while (pendingSources.length > 0) {
    const sourcePath = pendingSources.shift()!;
    if (observedSources.has(sourcePath)) continue;
    observedSources.add(sourcePath);
    let source: string;
    try {
      source = await fs.readFile(sourcePath, "utf8");
    } catch {
      continue;
    }
    for (const kind of opaqueSourceEdgeKinds(source)) {
      if (!declarations.get(sourcePath)?.has(kind)) {
        return invalid(
          "source-declaration-missing",
          `opaque ${kind} edge in ${relative(repositoryRoot, sourcePath).split(sep).join("/")} lacks a hashed ${kind} edge declaration`,
        );
      }
    }
    for (const specifier of staticImportSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = await resolveImportTarget(sourcePath, specifier);
      if (target === null) {
        const rawTarget = resolve(dirname(sourcePath), specifier);
        if (!isRepositoryPath(repositoryRoot, rawTarget)) {
          return invalid("path-escape", `static import target ${rawTarget} escapes the repository`);
        }
        if (!rawTarget.startsWith(`${targetRoot}${sep}`)) {
          return invalid(
            "static-import-unresolved",
            `external static import ${JSON.stringify(specifier)} from ${relative(repositoryRoot, sourcePath)} cannot be resolved`,
          );
        }
        continue;
      }
      const canonicalTarget = await canonicalRepositoryPath(repositoryRoot, target);
      if (canonicalTarget === null) {
        return invalid(
          "path-escape",
          `resolved static import target ${target} escapes the repository`,
        );
      }
      const root = await nearestBunRoot(repositoryRoot, canonicalTarget);
      if (root.status === "path-escape") {
        return invalid("path-escape", `resolved Bun lock ${root.path} escapes the repository`);
      }
      if (root.status === "missing") {
        return invalid(
          "bun-root-incomplete",
          `static import target ${relative(repositoryRoot, canonicalTarget)} has no enclosing package.json plus Bun lock`,
        );
      }
      installRoots.add(root.root);
      pendingSources.push(canonicalTarget);
    }
  }
  for (const target of declaredTargets) {
    const root = await nearestBunRoot(repositoryRoot, target);
    if (root.status === "path-escape") {
      return invalid("path-escape", `resolved Bun lock ${root.path} escapes the repository`);
    }
    if (root.status === "missing") {
      return invalid(
        "bun-root-incomplete",
        `opaque edge target ${relative(repositoryRoot, target)} has no enclosing package.json plus Bun lock`,
      );
    }
    installRoots.add(root.root);
  }

  return {
    status: "resolved",
    version: MANAGED_GATE_CLOSURE_VERSION,
    targetPackageJson: packagePath.absolute,
    targetScript: manifest.target.script,
    reachableScripts: dag.scripts,
    installRoots: [...installRoots].sort((left, right) => {
      if (left === targetRoot) return -1;
      if (right === targetRoot) return 1;
      return left.localeCompare(right);
    }),
  };
}
