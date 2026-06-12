/**
 * Single source of truth for "which files under the ledger storage dir belong to
 * the ledger". The storage dir is `<root>/.cq/` (LEDGER_STORAGE_DIRNAME).
 *
 * `cq erase`, `cq move-ledger`, and any other cleanup/transplant site must agree
 * on this set so they NEVER touch unrelated content (e.g. a separate project-docs
 * `docs/drafts/` directory). The set is REGISTRY-DRIVEN — derived from
 * `.cq/ledgers.yaml` (unioned with the canonical names as a fallback) — not
 * a blind `*.md` glob or a whole-`.cq/` wipe.
 *
 * The ledger's own artifacts under `.cq/`:
 *   - `ledgers.yaml`                 — the registry
 *   - `<name>.md`                    — one per REGISTERED ledger (and the canonical set)
 *   - `archive/**`                   — archived milestone groups
 *   - `logs/**`                      — portable session logs (travel with the ledger tree)
 *   - `.locks/`, `.backup/`          — ephemeral runtime dirs (NEVER travel)
 *
 * Anything else under `.cq/` is treated as user content and left untouched.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";
import { CANONICAL_LEDGERS } from "../constants.js";

/** Filename of the registry under `.cq/`. */
export const LEDGER_REGISTRY_FILENAME = "ledgers.yaml";
/** Directory (under `.cq/`) holding archived milestone groups. */
export const LEDGER_ARCHIVE_DIRNAME = "archive";
/**
 * Portable runtime directory under `.cq/` — session logs that travel with the
 * ledger tree (included in `ledgerTreePaths`, snapshotted by `move-ledger`).
 */
export const LEDGER_PORTABLE_RUNTIME_DIRNAMES: readonly string[] = ["logs"];
/**
 * Ephemeral runtime directories under `.cq/` — the FS lock dir and
 * reset/divergence backups. They belong to the ledger (so `erase` removes them)
 * but are NOT part of the portable ledger tree (so `move-ledger` excludes them).
 */
export const LEDGER_EPHEMERAL_RUNTIME_DIRNAMES: readonly string[] = [".locks", ".backup"];
/**
 * All runtime directories under `.cq/` (portable + ephemeral). They all belong
 * to the ledger so `erase` removes them. Re-exported under the original name for
 * backward compatibility with existing callers.
 */
export const LEDGER_RUNTIME_DIRNAMES: readonly string[] = [
  ...LEDGER_PORTABLE_RUNTIME_DIRNAMES,
  ...LEDGER_EPHEMERAL_RUNTIME_DIRNAMES,
];

/** The ledger's own paths under the storage dir (`.cq/`), as ABSOLUTE paths. */
export interface LedgerArtifacts {
  /** Absolute `.cq/ledgers.yaml`, or `null` if it does not exist. */
  registryFile: string | null;
  /** Absolute `.cq/<name>.md` for each registered ledger that exists on disk. */
  ledgerFiles: string[];
  /** Absolute `.cq/archive`, or `null` if it does not exist. */
  archiveDir: string | null;
  /** Absolute runtime dirs (`logs`/`.locks`/`.backup`) that exist on disk. */
  runtimeDirs: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * The set of ledger names whose `<name>.md` files belong to the ledger: the
 * canonical set unioned with whatever `.cq/ledgers.yaml` registers. Tolerant of
 * both the canonical `- name: x` entry form and a bare `- x` string entry, and
 * of a missing/unparseable registry (falls back to the canonical names) — a
 * cleanup primitive must never throw on a slightly-off registry.
 */
async function registeredLedgerNames(docsDir: string): Promise<Set<string>> {
  const names = new Set<string>(CANONICAL_LEDGERS.map((c) => c.name));
  try {
    const text = await fs.readFile(path.join(docsDir, LEDGER_REGISTRY_FILENAME), "utf8");
    const raw = YAML.parse(text) as unknown;
    const ledgers = (raw as { ledgers?: unknown } | null)?.ledgers;
    if (Array.isArray(ledgers)) {
      for (const entry of ledgers) {
        const name = typeof entry === "string" ? entry : (entry as { name?: unknown } | null)?.name;
        if (typeof name === "string" && name.length > 0) names.add(name);
      }
    }
  } catch {
    /* missing or unparseable registry → canonical set only */
  }
  return names;
}

/**
 * Enumerate the ledger's OWN artifacts under `docsDir` (the storage dir, absolute
 * path). Only paths that EXIST are returned; non-ledger content is never included.
 */
export async function enumerateLedgerArtifacts(docsDir: string): Promise<LedgerArtifacts> {
  const names = await registeredLedgerNames(docsDir);

  const ledgerFiles: string[] = [];
  for (const name of names) {
    const p = path.join(docsDir, `${name}.md`);
    if (await exists(p)) ledgerFiles.push(p);
  }
  ledgerFiles.sort();

  const runtimeDirs: string[] = [];
  for (const dir of LEDGER_RUNTIME_DIRNAMES) {
    const p = path.join(docsDir, dir);
    if (await exists(p)) runtimeDirs.push(p);
  }

  const registryPath = path.join(docsDir, LEDGER_REGISTRY_FILENAME);
  const archivePath = path.join(docsDir, LEDGER_ARCHIVE_DIRNAME);
  return {
    registryFile: (await exists(registryPath)) ? registryPath : null,
    ledgerFiles,
    archiveDir: (await exists(archivePath)) ? archivePath : null,
    runtimeDirs,
  };
}

/**
 * The PORTABLE ledger tree as STORAGE-RELATIVE paths: `ledgers.yaml`, every
 * registered `<name>.md`, every `archive/**` file (recursive), and every
 * `logs/**` file (recursive). Ephemeral dirs (`.locks`/`.backup`) are EXCLUDED
 * — they never travel with the ledger. Used by `cq move-ledger` to
 * snapshot/materialise the orphan-ref tree. Sorted.
 */
export async function ledgerTreePaths(docsDir: string): Promise<string[]> {
  const art = await enumerateLedgerArtifacts(docsDir);
  const rel: string[] = [];
  if (art.registryFile !== null) rel.push(LEDGER_REGISTRY_FILENAME);
  for (const f of art.ledgerFiles) rel.push(path.basename(f));
  if (art.archiveDir !== null) await collectFilesRel(art.archiveDir, LEDGER_ARCHIVE_DIRNAME, rel);
  for (const dirName of LEDGER_PORTABLE_RUNTIME_DIRNAMES) {
    const dirPath = path.join(docsDir, dirName);
    if (await exists(dirPath)) await collectFilesRel(dirPath, dirName, rel);
  }
  return rel.sort();
}

/** Recursively collect file paths under `dir`, each prefixed with `relPrefix`. */
async function collectFilesRel(dir: string, relPrefix: string, out: string[]): Promise<void> {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of ents) {
    const rel = `${relPrefix}/${ent.name}`;
    if (ent.isDirectory()) await collectFilesRel(path.join(dir, ent.name), rel, out);
    else if (ent.isFile()) out.push(rel);
  }
}

/** Outcome of {@link removeLedgerArtifacts}. */
export interface RemoveLedgerArtifactsResult {
  /** Absolute paths actually removed (existing artifacts only). */
  removed: string[];
  /** True iff `docsDir` (the storage dir) itself was removed (it had no non-ledger content left). */
  docsDirRemoved: boolean;
}

/**
 * Remove the ledger's OWN artifacts under `docsDir` (the storage dir) — the
 * registry, every registered `<name>.md`, `archive/`, and the runtime dirs — and
 * NOTHING else. Unrelated content in `docsDir` is PRESERVED. If `docsDir` is
 * empty once the artifacts are gone, `docsDir` itself is removed.
 * Idempotent and ENOENT-tolerant. Returns the removed paths.
 */
export async function removeLedgerArtifacts(docsDir: string): Promise<RemoveLedgerArtifactsResult> {
  if (!(await exists(docsDir))) return { removed: [], docsDirRemoved: false };

  const art = await enumerateLedgerArtifacts(docsDir);
  const targets: string[] = [
    ...(art.registryFile !== null ? [art.registryFile] : []),
    ...art.ledgerFiles,
    ...(art.archiveDir !== null ? [art.archiveDir] : []),
    ...art.runtimeDirs,
  ];

  const removed: string[] = [];
  for (const t of targets) {
    await fs.rm(t, { recursive: true, force: true });
    removed.push(t);
  }

  // Remove docsDir itself ONLY if nothing unrelated remains under it.
  let docsDirRemoved = false;
  const left = await fs.readdir(docsDir);
  if (left.length === 0) {
    await fs.rmdir(docsDir);
    docsDirRemoved = true;
  }
  return { removed, docsDirRemoved };
}
