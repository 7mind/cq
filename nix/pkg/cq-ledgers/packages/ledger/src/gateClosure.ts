import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MANAGED_GATE_CLOSURE_VERSION = 1 as const;
export const MANAGED_GATE_CLOSURE_MANIFEST = "cq-gate-closure.json";

const BUN_LOCK_NAMES = ["bun.lock", "bun.lockb"] as const;
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

async function hasBunLock(directory: string): Promise<boolean> {
  for (const lock of BUN_LOCK_NAMES) {
    if (await pathExists(join(directory, lock))) return true;
  }
  return false;
}

async function nearestBunRoot(repositoryRoot: string, inputPath: string): Promise<string | null> {
  let current = inputPath;
  try {
    if (!(await fs.stat(current)).isDirectory()) current = dirname(current);
  } catch {
    return null;
  }
  while (true) {
    if ((await pathExists(join(current, "package.json"))) && (await hasBunLock(current))) {
      return current;
    }
    if (current === repositoryRoot) return null;
    const parent = dirname(current);
    if (
      parent === current ||
      !safeRepositoryPath(repositoryRoot, relative(repositoryRoot, parent))
    ) {
      return null;
    }
    current = parent;
  }
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(absolute);
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function staticImportSpecifiers(source: string): readonly string[] {
  const specifiers = new Set<string>();
  for (const pattern of STATIC_IMPORT_RES) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]!);
  }
  return [...specifiers];
}

function hasOpaqueDynamicImport(source: string): boolean {
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
    if (source.startsWith("import", index) && !/[A-Za-z0-9_$]/u.test(source[index - 1] ?? "")) {
      let cursor = index + "import".length;
      while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
      if (source[cursor] === "(") {
        cursor += 1;
        while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
        const argument = source[cursor];
        if (argument !== '"' && argument !== "'" && argument !== "`") return true;
        if (argument === "`") {
          const end = source.indexOf("`", cursor + 1);
          if (end === -1 || source.slice(cursor + 1, end).includes("${")) return true;
        }
      }
    }
    index += 1;
  }
  return false;
}

function hasCall(
  source: string,
  index: number,
  callee: string,
  nonLiteralFirstArgument: boolean,
): boolean {
  if (!source.startsWith(callee, index)) return false;
  if (/[A-Za-z0-9_$]/u.test(source[index - 1] ?? "")) return false;
  if (/[A-Za-z0-9_$]/u.test(source[index + callee.length] ?? "")) return false;
  let cursor = index + callee.length;
  while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
  if (source[cursor] !== "(") return false;
  if (!nonLiteralFirstArgument) return true;
  cursor += 1;
  while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
  return source[cursor] !== '"' && source[cursor] !== "'" && source[cursor] !== "`";
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

function opaqueSourceEdgeKinds(source: string): ReadonlySet<ManagedGateOpaqueEdgeKind> {
  const kinds = new Set<ManagedGateOpaqueEdgeKind>();
  if (hasOpaqueDynamicImport(source)) kinds.add("dynamic");
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
  let manifestBytes: string;
  try {
    manifestBytes = await fs.readFile(manifestPath.absolute, "utf8");
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
  if (!(await hasBunLock(targetRoot))) {
    return invalid(
      "bun-root-incomplete",
      `target ${packagePath.relative} has no sibling bun.lock or bun.lockb`,
    );
  }

  const declarations = new Map<string, Set<ManagedGateOpaqueEdgeKind>>();
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
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(source.absolute);
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
    const kinds = declarations.get(source.absolute) ?? new Set<ManagedGateOpaqueEdgeKind>();
    kinds.add(edge.kind);
    declarations.set(source.absolute, kinds);
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
    }
  }
  if (dag.scripts.some((name) => /(?:^|\s|&&|;)nix(?:\s|$)/u.test(scripts[name]!))) {
    if (!declarations.get(packagePath.absolute)?.has("nix")) {
      return invalid(
        "source-declaration-missing",
        `reachable Nix command in ${packagePath.relative} lacks a hashed nix edge declaration`,
      );
    }
  }

  const installRoots = new Set<string>([targetRoot]);
  const pendingSources = await sourceFiles(targetRoot);
  pendingSources.push(...declaredTargets);
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
      if (root === null) {
        return invalid(
          "bun-root-incomplete",
          `static import target ${relative(repositoryRoot, canonicalTarget)} has no enclosing package.json plus Bun lock`,
        );
      }
      installRoots.add(root);
      pendingSources.push(canonicalTarget);
    }
  }
  for (const target of declaredTargets) {
    const root = await nearestBunRoot(repositoryRoot, target);
    if (root === null) {
      return invalid(
        "bun-root-incomplete",
        `opaque edge target ${relative(repositoryRoot, target)} has no enclosing package.json plus Bun lock`,
      );
    }
    installRoots.add(root);
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
