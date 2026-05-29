/**
 * InMemoryLedgerStore — hand-written dummy adapter used by the dual-tests
 * pattern. Persistence is a Map; archived milestone-groups + milestone-items
 * live in sibling Maps. No locks, no I/O.
 *
 * Concurrency: uses the same per-ledger AsyncMutex discipline as the real
 * adapter so tests that exercise concurrency behave the same way. The
 * `__milestones__` global mutex is mirrored here as well.
 */

import type {
  ArchivePointer,
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
  applyCreateItem,
  applyCreateMilestoneItem,
  applyDetachMilestoneGroup,
  applyDetachMilestoneItem,
  applyEnsureAmbientMilestone,
  applyUpdateItem,
  applyUpdateMilestoneItem,
  assertMilestoneActive,
  assertPrefixUnique,
  findItem,
  resolveMilestoneView,
  searchItems,
  validateSchema,
} from "./core.js";
import type {
  ArchiveContent,
  CreateItemInit,
  CreateMilestoneItemInit,
  FetchedMilestoneItem,
  LedgerStore,
  OnMutation,
  UpdateItemPatch,
  UpdateMilestoneItemPatch,
} from "./LedgerStore.js";
import type {
  FetchedLedger,
  FetchedMilestoneGroup,
  ResolvedMilestone,
} from "../types.js";
import { AsyncMutex } from "./mutex.js";
import {
  CANONICAL_LEDGERS,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
} from "../constants.js";

export interface InMemoryLedgerStoreOpts {
  /** Returns an ISO 8601 UTC timestamp. Defaults to `new Date().toISOString()`. */
  now?: () => string;
  /** Pre-populate registered ledgers (the milestones ledger is added automatically on init). */
  seed?: Array<{ name: string; schema: LedgerSchema }>;
  /**
   * Same contract as `FsLedgerStoreOpts.onMutation`. Provided here so
   * the dual-tests abstract suite can exercise the hook against both
   * adapters uniformly. Fires AFTER every successful write.
   */
  onMutation?: OnMutation;
}

/** Lock key for the global milestones mutex. */
const MILESTONES_MUTEX_KEY = "__milestones__";

export class InMemoryLedgerStore implements LedgerStore {
  private readonly ledgers = new Map<string, Ledger>();
  private readonly archives = new Map<string, Milestone>(); // key: `<ledger>/<id>` (groups)
  private readonly itemArchives = new Map<string, Item>(); // key: `milestones/<id>` (items)
  private readonly mutexes = new Map<string, AsyncMutex>();
  private readonly now: () => string;
  private readonly onMutation: OnMutation | null;
  private initialised = false;
  private readonly initialSeed: Array<{ name: string; schema: LedgerSchema }>;

  constructor(opts: InMemoryLedgerStoreOpts = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.initialSeed = opts.seed ?? [];
    this.onMutation = opts.onMutation ?? null;
  }

  /**
   * Synchronous, non-throwing wrapper around the user hook. Errors are
   * written to stderr so the write completes — matches the FS adapter
   * semantics so the dual-tests pattern stays observationally identical.
   */
  private fireMutation(
    ledgerId: string,
    op: "create" | "update" | "archive",
  ): void {
    if (this.onMutation === null) return;
    try {
      this.onMutation(ledgerId, op);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `InMemoryLedgerStore: onMutation hook threw for ${ledgerId} (${op}): ${msg}\n`,
      );
    }
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    // Bootstrap the canonical ledgers FIRST so a seed that diverges from
    // a canonical schema, or re-declares a canonical name, is rejected.
    this.bootstrapCanonicalLedgers();
    const canonicalNames = new Set(CANONICAL_LEDGERS.map((c) => c.name));
    // Seed user-supplied ledgers (refusing any canonical name keeps the
    // bootstrap path the single source of truth for those schemas).
    for (const { name, schema } of this.initialSeed) {
      if (canonicalNames.has(name)) {
        throw new BootstrapViolationError(
          `seed includes "${name}"; that ledger is bootstrapped automatically`,
        );
      }
      this.ledgers.set(name, freshLedger(name, schema));
    }
    this.initialised = true;
  }

  async dispose(): Promise<void> {
    const drains = Array.from(this.mutexes.values()).map((m) =>
      m.run(async () => undefined),
    );
    await Promise.all(drains);
    this.ledgers.clear();
    this.archives.clear();
    this.itemArchives.clear();
    this.mutexes.clear();
    this.initialised = false;
  }

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

  search(ledgerId: string, query: string): Item[] {
    return searchItems(this.getLedger(ledgerId), query).map(cloneItem);
  }

  fetchMilestone(milestoneId: string): FetchedMilestoneItem {
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

  async fetchArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    this.assertInit();
    if (ledgerId === MILESTONES_LEDGER) {
      const key = `${ledgerId}/${archiveId}`;
      const item = this.itemArchives.get(key);
      if (item === undefined) {
        throw new LedgerError(`archive ${archiveId} not found in ledger ${ledgerId}`);
      }
      return { kind: "item", item: cloneItem(item) };
    }
    const key = `${ledgerId}/${archiveId}`;
    const m = this.archives.get(key);
    if (m === undefined) {
      throw new LedgerError(`archive ${archiveId} not found in ledger ${ledgerId}`);
    }
    return { kind: "group", milestone: cloneMilestone(m) };
  }

  async updateMilestone(
    milestoneId: string,
    patch: UpdateMilestoneItemPatch,
  ): Promise<Item> {
    const item = await this.withMilestonesLock(async () => {
      const ledger = this.getLedger(MILESTONES_LEDGER);
      return cloneItem(applyUpdateMilestoneItem(ledger, milestoneId, patch, this.now()));
    });
    this.fireMutation(MILESTONES_LEDGER, "update");
    return item;
  }

  async updateItem(ledgerId: string, itemId: string, patch: UpdateItemPatch): Promise<Item> {
    const item = await this.withLock(ledgerId, async () => {
      return cloneItem(applyUpdateItem(this.getLedger(ledgerId), itemId, patch, this.now()));
    });
    this.fireMutation(ledgerId, "update");
    return item;
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
    // Acquire global milestones lock first (strict-existence check
    // reads the milestones ledger), then per-ledger lock.
    const item = await this.withMilestonesLock(async () => {
      assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), milestoneId);
      return this.withLock(ledgerId, async () => {
        return cloneItem(
          applyCreateItem(this.getLedger(ledgerId), milestoneId, init, this.now()),
        );
      });
    });
    this.fireMutation(ledgerId, "create");
    return item;
  }

  async createMilestone(init: CreateMilestoneItemInit): Promise<Item> {
    const item = await this.withMilestonesLock(async () => {
      const ledger = this.getLedger(MILESTONES_LEDGER);
      return cloneItem(applyCreateMilestoneItem(ledger, init, this.now()));
    });
    this.fireMutation(MILESTONES_LEDGER, "create");
    return item;
  }

  async createLedger(name: string, schema: LedgerSchema): Promise<FetchedLedger> {
    this.assertInit();
    if (name === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(
        `ledger name "${MILESTONES_LEDGER}" is reserved`,
      );
    }
    validateSchema(schema);
    if (this.ledgers.has(name)) throw new DuplicateIdError("ledger", name);
    assertPrefixUnique(
      name,
      schema,
      Array.from(this.ledgers.values(), (l) => ({ name: l.id, schema: l.schema })),
    );
    const ledger = freshLedger(name, schema);
    this.ledgers.set(name, ledger);
    const result = materialiseFetchedLedger(ledger, this.getLedger(MILESTONES_LEDGER));
    this.fireMutation(name, "create");
    return result;
  }

  async archiveMilestone(
    milestoneId: string,
    summary: string,
  ): Promise<ArchivePointer> {
    let participatingLedgers: string[] = [];
    const ptr = await this.withMilestonesLock(async () => {
      // Acquire every per-ledger lock in alphabetic order so we never
      // race a concurrent updateItem on a participating ledger.
      const otherLedgerIds = Array.from(this.ledgers.keys())
        .filter((n) => n !== MILESTONES_LEDGER)
        .sort();
      return this.withLocksInOrder(otherLedgerIds, async () => {
        participatingLedgers = otherLedgerIds.filter((id) => {
          const l = this.ledgers.get(id);
          return l !== undefined && l.milestones.some((m) => m.id === milestoneId);
        });
        return this.performArchive(milestoneId, summary);
      });
    });
    for (const id of participatingLedgers) this.fireMutation(id, "archive");
    this.fireMutation(MILESTONES_LEDGER, "archive");
    return ptr;
  }

  /**
   * In-memory adapter is the source of truth — there is no other
   * writer for `invalidate` to consult. Provided so the interface
   * shape is uniform with `FsLedgerStore` and the dual-tests suite
   * can assert the no-op contract.
   */
  async invalidate(_ledgerId: string): Promise<void> {
    // intentional no-op
  }

  // --- internals ---
  private bootstrapCanonicalLedgers(): void {
    for (const { name, schema } of CANONICAL_LEDGERS) {
      if (this.ledgers.has(name)) continue;
      const ledger = freshLedger(name, schema);
      if (name === MILESTONES_LEDGER) {
        ledger.milestones.push({
          id: MILESTONES_ACTIVE_GROUP_ID,
          title: MILESTONES_ACTIVE_GROUP_TITLE,
          description: "",
          items: [],
        });
        // Bootstrap the immortal M-AMBIENT milestone (§8b).
        applyEnsureAmbientMilestone(ledger, this.now());
      }
      this.ledgers.set(name, ledger);
    }
  }

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

  private performArchive(milestoneId: string, summary: string): ArchivePointer {
    if (milestoneId === MILESTONES_ACTIVE_GROUP_ID) {
      throw new BootstrapViolationError(
        `the bootstrap group ${MILESTONES_ACTIVE_GROUP_ID} cannot be archived`,
      );
    }
    if (milestoneId === MILESTONES_AMBIENT_ID) {
      throw new BootstrapViolationError(
        `${MILESTONES_AMBIENT_ID} is immortal and cannot be archived`,
      );
    }
    // Phase 1: verify no non-terminal items in ANY ledger.
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined) continue;
      const terminal = new Set(ledger.schema.terminalStatuses);
      const offending = group.items.filter((it) => !terminal.has(it.status));
      if (offending.length > 0) {
        // Throw via applyDetachMilestoneGroup so the error type matches
        // the real adapter path.
        applyDetachMilestoneGroup(
          ledger,
          milestoneId,
          summary,
          `./archive/${name}/${milestoneId}.md`,
        );
      }
    }
    // Phase 2: archive each non-milestones ledger that has a group.
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
      this.archives.set(`${name}/${milestoneId}`, milestone);
    }
    // Phase 3: archive the milestone-item itself.
    const milestonesLedger = this.getLedger(MILESTONES_LEDGER);
    const relPath = `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`;
    const { item, pointer } = applyDetachMilestoneItem(
      milestonesLedger,
      milestoneId,
      summary,
      relPath,
    );
    this.itemArchives.set(`${MILESTONES_LEDGER}/${milestoneId}`, item);
    return { ...pointer };
  }

  private async withLock<T>(ledgerId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.ledgers.has(ledgerId)) throw new LedgerNotFoundError(ledgerId);
    const mutex = this.mutexFor(ledgerId);
    return mutex.run(fn);
  }
  private async withMilestonesLock<T>(fn: () => Promise<T>): Promise<T> {
    const mutex = this.mutexFor(MILESTONES_MUTEX_KEY);
    return mutex.run(fn);
  }
  private async withLocksInOrder<T>(
    ledgerIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    // Recurse so each lock is held for the duration of all inner work.
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
  private assertInit(): void {
    if (!this.initialised) throw new LedgerError("InMemoryLedgerStore not initialised");
  }
}

// --- shared materialiser + clone helpers ---

export function materialiseFetchedLedger(
  ledger: Ledger,
  milestonesLedger: Ledger,
): FetchedLedger {
  const groups: FetchedMilestoneGroup[] = ledger.milestones.map((m) => {
    let resolved: ResolvedMilestone;
    if (ledger.id === MILESTONES_LEDGER) {
      // Self-resolution: the M0 active group itself doesn't correspond
      // to a milestone-item; expose a sentinel view so callers can rely
      // on the field always being populated.
      resolved = {
        id: m.id,
        status: "open",
        title: m.title,
        description: m.description,
      };
    } else {
      const view = resolveMilestoneViewSafe(milestonesLedger, m.id);
      // If the milestone is missing (e.g. archived, or the M0 caller is
      // running before bootstrap), surface an empty view so the caller
      // can still render the group. Errors here would hide the broken
      // state from the UI.
      resolved =
        view ?? {
          id: m.id,
          status: "unknown",
          title: "",
          description: "",
        };
    }
    return { id: m.id, milestone: resolved, items: m.items.map(cloneItem) };
  });
  return {
    id: ledger.id,
    schema: cloneSchema(ledger.schema),
    counters: { ...ledger.counters },
    milestones: groups,
    archivePointers: ledger.archivePointers.map((p) => ({ ...p })),
  };
}

function resolveMilestoneViewSafe(
  milestonesLedger: Ledger,
  milestoneId: string,
): ResolvedMilestone | null {
  return resolveMilestoneView(milestonesLedger, milestoneId);
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

function cloneSchema(s: LedgerSchema): LedgerSchema {
  const out: LedgerSchema = {
    statusValues: [...s.statusValues],
    terminalStatuses: [...s.terminalStatuses],
    fields: Object.fromEntries(
      Object.entries(s.fields).map(([k, v]) => [k, { ...v }]),
    ),
  };
  if (s.idPrefix !== undefined) out.idPrefix = s.idPrefix;
  return out;
}

function cloneMilestone(m: Milestone): Milestone {
  return { id: m.id, title: m.title, description: m.description, items: m.items.map(cloneItem) };
}

function cloneItem(i: Item): Item {
  return {
    id: i.id,
    milestoneId: i.milestoneId,
    status: i.status,
    fields: Object.fromEntries(
      Object.entries(i.fields).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
    ) as Item["fields"],
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}
