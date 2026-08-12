import { lstatSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const PACKAGE_SOURCE_TREES = ["scripts", "src", "test"] as const;
const SKIPPED_DIRECTORIES = new Set(["dist", "node_modules"]);
const ANNOTATION_PATTERN = /^\/\/ expected-failure: ([a-z][a-z0-9-]*:[A-Za-z0-9-]+)$/;

export interface ExpectedFailureInventoryEntry {
  readonly file: string;
  readonly title: string;
  readonly ledgerRef: string;
}

export interface ExpectedFailureSource {
  readonly file: string;
  readonly source: string;
}

export interface ExpectedFailureMarker extends ExpectedFailureInventoryEntry {
  readonly line: number;
}

interface Token {
  readonly kind: "identifier" | "dot" | "left-paren" | "string" | "other";
  readonly value: string;
  readonly line: number;
}

interface Annotation {
  readonly ledgerRef: string;
  readonly line: number;
}

export class ExpectedFailurePolicyError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    detail: string,
  ) {
    super(`${file}:${line}: ${detail}`);
    this.name = "ExpectedFailurePolicyError";
  }
}

function walkSourceTree(root: string, files: string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walkSourceTree(entryPath, files);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
}

export function enumerateExpectedFailureSourceFiles(
  workspaceRoot: string,
): readonly string[] {
  const packagesRoot = path.join(workspaceRoot, "packages");
  const files: string[] = [];
  for (const packageEntry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!packageEntry.isDirectory() || packageEntry.isSymbolicLink()) continue;
    const packageRoot = path.join(packagesRoot, packageEntry.name);
    for (const sourceTree of PACKAGE_SOURCE_TREES) {
      const sourceRoot = path.join(packageRoot, sourceTree);
      try {
        if (lstatSync(sourceRoot).isDirectory()) walkSourceTree(sourceRoot, files);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export function readExpectedFailureSources(
  workspaceRoot: string,
  repositoryRoot: string,
): readonly ExpectedFailureSource[] {
  return enumerateExpectedFailureSourceFiles(workspaceRoot).map((file) => ({
    file: path.relative(repositoryRoot, file).split(path.sep).join("/"),
    source: readFileSync(file, "utf8"),
  }));
}

function readQuotedString(source: string, start: number): { value: string; end: number } {
  const quote = source[start]!;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === quote) return { value, end: index + 1 };
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) break;
      value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped;
      index += 1;
    } else {
      value += character;
    }
  }
  return { value, end: source.length };
}

function lex(source: string): { tokens: readonly Token[]; annotations: readonly Annotation[] } {
  const tokens: Token[] = [];
  const annotations: Annotation[] = [];
  let line = 1;
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    const next = source[index + 1];
    if (character === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const comment = source.slice(index, end === -1 ? source.length : end).trimEnd();
      const match = ANNOTATION_PATTERN.exec(comment);
      if (match !== null) annotations.push({ ledgerRef: match[1]!, line });
      index = end === -1 ? source.length : end;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      index = Math.min(index + 2, source.length);
      continue;
    }
    if (character === "`") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "\n") line += 1;
        if (source[index] === "`") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      const parsed = readQuotedString(source, index);
      tokens.push({ kind: "string", value: parsed.value, line });
      line += source.slice(index, parsed.end).split("\n").length - 1;
      index = parsed.end;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index), line });
      continue;
    }
    const kind = character === "." ? "dot" : character === "(" ? "left-paren" : "other";
    tokens.push({ kind, value: character, line });
    index += 1;
  }
  return { tokens, annotations };
}

function inventoryKey(entry: ExpectedFailureInventoryEntry): string {
  return `${entry.file}\0${entry.title}`;
}

export function scanExpectedFailures(
  sources: readonly ExpectedFailureSource[],
  inventory: readonly ExpectedFailureInventoryEntry[],
): readonly ExpectedFailureMarker[] {
  const inventoryByKey = new Map<string, ExpectedFailureInventoryEntry>();
  for (const entry of inventory) {
    const key = inventoryKey(entry);
    if (inventoryByKey.has(key)) {
      throw new ExpectedFailurePolicyError(entry.file, 1, `duplicate inventory entry ${JSON.stringify(entry.title)}`);
    }
    inventoryByKey.set(key, entry);
  }

  const markers: ExpectedFailureMarker[] = [];
  const consumedAnnotations = new Set<string>();
  for (const source of sources) {
    const { tokens, annotations } = lex(source.source);
    const annotationsByLine = new Map(annotations.map((entry) => [entry.line, entry]));
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.kind !== "identifier" || (token.value !== "test" && token.value !== "it")) continue;
      if (tokens[index + 1]?.kind !== "dot" || tokens[index + 2]?.value !== "failing") {
        const nearby = tokens.slice(index + 1, index + 6);
        if (nearby.some((candidate) => candidate.value === "failing")) {
          throw new ExpectedFailurePolicyError(source.file, token.line, "unsupported expected-failure call syntax");
        }
        continue;
      }
      if (tokens[index + 3]?.kind !== "left-paren") {
        throw new ExpectedFailurePolicyError(source.file, token.line, "unsupported expected-failure call syntax");
      }
      const titleToken = tokens[index + 4];
      if (titleToken?.kind !== "string") {
        throw new ExpectedFailurePolicyError(source.file, token.line, "expected-failure title must be a quoted string literal");
      }
      const annotation = annotationsByLine.get(token.line - 1);
      if (annotation === undefined) {
        throw new ExpectedFailurePolicyError(source.file, token.line, "expected-failure marker lacks an immediately preceding annotation");
      }
      const entry = inventoryByKey.get(`${source.file}\0${titleToken.value}`);
      if (entry === undefined) {
        throw new ExpectedFailurePolicyError(source.file, token.line, "expected-failure marker lacks an inventory entry");
      }
      if (entry.ledgerRef !== annotation.ledgerRef) {
        throw new ExpectedFailurePolicyError(source.file, annotation.line, "annotation and inventory ledger references differ");
      }
      consumedAnnotations.add(`${source.file}\0${annotation.line}`);
      markers.push({ ...entry, line: token.line });
    }
    for (const annotation of annotations) {
      if (!consumedAnnotations.has(`${source.file}\0${annotation.line}`)) {
        throw new ExpectedFailurePolicyError(source.file, annotation.line, "orphan expected-failure annotation");
      }
    }
  }

  const markerKeys = new Set(markers.map(inventoryKey));
  for (const entry of inventory) {
    if (!markerKeys.has(inventoryKey(entry))) {
      throw new ExpectedFailurePolicyError(entry.file, 1, `inventory entry has no live marker: ${JSON.stringify(entry.title)}`);
    }
  }
  return markers.sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file),
  );
}
