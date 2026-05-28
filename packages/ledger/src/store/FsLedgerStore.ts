/**
 * FsLedgerStore — filesystem-backed implementation of `LedgerStore`.
 *
 * Layout under `root` (typically the server's --cwd):
 *   ./docs/ledgers.yaml                              # central registry
 *   ./docs/<ledger>.md                               # active ledger
 *   ./docs/archive/<ledger>/<milestone-id>.md        # archived group (or item, for milestones ledger)
 *   ./docs/.locks/<ledger>.lock                      # advisory lockfile
 *   ./docs/.locks/__milestones__.lock                # global milestones lock
 *
 * On init():
 *   - Read ./docs/ledgers.yaml (create with EMPTY_REGISTRY if missing).
 *   - Bootstrap the `milestones` ledger if absent (add entry to
 *     ledgers.yaml with `MILESTONES_SCHEMA`; write an empty file with
 *     the `## M0 — active` group).
 *   - For each registered ledger, read ./docs/<ledger>.md and parse it
 *     against the schema in the registry. Create an empty file if missing.
 *   - Populate in-memory state.
 *
 * Lock discipline (msunify cycle):
 *   - Per-ledger AsyncMutex + lockfile for within-ledger ops.
 *   - Global `__milestones__` AsyncMutex + lockfile for operations that
 *     mutate the milestones ledger OR create/archive items referencing it.
 *   - Multi-lock acquisition order: `__milestones__` first; then per-ledger
 *     locks in alphabetic order. This contract MUST hold for every
 *     multi-lock path to avoid cyclic deadlock.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  ArchivePointer,
  FetchedLedger,
  Item,
  Ledger,
  LedgerSchema,
  Milestone,
} from "../types.js";
import {
  BootstrapViolationError,
  DuplicateIdError,
  LedgerError,
  LedgerNotFoundError,
} from "../types.js";
import {
  parseLedger,
  parseArchive,
  parseMilestoneItemArchive,
} from "../parser/parse.js";
import {
  serializeLedger,
  serializeArchive as serializeArchiveImpl,
  serializeMilestoneItemArchive,
} from "../parser/serialize.js";
import {
  EMPTY_REGISTRY,
  parseRegistry,
  serializeRegistry,
} from "../registry.js";
import type { LedgerRegistry } from "../types.js";
import {
  applyCreateItem,
  applyCreateMilestoneItem,
  applyDetachMilestoneGroup,
  applyDetachMilestoneItem,
  applyUpdateItem,
  applyUpdateMilestoneItem,
  assertMilestoneActive,
  findItem,
  resolveMilestoneView,
  searchItems,
  validateSchema,
} from "./core.js";
import {
  materialiseFetchedLedger,
} from "./InMemoryLedgerStore.js";
import type {
  ArchiveContent,
  CreateItemInit,
  CreateMilestoneItemInit,
  FetchedMilestoneItem,
  LedgerStore,
  UpdateItemPatch,
  UpdateMilestoneItemPatch,
} from "./LedgerStore.js";
import { AsyncMutex } from "./mutex.js";
import { Lockfile, type LockfileOpts } from "./lockfile.js";
import {
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  MILESTONES_LEDGER,
  MILESTONES_SCHEMA,
} from "../constants.js";

export interface FsLedgerStoreOpts {
  /** Filesystem root (server --cwd). Ledgers live under `<root>/docs/`. */
  root: string;
  /**
   * Returns an ISO 8601 UTC timestamp. Defaults to
   * `() => new Date().toISOString()`.
   */
  now?: () => string;
  /** Lockfile injection points for tests (isPidAlive, selfPid, …). */
  lockfile?: LockfileOpts;
}

/** Global lock key for the milestones-cross-ledger mutex/lockfile. */
const MILESTONES_LOCK_KEY = "__milestones__";
const REGISTRY_LOCK_KEY = "__registry__";

export class FsLedgerStore implements LedgerStore {
  private readonly root: string;
  private readonly docsDir: string;
  private readonly locksDir: string;
  private readonly archiveDir: string;
  private readonly registryPath: string;
  private readonly mutexes = new Map<string, AsyncMutex>();
  private readonly ledgers = new Map<string, Ledger>();
  private readonly now: () => string;
  private readonly lockfile: Lockfile;
  private registry: LedgerRegistry = { ...EMPTY_REGISTRY, ledgers: [] };
  private initialised = false;

  constructor(opts: FsLedgerStoreOpts) {
    this.root = opts.root;
    this.docsDir = path.join(this.root, "docs");
    this.locksDir = path.join(this.docsDir, ".locks");
    this.archiveDir = path.join(this.docsDir, "archive");
    this.registryPath = path.join(this.docsDir, "ledgers.yaml");
    this.now = opts.now ?? (() => new Date().toISOString());
    this.lockfile = new Lockfile(opts.lockfile ?? {});
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    await fs.mkdir(this.docsDir, { recursive: true });
    await fs.mkdir(this.locksDir, { recursive: true });
    await fs.mkdir(this.archiveDir, { recursive: true });

    // Load registry.
    let registryText: string | null = null;
    try {
      registryText = await fs.readFile(this.registryPath, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
    }
    if (registryText === null) {
      await fs.writeFile(this.registryPath, serializeRegistry(EMPTY_REGISTRY), "utf8");
      this.registry = { version: 1, ledgers: [] };
    } else {
      this.registry = parseRegistry(registryText);
    }

    // Bootstrap milestones ledger if absent.
    const milestonesEntry = this.registry.ledgers.find(
      (e) => e.name === MILESTONES_LEDGER,
    );
    if (milestonesEntry === undefined) {
      this.registry.ledgers.push({
        name: MILESTONES_LEDGER,
        schema: MILESTONES_SCHEMA,
      });
      await this.writeRegistry();
    } else {
      // Defensive: if a prior cycle wrote an out-of-band schema, refuse
      // to start so the divergence is loud.
      if (!schemasEqual(milestonesEntry.schema, MILESTONES_SCHEMA)) {
        throw new BootstrapViolationError(
          `existing ${MILESTONES_LEDGER} ledger has a different schema than MILESTONES_SCHEMA`,
        );
      }
    }

    // Load each ledger (including milestones).
    for (const entry of this.registry.ledgers) {
      const isMilestones = entry.name === MILESTONES_LEDGER;
      const filePath = this.ledgerPath(entry.name);
      let text: string | null = null;
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw e;
      }
      let ledger: Ledger;
      if (text === null) {
        ledger = freshLedger(entry.name, entry.schema);
        if (isMilestones) seedBootstrapGroup(ledger);
        await this.writeLedgerFile(ledger);
      } else {
        ledger = parseLedger(text, {
          schema: entry.schema,
          isMilestonesLedger: isMilestones,
        });
        if (isMilestones && ledger.milestones.length === 0) {
          // Empty milestones file (no M0 group). Seed it and rewrite.
          seedBootstrapGroup(ledger);
          await this.writeLedgerFile(ledger);
        }
      }
      this.ledgers.set(entry.name, ledger);
    }
    this.initialised = true;
  }

  async dispose(): Promise<void> {
    const drains = Array.from(this.mutexes.values()).map((m) =>
      m.run(async () => undefined),
    );
    await Promise.all(drains);
    this.ledgers.clear();
    this.mutexes.clear();
    this.initialised = false;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  enumerate(): string[] {
    this.assertInit();
    return Array.from(this.ledgers.keys()).sort();
  }

  fetch(ledgerId: string): FetchedLedger {
    return materialiseFetchedLedger(
      this.getLedger(ledgerId),
      this.getLedger(MILESTONES_LEDGER),
    );
  }

  fetchItem(ledgerId: string, itemId: string): Item {
    return cloneItem(findItem(this.getLedger(ledgerId), itemId).item);
  }

  fetchMilestone(milestoneId: string): FetchedMilestoneItem {
    this.assertInit();
    const milestonesLedger = this.getLedger(MILESTONES_LEDGER);
    const resolved = resolveMilestoneView(milestonesLedger, milestoneId);
    if (resolved === null) {
      throw new LedgerError(`milestone ${milestoneId} not found`);
    }
    const item = findItem(milestonesLedger, milestoneId).item;
    const references = this.countReferences(milestoneId);
    return { milestone: cloneItem(item), resolved, references };
  }

  listMilestoneItems(milestoneId: string): Record<string, Item[]> {
    this.assertInit();
    const out: Record<string, Item[]> = {};
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined) continue;
      if (group.items.length === 0) continue;
      out[name] = group.items.map(cloneItem);
    }
    return out;
  }

  search(ledgerId: string, query: string): Item[] {
    return searchItems(this.getLedger(ledgerId), query).map(cloneItem);
  }

  async fetchArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    const ledger = this.getLedger(ledgerId);
    const ptr = ledger.archivePointers.find((p) => p.id === archiveId);
    if (ptr === undefined) {
      throw new LedgerError(
        `archive ${archiveId} not found in ledger ${ledgerId}`,
      );
    }
    const absPath = path.resolve(this.docsDir, ptr.path);
    this.assertWithinDocsRoot(absPath);
    const text = await fs.readFile(absPath, "utf8");
    if (ledgerId === MILESTONES_LEDGER) {
      const item = parseMilestoneItemArchive(text);
      return { kind: "item", item };
    }
    return { kind: "group", milestone: parseArchive(text) };
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  async updateMilestone(
    milestoneId: string,
    patch: UpdateMilestoneItemPatch,
  ): Promise<Item> {
    return this.withMilestonesLock(async () => {
      const ledger = this.getLedger(MILESTONES_LEDGER);
      const item = applyUpdateMilestoneItem(ledger, milestoneId, patch, this.now());
      await this.writeLedgerFile(ledger);
      return cloneItem(item);
    });
  }

  async updateItem(
    ledgerId: string,
    itemId: string,
    patch: UpdateItemPatch,
  ): Promise<Item> {
    return this.withLock(ledgerId, async () => {
      const ledger = this.getLedger(ledgerId);
      const it = applyUpdateItem(ledger, itemId, patch, this.now());
      await this.writeLedgerFile(ledger);
      return cloneItem(it);
    });
  }

  async createItem(
    ledgerId: string,
    milestoneId: string,
    init: CreateItemInit,
  ): Promise<Item> {
    if (ledgerId === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(
        `use createMilestone to add an item to the ${MILESTONES_LEDGER} ledger`,
      );
    }
    return this.withMilestonesLock(async () => {
      assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), milestoneId);
      return this.withLock(ledgerId, async () => {
        const ledger = this.getLedger(ledgerId);
        const item = applyCreateItem(ledger, milestoneId, init, this.now());
        await this.writeLedgerFile(ledger);
        return cloneItem(item);
      });
    });
  }

  async createMilestone(init: CreateMilestoneItemInit): Promise<Item> {
    return this.withMilestonesLock(async () => {
      const ledger = this.getLedger(MILESTONES_LEDGER);
      const item = applyCreateMilestoneItem(ledger, init, this.now());
      await this.writeLedgerFile(ledger);
      return cloneItem(item);
    });
  }

  async createLedger(name: string, schema: LedgerSchema): Promise<FetchedLedger> {
    this.assertInit();
    if (name === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(
        `ledger name "${MILESTONES_LEDGER}" is reserved`,
      );
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new LedgerError(
        `invalid ledger name "${name}": only A-Za-z0-9_- are allowed`,
      );
    }
    validateSchema(schema);
    if (this.ledgers.has(name)) {
      throw new DuplicateIdError("ledger", name);
    }
    return this.withRegistryLock(async () => {
      if (this.ledgers.has(name)) {
        throw new DuplicateIdError("ledger", name);
      }
      const ledger = freshLedger(name, schema);
      this.ledgers.set(name, ledger);
      this.registry.ledgers.push({ name, schema });
      await this.writeLedgerFile(ledger);
      await this.writeRegistry();
      return materialiseFetchedLedger(ledger, this.getLedger(MILESTONES_LEDGER));
    });
  }

  async archiveMilestone(
    milestoneId: string,
    summary: string,
  ): Promise<ArchivePointer> {
    return this.withMilestonesLock(async () => {
      // Acquire every per-ledger lock in alphabetic order BEFORE inspecting
      // any ledger, so we don't race a concurrent updateItem.
      const otherLedgerIds = Array.from(this.ledgers.keys())
        .filter((n) => n !== MILESTONES_LEDGER)
        .sort();
      return this.withLocksInOrder(otherLedgerIds, async () => {
        return this.performArchive(milestoneId, summary);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private countReferences(milestoneId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined) continue;
      if (group.items.length > 0) out[name] = group.items.length;
    }
    return out;
  }

  private async performArchive(
    milestoneId: string,
    summary: string,
  ): Promise<ArchivePointer> {
    if (milestoneId === MILESTONES_ACTIVE_GROUP_ID) {
      throw new BootstrapViolationError(
        `the bootstrap group ${MILESTONES_ACTIVE_GROUP_ID} cannot be archived`,
      );
    }
    // Phase 1 — verify no non-terminal items in ANY ledger. We dry-run
    // applyDetachMilestoneGroup to leverage its `NonTerminalItemsError`
    // emission, but undo the detach if it succeeds (we want to gate
    // BEFORE any in-memory or on-disk mutation).
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined) continue;
      const terminal = new Set(ledger.schema.terminalStatuses);
      const offending = group.items.filter((it) => !terminal.has(it.status)).map((it) => it.id);
      if (offending.length > 0) {
        // Surface via applyDetachMilestoneGroup so error types match.
        applyDetachMilestoneGroup(
          ledger,
          milestoneId,
          summary,
          `./archive/${name}/${milestoneId}.md`,
        );
      }
    }
    // Phase 1b — verify the milestone-item itself is terminal.
    const milestonesLedger = this.getLedger(MILESTONES_LEDGER);
    const group = milestonesLedger.milestones.find(
      (m) => m.id === MILESTONES_ACTIVE_GROUP_ID,
    );
    if (group === undefined) {
      throw new BootstrapViolationError(
        `milestones ledger is missing its bootstrap group`,
      );
    }
    const milestoneItem = group.items.find((it) => it.id === milestoneId);
    if (milestoneItem === undefined) {
      // Surface via applyDetachMilestoneItem so the error type is
      // `MilestoneItemNotFoundError("absent")`.
      applyDetachMilestoneItem(
        milestonesLedger,
        milestoneId,
        summary,
        `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`,
      );
    }
    // Phase 2 — for each non-milestones ledger with a matching group:
    // detach in-memory, write the archive file, write the ledger file.
    // Failures here leave the system in a partially-archived state but
    // every write is atomic-rename and the global lock prevents
    // interleaving.
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const hasGroup = ledger.milestones.some((m) => m.id === milestoneId);
      if (!hasGroup) continue;
      const relPath = `./archive/${name}/${milestoneId}.md`;
      const { milestone } = applyDetachMilestoneGroup(
        ledger,
        milestoneId,
        summary,
        relPath,
      );
      const archivePath = path.resolve(this.archiveDir, name, `${milestoneId}.md`);
      this.assertWithinDocsRoot(archivePath);
      await fs.mkdir(path.dirname(archivePath), { recursive: true });
      await atomicWrite(archivePath, serializeArchiveImpl(milestone));
      await this.writeLedgerFile(ledger);
    }
    // Phase 3 — detach the milestone-item from the milestones ledger,
    // write its single-item archive, write the milestones ledger.
    const relPath = `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`;
    const { item, pointer } = applyDetachMilestoneItem(
      milestonesLedger,
      milestoneId,
      summary,
      relPath,
    );
    const archivePath = path.resolve(this.archiveDir, MILESTONES_LEDGER, `${milestoneId}.md`);
    this.assertWithinDocsRoot(archivePath);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await atomicWrite(archivePath, serializeMilestoneItemArchive(item));
    await this.writeLedgerFile(milestonesLedger);
    return { ...pointer };
  }

  private async withLock<T>(ledgerId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.ledgers.has(ledgerId)) {
      throw new LedgerNotFoundError(ledgerId);
    }
    const mutex = this.mutexFor(ledgerId);
    return mutex.run(async () => {
      const release = await this.lockfile.acquire(this.locksDir, ledgerId);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  private async withMilestonesLock<T>(fn: () => Promise<T>): Promise<T> {
    const mutex = this.mutexFor(MILESTONES_LOCK_KEY);
    return mutex.run(async () => {
      const release = await this.lockfile.acquire(this.locksDir, MILESTONES_LOCK_KEY);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  private async withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
    const mutex = this.mutexFor(REGISTRY_LOCK_KEY);
    return mutex.run(async () => {
      const release = await this.lockfile.acquire(this.locksDir, REGISTRY_LOCK_KEY);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  private async withLocksInOrder<T>(
    ledgerIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    if (ledgerIds.length === 0) return fn();
    const [head, ...tail] = ledgerIds;
    if (head === undefined) return fn();
    return this.withLock(head, () => this.withLocksInOrder(tail, fn));
  }

  private mutexFor(key: string): AsyncMutex {
    let m = this.mutexes.get(key);
    if (m === undefined) {
      m = new AsyncMutex();
      this.mutexes.set(key, m);
    }
    return m;
  }

  private getLedger(ledgerId: string): Ledger {
    this.assertInit();
    const l = this.ledgers.get(ledgerId);
    if (l === undefined) throw new LedgerNotFoundError(ledgerId);
    return l;
  }

  private ledgerPath(name: string): string {
    return path.join(this.docsDir, `${name}.md`);
  }

  private async writeLedgerFile(ledger: Ledger): Promise<void> {
    await atomicWrite(this.ledgerPath(ledger.id), serializeLedger(ledger));
  }

  private async writeRegistry(): Promise<void> {
    await atomicWrite(this.registryPath, serializeRegistry(this.registry));
  }

  private assertInit(): void {
    if (!this.initialised) throw new LedgerError("FsLedgerStore not initialised");
  }

  /**
   * Defense-in-depth (D-LED-01): after resolving a filesystem path that
   * incorporates caller-supplied data (a milestone id, an archive-pointer
   * path), refuse to read or write if the result is not inside `docsDir`.
   * Catches future regressions even if id validation slips.
   */
  private assertWithinDocsRoot(resolvedAbsPath: string): void {
    if (
      resolvedAbsPath !== this.docsDir &&
      !resolvedAbsPath.startsWith(this.docsDir + path.sep)
    ) {
      throw new LedgerError(
        `archive path escapes docs root: ${resolvedAbsPath}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function atomicWrite(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, filePath);
}

function freshLedger(name: string, schema: LedgerSchema): Ledger {
  return {
    id: name,
    schema,
    counters: { milestone: 0, item: 0 },
    milestones: [],
    archivePointers: [],
  };
}

function seedBootstrapGroup(ledger: Ledger): void {
  ledger.milestones.push({
    id: MILESTONES_ACTIVE_GROUP_ID,
    title: MILESTONES_ACTIVE_GROUP_TITLE,
    description: "",
    items: [],
  });
}

function cloneItem(i: Item): Item {
  return {
    id: i.id,
    milestoneId: i.milestoneId,
    status: i.status,
    fields: cloneFields(i.fields),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

function cloneFields(
  f: Record<string, import("../types.js").FieldValue>,
): Record<string, import("../types.js").FieldValue> {
  const out: Record<string, import("../types.js").FieldValue> = {};
  for (const [k, v] of Object.entries(f)) {
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

function schemasEqual(a: LedgerSchema, b: LedgerSchema): boolean {
  // Cheap structural equality. Ordering of statusValues matters since
  // it affects display, but for schema-divergence-detection we treat
  // order-significant equality as the contract.
  if (a.statusValues.length !== b.statusValues.length) return false;
  for (let i = 0; i < a.statusValues.length; i++) {
    if (a.statusValues[i] !== b.statusValues[i]) return false;
  }
  if (a.terminalStatuses.length !== b.terminalStatuses.length) return false;
  for (let i = 0; i < a.terminalStatuses.length; i++) {
    if (a.terminalStatuses[i] !== b.terminalStatuses[i]) return false;
  }
  const aFieldNames = Object.keys(a.fields).sort();
  const bFieldNames = Object.keys(b.fields).sort();
  if (aFieldNames.length !== bFieldNames.length) return false;
  for (let i = 0; i < aFieldNames.length; i++) {
    if (aFieldNames[i] !== bFieldNames[i]) return false;
  }
  for (const name of aFieldNames) {
    const af = a.fields[name];
    const bf = b.fields[name];
    if (af === undefined || bf === undefined) return false;
    if (af.type !== bf.type || af.required !== bf.required) return false;
  }
  return true;
}

// Suppress unused-import diagnostic: `Milestone` is referenced via the
// `ArchiveContent` discriminated union and indirectly via parser types.
type _MilestoneAlias = Milestone;
void (null as _MilestoneAlias | null);
