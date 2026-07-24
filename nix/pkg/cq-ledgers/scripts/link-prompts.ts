#!/usr/bin/env bun
/**
 * Atomically publish the rendered Claude prompt root and link Claude Code to it.
 *
 *   bun run link-prompts
 *   bun run link-prompts -- --check
 */

import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const LEDGERS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLAKE_ROOT = path.resolve(LEDGERS_ROOT, "..", "..", "..");
const ASSETS_ROOT = path.resolve(LEDGERS_ROOT, "..", "cq-assets");
const GENERATED_ROOT = path.join(ASSETS_ROOT, ".generated", "claude");
const SLOT_MARKER = "{{cq:fragment:";
const GENERATION_PATTERN = /^sha256-[0-9a-f]{64}$/;
const STAGING_PREFIX = ".tmp-";
const SYMLINK_TEMP_PREFIX = ".cq-prompt-link-";

/** One UTF-8 file in a complete rendered prompt root. */
export interface PromptFile {
  readonly path: string;
  readonly content: string;
}

/** The catalog fields needed to project rendered roles into Claude's layout. */
export interface ClaudePromptRole {
  readonly roleId: string;
  readonly canonicalSource: string;
}

/** One Claude link and the rendered source it resolves through. */
export interface PromptLink {
  readonly link: string;
  readonly source: string;
}

/** A link whose rendered source target does not resolve. */
export interface MissingTarget {
  readonly link: string;
  readonly source: string;
  readonly absSource: string;
}

export type PromptPathKind = "missing" | "directory" | "symlink" | "other";

/**
 * Filesystem boundary used by prompt publication. The workflow depends on this
 * interface; tests run it against both the production adapter and a hand-written
 * in-memory implementation.
 */
export interface PromptPublicationStore {
  createStagingDirectory(generatedRoot: string): Promise<string>;
  writeTree(root: string, files: readonly PromptFile[]): Promise<void>;
  readTree(root: string): Promise<readonly PromptFile[]>;
  pathKind(targetPath: string): Promise<PromptPathKind>;
  completeGeneration(source: string, destination: string): Promise<void>;
  replaceSymlinkAtomic(linkPath: string, targetPath: string): Promise<void>;
  listDirectory(directory: string): Promise<readonly string[]>;
  removeTree(targetPath: string): Promise<void>;
}

/** A source of a complete, rendered Claude prompt tree. */
export interface ClaudePromptRenderer {
  render(): Promise<readonly PromptFile[]>;
}

export interface MaterializeClaudePromptsOptions {
  readonly store: PromptPublicationStore;
  readonly renderer: ClaudePromptRenderer;
  readonly ledgersRoot: string;
  readonly generatedRoot: string;
}

export interface MaterializedClaudePrompts {
  readonly generation: string;
  readonly links: readonly PromptLink[];
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function safeRelativeFilePath(filePath: string): boolean {
  return (
    filePath !== "" &&
    !path.posix.isAbsolute(filePath) &&
    path.posix.normalize(filePath) === filePath &&
    !filePath.split("/").some((part) => part === "." || part === ".." || part === "")
  );
}

function canonicalTree(files: readonly PromptFile[]): readonly PromptFile[] {
  const seen = new Set<string>();
  const result = files.map((file) => {
    if (!safeRelativeFilePath(file.path)) {
      throw new Error(`rendered prompt path is not a safe relative file: "${file.path}"`);
    }
    if (seen.has(file.path)) {
      throw new Error(`rendered prompt tree contains duplicate path "${file.path}"`);
    }
    seen.add(file.path);
    return file;
  });
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function parseCatalog(content: string): readonly ClaudePromptRole[] {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new Error("rendered prompt catalog.json contains invalid JSON");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("rendered prompt catalog.json must contain a non-empty array");
  }

  const roleIds = new Set<string>();
  const sources = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`rendered prompt catalog.json[${index}] must contain an object`);
    }
    const roleId = Reflect.get(entry, "roleId");
    const canonicalSource = Reflect.get(entry, "canonicalSource");
    if (typeof roleId !== "string" || !/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(roleId)) {
      throw new Error(`rendered prompt catalog.json[${index}].roleId is invalid`);
    }
    if (
      typeof canonicalSource !== "string" ||
      !safeRelativeFilePath(canonicalSource) ||
      !canonicalSource.endsWith(".md") ||
      (!canonicalSource.startsWith("agents/") && !canonicalSource.startsWith("commands/"))
    ) {
      throw new Error(`rendered prompt catalog.json[${index}].canonicalSource is invalid`);
    }
    if (roleIds.has(roleId)) {
      throw new Error(`rendered prompt catalog contains duplicate roleId "${roleId}"`);
    }
    if (sources.has(canonicalSource)) {
      throw new Error(
        `rendered prompt catalog contains duplicate canonicalSource "${canonicalSource}"`,
      );
    }
    roleIds.add(roleId);
    sources.add(canonicalSource);
    return { roleId, canonicalSource };
  });
}

/**
 * Validate a complete rendered root and return the ordered catalog projection.
 * Extra files, missing roles, duplicate paths, and unresolved slots all fail.
 */
export function validateRenderedClaudeRoot(
  files: readonly PromptFile[],
): readonly ClaudePromptRole[] {
  const tree = canonicalTree(files);
  for (const file of tree) {
    if (file.content.includes(SLOT_MARKER)) {
      throw new Error(`rendered prompt "${file.path}" contains an unresolved slot`);
    }
  }

  const catalogFile = tree.find((file) => file.path === "catalog.json");
  if (catalogFile === undefined) {
    throw new Error("rendered prompt root is missing catalog.json");
  }
  const catalog = parseCatalog(catalogFile.content);
  const expectedPaths = new Set([
    "catalog.json",
    ...catalog.map((role) => `roles/${role.roleId}.md`),
  ]);
  for (const expectedPath of expectedPaths) {
    if (!tree.some((file) => file.path === expectedPath)) {
      throw new Error(`rendered prompt root is missing "${expectedPath}"`);
    }
  }
  for (const file of tree) {
    if (!expectedPaths.has(file.path)) {
      throw new Error(`rendered prompt root contains undeclared file "${file.path}"`);
    }
  }
  return catalog;
}

/** Build Claude links exclusively through the atomically switched current root. */
export function linksFromCatalog(catalog: readonly ClaudePromptRole[]): readonly PromptLink[] {
  return catalog.map((role) => ({
    link: `.claude/${role.canonicalSource}`,
    source: `../cq-assets/.generated/claude/current/roles/${role.roleId}.md`,
  }));
}

function treeDigest(files: readonly PromptFile[]): string {
  const hash = createHash("sha256");
  for (const file of canonicalTree(files)) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(Buffer.byteLength(file.content, "utf8")));
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function treesEqual(left: readonly PromptFile[], right: readonly PromptFile[]): boolean {
  const canonicalLeft = canonicalTree(left);
  const canonicalRight = canonicalTree(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every(
      (file, index) =>
        file.path === canonicalRight[index]?.path &&
        file.content === canonicalRight[index]?.content,
    )
  );
}

async function refuseNonSymlink(
  store: PromptPublicationStore,
  targetPath: string,
  displayPath: string,
): Promise<void> {
  const kind = await store.pathKind(targetPath);
  if (kind !== "missing" && kind !== "symlink") {
    throw new Error(`refusing to replace non-symlink ${displayPath}; remove it manually`);
  }
}

async function cleanupAfterSwitch(
  store: PromptPublicationStore,
  generatedRoot: string,
  generationName: string,
): Promise<void> {
  for (const entry of await store.listDirectory(generatedRoot)) {
    if (entry === "current" || entry === generationName) {
      continue;
    }
    if (entry.startsWith(STAGING_PREFIX) || GENERATION_PATTERN.test(entry)) {
      await store.removeTree(path.join(generatedRoot, entry));
    }
  }
}

/**
 * Materialize and publish one complete Claude root. No externally visible
 * pointer changes until rendering, validation, and every link preflight pass.
 */
export async function materializeClaudePrompts(
  options: MaterializeClaudePromptsOptions,
): Promise<MaterializedClaudePrompts> {
  const { store, renderer, ledgersRoot, generatedRoot } = options;
  const staging = await store.createStagingDirectory(generatedRoot);
  let stagingExists = true;

  try {
    const rendered = await renderer.render();
    await store.writeTree(staging, rendered);
    const stagedTree = await store.readTree(staging);
    const catalog = validateRenderedClaudeRoot(stagedTree);
    const links = linksFromCatalog(catalog);

    await refuseNonSymlink(
      store,
      path.join(generatedRoot, "current"),
      path.relative(ledgersRoot, path.join(generatedRoot, "current")),
    );
    for (const link of links) {
      await refuseNonSymlink(store, path.join(ledgersRoot, link.link), link.link);
    }

    const generationName = `sha256-${treeDigest(stagedTree)}`;
    const generation = path.join(generatedRoot, generationName);
    const generationKind = await store.pathKind(generation);
    if (generationKind === "missing") {
      await store.completeGeneration(staging, generation);
      stagingExists = false;
    } else if (generationKind === "directory") {
      const existingTree = await store.readTree(generation);
      if (!treesEqual(stagedTree, existingTree)) {
        throw new Error(`content-addressed prompt generation "${generationName}" differs`);
      }
      await store.removeTree(staging);
      stagingExists = false;
    } else {
      throw new Error(`prompt generation path "${generationName}" is not a directory`);
    }

    await store.replaceSymlinkAtomic(path.join(generatedRoot, "current"), generation);
    for (const link of links) {
      await store.replaceSymlinkAtomic(
        path.join(ledgersRoot, link.link),
        path.join(ledgersRoot, link.source),
      );
    }
    await cleanupAfterSwitch(store, generatedRoot, generationName);
    return { generation, links };
  } finally {
    if (stagingExists) {
      await store.removeTree(staging);
    }
  }
}

async function makeDirectoryTreeWritable(root: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    return;
  }
  await chmod(root, 0o755);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await makeDirectoryTreeWritable(path.join(root, entry.name));
    }
  }
}

/** Production filesystem adapter. */
export class NodePromptPublicationStore implements PromptPublicationStore {
  async createStagingDirectory(generatedRoot: string): Promise<string> {
    await mkdir(generatedRoot, { recursive: true });
    return mkdtemp(path.join(generatedRoot, STAGING_PREFIX));
  }

  async writeTree(root: string, files: readonly PromptFile[]): Promise<void> {
    for (const file of canonicalTree(files)) {
      const destination = path.join(root, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content, { encoding: "utf8", flag: "wx" });
    }
  }

  async readTree(root: string): Promise<readonly PromptFile[]> {
    const files: PromptFile[] = [];
    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const relativePath =
          relativeDirectory === "" ? entry.name : path.posix.join(relativeDirectory, entry.name);
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolutePath, relativePath);
        } else if (entry.isFile()) {
          files.push({
            path: relativePath,
            content: await readFile(absolutePath, "utf8"),
          });
        } else {
          throw new Error(`prompt tree contains non-file entry "${relativePath}"`);
        }
      }
    };
    await walk(root, "");
    return files;
  }

  async pathKind(targetPath: string): Promise<PromptPathKind> {
    try {
      const stat = await lstat(targetPath);
      if (stat.isSymbolicLink()) return "symlink";
      if (stat.isDirectory()) return "directory";
      return "other";
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return "missing";
      throw error;
    }
  }

  async completeGeneration(source: string, destination: string): Promise<void> {
    const makeReadOnly = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await makeReadOnly(entryPath);
        } else if (entry.isFile()) {
          await chmod(entryPath, 0o444);
        } else {
          throw new Error(`prompt tree contains non-file entry "${entryPath}"`);
        }
      }
      await chmod(directory, 0o555);
    };
    await makeReadOnly(source);
    await rename(source, destination);
  }

  async replaceSymlinkAtomic(linkPath: string, targetPath: string): Promise<void> {
    const kind = await this.pathKind(linkPath);
    if (kind !== "missing" && kind !== "symlink") {
      throw new Error(`refusing to replace non-symlink ${linkPath}; remove it manually`);
    }
    await mkdir(path.dirname(linkPath), { recursive: true });
    const temporaryLink = path.join(
      path.dirname(linkPath),
      `${SYMLINK_TEMP_PREFIX}${process.pid}-${randomUUID()}`,
    );
    const relativeTarget = path.relative(path.dirname(linkPath), targetPath);
    try {
      await symlink(relativeTarget, temporaryLink);
      await rename(temporaryLink, linkPath);
    } finally {
      await rm(temporaryLink, { force: true });
    }
  }

  readLink(linkPath: string): Promise<string> {
    return readlink(linkPath);
  }

  async listDirectory(directory: string): Promise<readonly string[]> {
    return readdir(directory);
  }

  async removeTree(targetPath: string): Promise<void> {
    await makeDirectoryTreeWritable(targetPath);
    await rm(targetPath, { recursive: true, force: true });
  }
}

/** Load the immutable Nix-built Claude root without linking it into the repo. */
export class NixClaudePromptRenderer implements ClaudePromptRenderer {
  constructor(
    private readonly store: PromptPublicationStore,
    private readonly flakeRoot: string,
  ) {}

  async render(): Promise<readonly PromptFile[]> {
    const result = Bun.spawnSync(
      ["nix", "build", "--no-link", "--print-out-paths", ".#claude-prompt-root"],
      {
        cwd: this.flakeRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `link-prompts: Claude prompt render failed:\n${new TextDecoder()
          .decode(result.stderr)
          .trimEnd()}`,
      );
    }
    const outputs = new TextDecoder()
      .decode(result.stdout)
      .trim()
      .split(/\s+/)
      .filter((output) => output !== "");
    if (outputs.length !== 1) {
      throw new Error(
        `link-prompts: expected one rendered Claude root, received ${outputs.length}`,
      );
    }
    return this.store.readTree(outputs[0] as string);
  }
}

/**
 * Check which rendered sources are absent. This remains side-effect free and
 * accepts an explicit root for temporary-filesystem tests.
 */
export async function checkLinks(
  links: readonly PromptLink[],
  ledgersRoot: string = LEDGERS_ROOT,
): Promise<MissingTarget[]> {
  const missing: MissingTarget[] = [];
  for (const { link, source } of links) {
    const absSource = path.join(ledgersRoot, source);
    try {
      await access(absSource);
    } catch {
      missing.push({ link, source, absSource });
    }
  }
  return missing;
}

async function main(): Promise<void> {
  const store = new NodePromptPublicationStore();
  if (process.argv.slice(2).includes("--check")) {
    const current = path.join(GENERATED_ROOT, "current");
    const catalog = validateRenderedClaudeRoot(await store.readTree(current));
    const links = linksFromCatalog(catalog);
    const missing = await checkLinks(links);
    if (missing.length > 0) {
      console.error("link-prompts --check: missing targets:");
      for (const { link, source, absSource } of missing) {
        console.error(`  ${link} -> ${source} (resolved: ${absSource})`);
      }
      process.exit(1);
    }
    console.log("link-prompts --check: all rendered targets present.");
    return;
  }

  const result = await materializeClaudePrompts({
    store,
    renderer: new NixClaudePromptRenderer(store, FLAKE_ROOT),
    ledgersRoot: LEDGERS_ROOT,
    generatedRoot: GENERATED_ROOT,
  });
  for (const link of result.links) {
    const absoluteLink = path.join(LEDGERS_ROOT, link.link);
    console.log(`${link.link} -> ${await store.readLink(absoluteLink)}`);
  }
}

if (import.meta.main) {
  await main();
}
