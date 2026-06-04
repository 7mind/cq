/**
 * ledger-tui — a full-screen, two-pane terminal UI over a ledger MCP server.
 *
 * Layout: a header line, a body split into a left list pane and a right
 * content pane, and a status bar showing the path (ledger → milestone → item)
 * plus key hints. Navigation is a stack of frames; each frame keeps its own
 * cursor so pressing Esc restores the position in the previous list. Long
 * lists scroll within the pane (with a scrollbar). Enter on an item focuses
 * the content pane so it can be scrolled; Esc unfocuses, then pops a level.
 *
 * Capability parity with before: browse ledgers → items/milestones, view item
 * detail (markdown-rendered), full-text search, edit item status & fields,
 * edit milestone status & title, create items & milestones. Edits/search open
 * as a centered overlay that owns input while active.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { SelectList } from "./components/SelectList.js";
import { TextPrompt } from "./components/TextPrompt.js";
import { Markdown, markdownLines } from "./markdownText.js";
import { useTermSize } from "./useTermSize.js";
import { LiveManager, type LiveStats } from "@cq/ledger-live";
import {
  statusColor,
  isTerminal,
  statusMatchesFilter,
  filterLabel,
  canAnswer,
  ANSWER_FIELD,
  ANSWERED_STATUS,
  RECOMMENDATION_FIELD,
  AS_RECOMMENDED_ANSWER,
  QUESTION_FIELD,
  QUESTION_FIELD_ORDER,
  SUGGESTIONS_FIELD,
  isQuestion,
  type StatusFilter,
} from "./status.js";
import type { FetchedLedger, FieldValue, FtsHit, Item, LedgerClient, LedgerSchema, LedgerSummary } from "./types.js";
import {
  defectFixTaskIds,
  hypothesisRelationships,
  eligibleColumnFields,
  defaultColumns,
  DEFECTS_LEDGER,
  TASKS_LEDGER,
  HYPOTHESIS_LEDGER,
  GOALS_LEDGER,
MILESTONES_SCHEMA,
} from "@cq/ledger";

const MILESTONES = "milestones";
/** Goals (T84): the `id[]` field holding a goal's work-milestone ids, shown as
 * a flat list in the content pane in place of the coordination-milestone line. */
const GOAL_MILESTONES_FIELD = "milestones";
/** Default ledger the batch-answer stepper (T64) targets when the current
 * frame isn't itself answerable. */
const QUESTIONS_LEDGER = "questions";
/** Provenance author stamped on writes made by a human through this editor. */
const UI_AUTHOR = "user";

/** List/detail split: orientation + the list pane's fraction of the body. */
type PanelOrientation = "right" | "bottom";
interface PanelLayout {
  orientation: PanelOrientation;
  ratio: number;
}
const PANEL_DEFAULT: PanelLayout = { orientation: "right", ratio: 0.5 };
/** Fixed height (rows) of the bottom status bar; the hint text wraps within it.
 * Constant so bodyRows accounting is exact regardless of hint-wrap width. */
const STATUS_ROWS = 2;
/** Rows scrolled per PageUp/PageDown in the detail content pane. */
const CONTENT_PAGE = 10;
const PANEL_MIN_RATIO = 0.2;
const PANEL_MAX_RATIO = 0.8;
const PANEL_STEP = 0.05;
const clampRatio = (r: number): number => Math.max(PANEL_MIN_RATIO, Math.min(PANEL_MAX_RATIO, r));

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function fieldToString(v: FieldValue | undefined): string {
  if (v === undefined) return "";
  return Array.isArray(v) ? v.join(", ") : v;
}
const SUMMARIZE_MAX = 80;
function summarize(item: Item): string {
  const f = item.fields;
  const pick = f["headline"] ?? f["title"] ?? f["question"] ?? f["summary"];
  if (pick !== undefined) return fieldToString(pick as FieldValue | undefined);
  // Legacy fallback for reviews with no summary: truncate the first criticism line.
  const crit = f["criticism"];
  if (Array.isArray(crit) && crit.length > 0) {
    const line = String(crit[0]).split("\n")[0] ?? "";
    return line.length > SUMMARIZE_MAX ? line.slice(0, SUMMARIZE_MAX) + "…" : line;
  }
  return fieldToString(Object.values(f)[0] as FieldValue | undefined);
}
/** A field is "short" (fixed-size) when its value is single-line and compact. */
const SHORT_FIELD_MAX = 48;
function isShortField(v: FieldValue): boolean {
  const s = fieldToString(v);
  return !s.includes("\n") && s.length <= SHORT_FIELD_MAX;
}
/** Short/fixed-size fields first (original order preserved), long fields after. */
function orderItemFields(entries: Array<[string, FieldValue]>): Array<[string, FieldValue]> {
  return [
    ...entries.filter(([, v]) => isShortField(v)),
    ...entries.filter(([, v]) => !isShortField(v)),
  ];
}
export function parseFieldValue(raw: string, type: string): FieldValue {
  if (type === "string[]") {
    return raw.split(/[;\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (type === "id[]") {
    return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return raw;
}

/** True when the item carries a non-empty `recommendation` field. */
function hasRecommendation(item: Item): boolean {
  return fieldToString(item.fields[RECOMMENDATION_FIELD]).trim().length > 0;
}

/** True when the item carries a non-empty persisted `answer` field. */
function hasPersistedAnswer(item: Item): boolean {
  return fieldToString(item.fields[ANSWER_FIELD]).trim().length > 0;
}

/**
 * Extract the suggestions list from an item's `suggestions` field (T87).
 * Returns a string[] (possibly empty) suitable for number-key picking.
 */
function getSuggestions(item: Item): string[] {
  const v = item.fields[SUGGESTIONS_FIELD];
  if (!Array.isArray(v)) return [];
  return v.filter((s) => typeof s === "string" && (s as string).length > 0) as string[];
}

export interface Row {
  item: Item;
  milestoneId: string;
}
function ledgerRows(view: FetchedLedger): Row[] {
  return view.milestones.flatMap((g) => g.items.map((item) => ({ item, milestoneId: g.id })));
}

// ---------------------------------------------------------------------------
// Heavy per-data derivations + invocation instrumentation (T85).
//
// The items frame re-renders on every keystroke — including a pure cursor move,
// which only changes `top.cursor`. The three derivations below are O(N) in the
// ledger size; left inline in the render body they ran on EVERY keystroke. They
// are now hoisted to module scope and invoked through useMemo keyed on their
// real inputs, so a cursor move does NO O(N) work. The counters let a test
// assert exactly that: the builders run once per data change, never per nav.
// ---------------------------------------------------------------------------

/** Per-derivation invocation counters, observable by tests (T85). */
export const derivationCounters = {
  filterVisibleRows: 0,
  computeColumnLayout: 0,
  buildItemEntries: 0,
};
/** Reset all derivation counters (test helper). */
export function resetDerivationCounters(): void {
  derivationCounters.filterVisibleRows = 0;
  derivationCounters.computeColumnLayout = 0;
  derivationCounters.buildItemEntries = 0;
}

/** Rows of `view` passing the active status `filter`. O(N) over all rows. */
export function filterVisibleRows(view: FetchedLedger, filter: StatusFilter): Row[] {
  derivationCounters.filterVisibleRows += 1;
  return ledgerRows(view).filter((r) => statusMatchesFilter(r.item.status, view.schema, filter));
}

/** Stable empty-rows sentinel so a non-items frame keeps the memo dep stable. */
const EMPTY_ROWS: readonly Row[] = [];

/** Aligned-column widths over every displayed row (active + archive). */
export interface ColumnLayout {
  maxIdW: number;
  maxStatusW: number;
  /** Index-aligned with `extraColumns`. */
  columnWidths: number[];
}
/**
 * Column widths for the items list: id width, status width, and per-extra-column
 * widths. O(N) over `allRows` (× the extra columns); recomputed only when the
 * displayed rows, the schema, or the column selection change.
 */
export function computeColumnLayout(
  allRows: readonly Row[],
  schema: LedgerSchema,
  extraColumns: readonly string[],
): ColumnLayout {
  derivationCounters.computeColumnLayout += 1;
  const maxIdW = allRows.reduce((m, r) => Math.max(m, r.item.id.length), 2);
  const maxStatusW = schema.statusValues.reduce((m, s) => Math.max(m, s.length), 4);
  const columnWidths = extraColumns.map((field) =>
    allRows.reduce(
      (m, r) => Math.max(m, fieldToString(r.item.fields[field]).length),
      field.length,
    ),
  );
  return { maxIdW, maxStatusW, columnWidths };
}

/**
 * Rows of `view` that are currently answerable (their status admits the
 * `answered` transition) — i.e. the still-open items the batch-answer stepper
 * (T64) walks through. Preserves fetch_ledger group/item order.
 */
function answerableRows(view: FetchedLedger): Row[] {
  return ledgerRows(view).filter((r) => canAnswer(view.schema, r.item.status));
}

// ---------------------------------------------------------------------------
// List entries: union of selectable item rows and non-selectable headers.
// The cursor indexes into items only; headers are visual separators only.
// ---------------------------------------------------------------------------

export type ListEntry<T> =
  | { t: "item"; item: T; itemIdx: number }
  | { t: "header"; label: string; node?: React.ReactNode };

/**
 * Build entries for an items ledger. By default each fetch_ledger milestone
 * group becomes a subsection header interleaved with its filtered item rows,
 * preserving group order. When `flat` is set the list is rendered as a flat
 * sequence with NO subsection headers — true for the milestones ledger (each
 * item already IS a milestone) and the goals ledger (T84 / Q48: a goal's
 * coordination-milestone grouping is suppressed; its work-milestone ids live in
 * fields.milestones and are shown in the content pane instead).
 * The returned `itemIdx` matches the item's index in `filteredRows`.
 *
 * `milestonesSchema` is used to color the status token in each header via
 * statusColor() so open/done/postponed/blocked render in their semantic color.
 */
export function buildItemEntries(view: FetchedLedger, filteredRows: Row[], flat: boolean, milestonesSchema: LedgerSchema): ListEntry<Row>[] {
  derivationCounters.buildItemEntries += 1;
  if (flat) {
    return filteredRows.map((r, i) => ({ t: "item", item: r, itemIdx: i }));
  }
  const entries: ListEntry<Row>[] = [];
  // Group rows by milestone, preserving the fetch_ledger group order
  const rowsByMilestone = new Map<string, Array<{ row: Row; itemIdx: number }>>();
  filteredRows.forEach((r, i) => {
    const bucket = rowsByMilestone.get(r.milestoneId) ?? [];
    bucket.push({ row: r, itemIdx: i });
    rowsByMilestone.set(r.milestoneId, bucket);
  });
  for (const g of view.milestones) {
    const bucket = rowsByMilestone.get(g.id);
    if (bucket === undefined || bucket.length === 0) continue;
    const title = g.milestone.title ? ` ${g.milestone.title}` : "";
    const label = `${g.id}${title} [${g.milestone.status}]`;
    const statusToken = g.milestone.status;
    const color = statusColor(statusToken, milestonesSchema);
    const node = (
      <Text>
        {g.id}{title}{" ["}
        <Text color={color}>{statusToken}</Text>
        {"]"}
      </Text>
    );
    entries.push({ t: "header", label, node });
    for (const { row, itemIdx } of bucket) {
      entries.push({ t: "item", item: row, itemIdx });
    }
  }
  return entries;
}

/**
 * The memoized bundle of items-frame derivations (T85). `activeRows` is the
 * filtered active set; `allRows` appends the archive rows when shown; `layout`
 * holds the aligned column widths; `activeEntries` is the built list (without
 * the archive section, which is appended cheaply per render).
 */
interface ItemsDerived {
  activeRows: Row[];
  allRows: Row[];
  extraColumns: string[];
  layout: ColumnLayout;
  activeEntries: ListEntry<Row>[];
}

// ---------------------------------------------------------------------------
// Navigation frames + overlays
// ---------------------------------------------------------------------------

type Frame =
  | { kind: "ledgers"; cursor: number }
  | {
      kind: "items";
      ledger: string;
      view: FetchedLedger;
      cursor: number;
      focus: "list" | "content";
      scroll: number;
      /** Whether the archive section is visible below active items. */
      showArchive: boolean;
      /** Rows assembled from all fetched archives for this ledger. */
      archiveRows: Row[];
      /** True while archive data is being fetched (after toggle). */
      archiveLoading: boolean;
    };

type Overlay =
  | { t: "search" }
  | { t: "status"; row: Row }
  | { t: "answer"; row: Row }
  | { t: "pickField"; row: Row }
  | { t: "editField"; row: Row; field: string }
  | { t: "editTitle"; row: Row }
  | { t: "createMilestone" }
  | { t: "createItem"; milestones: Item[] }
  | { t: "filter" }
  | { t: "pickColumns"; ledger: string }
  /**
   * Batch-answer (T64): a full-screen stepper over the open answerable items of
   * one ledger. `ledger` identifies the write target (which may differ from the
   * frame the user is on — defaults to the questions ledger). `rows` is the
   * snapshot of open answerable rows at entry; `idx` is the current position.
   */
  | { t: "batchAnswer"; ledger: string; rows: Row[]; idx: number };

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App({
  client,
  liveUrl = null,
  liveWsCtor,
  onSubscribe = null,
}: {
  client: LedgerClient;
  liveUrl?: string | null;
  liveWsCtor?: { new (url: string): WebSocket };
  /**
   * In-process change source for embedded mode (no WebSocket): given a refresh
   * callback, start watching and return a disposer. When set (and `liveUrl` is
   * null) the App refreshes on external file changes via this instead of a WS.
   */
  onSubscribe?: ((onChange: () => void) => () => void) | null;
}): React.ReactElement {
  const { exit } = useApp();
  const { cols, rows } = useTermSize();
  // displayName() is synchronous (captured at connect time by the client).
  const dn = client.displayName();
  const headerTitle = dn.length > 0 ? `[${dn}] LLM ledgers` : "ledger-tui";
  const [conn, setConn] = useState<"connecting" | "connected" | "error">("connecting");
  const [connErr, setConnErr] = useState("");
  const [ledgers, setLedgers] = useState<LedgerSummary[]>([]);
  const [stack, setStack] = useState<Frame[]>([{ kind: "ledgers", cursor: 0 }]);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [flash, setFlash] = useState("");
  const [live, setLive] = useState<LiveStats | null>(null);
  const [filter, setFilter] = useState<StatusFilter>({ kind: "all" });
  const [panel, setPanel] = useState<PanelLayout>(PANEL_DEFAULT);
  /**
   * Cross-ledger item cache: lazily fetched secondary ledgers used for
   * relationship resolution (e.g. tasks when viewing defects).
   */
  const [crossItems, setCrossItems] = useState<Map<string, Item[]>>(new Map());
  /**
   * Per-ledger extra-column selection, held IN MEMORY for the session only
   * (Q29 — no server/config persistence). A ledger absent from the map has
   * not been customised this session; its columns are seeded lazily from
   * `defaultColumns(ledgerName)` on first read. Selecting columns through the
   * picker writes the explicit set here, which then survives navigation
   * within the session.
   */
  const [columnsByLedger, setColumnsByLedger] = useState<Map<string, string[]>>(new Map());
  const refreshRef = React.useRef<() => void>(() => {});
  // Max scroll offset of the detail pane for the current item, published by
  // ContentPane each render so the key handler can clamp scroll (avoids
  // over-scrolling past the end, which would make scroll-back feel stuck).
  const contentMaxScroll = React.useRef(0);

  useEffect(() => {
    let alive = true;
    client
      .enumerateLedgers()
      .then((ls) => {
        if (!alive) return;
        setLedgers(ls);
        setConn("connected");
      })
      .catch((e: unknown) => {
        if (alive) {
          setConn("error");
          setConnErr(errMsg(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [client]);

  const top = stack[stack.length - 1]!;
  const patchTop = useCallback((patch: Partial<Frame>): void => {
    setStack((s) => {
      const t = s[s.length - 1]!;
      return [...s.slice(0, -1), { ...t, ...patch } as Frame];
    });
  }, []);

  // Effective extra columns for a ledger: the session selection if the user
  // has customised it, else the per-ledger defaults (seeded lazily).
  const columnsFor = useCallback(
    (ledger: string): string[] => columnsByLedger.get(ledger) ?? defaultColumns(ledger),
    [columnsByLedger],
  );
  const setColumnsFor = useCallback((ledger: string, cols: string[]): void => {
    setColumnsByLedger((m) => {
      const next = new Map(m);
      next.set(ledger, cols);
      return next;
    });
  }, []);

  // Rows of an items view after the active status filter. The cursor indexes
  // into THIS list, so every input/render path must use it (not raw rows).
  const visibleRows = useCallback(
    (view: FetchedLedger): Row[] => filterVisibleRows(view, filter),
    [filter],
  );

  const openLedger = useCallback(
    async (name: string) => {
      try {
        const view = await client.fetchLedger(name);
        setStack((s) => [...s, { kind: "items", ledger: name, view, cursor: 0, focus: "list", scroll: 0, showArchive: false, archiveRows: [], archiveLoading: false }]);
        setFilter({ kind: "all" });
        setFlash("");
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client],
  );

  const reloadItems = useCallback(async (): Promise<void> => {
    if (top.kind !== "items") return;
    try {
      const view = await client.fetchLedger(top.ledger);
      patchTop({ view });
    } catch (e) {
      setFlash(errMsg(e));
    }
  }, [client, top, patchTop]);

  // Keep the refresh closure current for the long-lived live connection.
  useEffect(() => {
    refreshRef.current = (): void => {
      void (async () => {
        try {
          setLedgers(await client.enumerateLedgers());
          await reloadItems();
        } catch {
          /* surfaces on the next change */
        }
      })();
    };
  }, [client, reloadItems]);

  // Lazily fetch secondary ledgers needed for relationship resolution.
  // When the user is browsing defects, fetch tasks (for fix-task links).
  useEffect(() => {
    if (top.kind !== "items") return;
    let secondary: string | null = null;
    if (top.ledger === DEFECTS_LEDGER) secondary = TASKS_LEDGER;
    if (secondary === null || crossItems.has(secondary)) return;
    let alive = true;
    client.fetchLedger(secondary).then((view) => {
      if (!alive) return;
      const items = view.milestones.flatMap((g) => g.items);
      setCrossItems((prev) => {
        const next = new Map(prev);
        next.set(secondary!, items);
        return next;
      });
    }).catch(() => {
      /* silently ignore — cross items are best-effort */
      if (!alive) return;
      setCrossItems((prev) => {
        const next = new Map(prev);
        next.set(secondary!, []);
        return next;
      });
    });
    return () => { alive = false; };
  }, [top.kind === "items" ? top.ledger : null, client, crossItems]);

  // Live updates. REMOTE (liveUrl): connect to the server's /ws, refetch the
  // current frame on a pushed change, expose health to the status bar. EMBEDDED
  // (onSubscribe, no WS): wire the in-process file watcher to the same refresh.
  useEffect(() => {
    if (liveUrl !== null) {
      const mgr = new LiveManager({
        url: liveUrl,
        ...(liveWsCtor !== undefined ? { WebSocketCtor: liveWsCtor } : {}),
        onChanged: () => refreshRef.current(),
        onUpdate: (s) => setLive(s),
      });
      mgr.start();
      return () => {
        mgr.destroy();
        setLive(null);
      };
    }
    if (onSubscribe !== null) {
      const dispose = onSubscribe(() => refreshRef.current());
      return () => {
        dispose();
      };
    }
    return undefined;
  }, [liveUrl, liveWsCtor, onSubscribe]);

  // ---- mutations (called from overlays) ----------------------------------
  const isMilestonesLedger = top.kind === "items" && top.ledger === MILESTONES;

  const applyStatus = useCallback(
    async (row: Row, status: string) => {
      if (top.kind !== "items") return;
      try {
        if (isMilestonesLedger) await client.updateMilestone(row.item.id, { status });
        else await client.updateItem(top.ledger, row.item.id, { status, author: UI_AUTHOR });
        setFlash(`${row.item.id} → ${status}`);
        await reloadItems();
      } catch (e) {
        setFlash(errMsg(e));
      }
      setOverlay(null);
    },
    [client, top, isMilestonesLedger, reloadItems],
  );

  // Questions "answer & resolve": write the `answer` field AND transition to
  // `answered` in one update (the transition guard permits open → answered).
  const applyAnswer = useCallback(
    async (row: Row, answer: string) => {
      if (top.kind !== "items") return;
      try {
        await client.updateItem(top.ledger, row.item.id, {
          status: ANSWERED_STATUS,
          fields: { [ANSWER_FIELD]: answer },
          author: UI_AUTHOR,
        });
        setFlash(`${row.item.id} answered`);
        await reloadItems();
      } catch (e) {
        setFlash(errMsg(e));
      }
      setOverlay(null);
    },
    [client, top, reloadItems],
  );

  // Batch-answer (T64): open the full-screen stepper. Use the current frame's
  // ledger when it carries open answerable items; otherwise fall back to the
  // questions ledger (fetched on demand). Entering the overlay does not change
  // the navigation stack — Esc leaves the user where they were.
  const beginBatchAnswer = useCallback(async () => {
    if (top.kind !== "items") return;
    try {
      let ledger = top.ledger;
      let view = top.view;
      if (answerableRows(view).length === 0 && ledger !== QUESTIONS_LEDGER) {
        ledger = QUESTIONS_LEDGER;
        view = await client.fetchLedger(ledger);
      }
      const rows = answerableRows(view);
      if (rows.length === 0) {
        setFlash("no open answerable items");
        return;
      }
      setOverlay({ t: "batchAnswer", ledger, rows, idx: 0 });
    } catch (e) {
      setFlash(errMsg(e));
    }
  }, [client, top]);

  // Save one batch answer, then re-derive the still-open set and advance. The
  // answered item drops out of `answerableRows`, so the next open item slides
  // into the same index; when none remain the overlay closes.
  const applyBatchAnswer = useCallback(
    async (overlay: Extract<Overlay, { t: "batchAnswer" }>, row: Row, answer: string) => {
      try {
        await client.updateItem(overlay.ledger, row.item.id, {
          status: ANSWERED_STATUS,
          fields: { [ANSWER_FIELD]: answer },
          author: UI_AUTHOR,
        });
        setFlash(`${row.item.id} answered`);
        // Refetch the batch ledger to recompute the open set. Keep the visible
        // frame in sync when it shows the same ledger.
        const view = await client.fetchLedger(overlay.ledger);
        if (top.kind === "items" && top.ledger === overlay.ledger) patchTop({ view });
        const rows = answerableRows(view);
        if (rows.length === 0) {
          setOverlay(null);
          return;
        }
        setOverlay({ ...overlay, rows, idx: Math.min(overlay.idx, rows.length - 1) });
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client, top, patchTop],
  );

  const applyField = useCallback(
    async (row: Row, field: string, raw: string) => {
      if (top.kind !== "items") return;
      try {
        const spec = top.view.schema.fields[field];
        await client.updateItem(top.ledger, row.item.id, {
          fields: { [field]: parseFieldValue(raw, spec?.type ?? "string") },
          author: UI_AUTHOR,
        });
        setFlash(`${row.item.id}.${field} updated`);
        await reloadItems();
      } catch (e) {
        setFlash(errMsg(e));
      }
      setOverlay(null);
    },
    [client, top, reloadItems],
  );

  const applyTitle = useCallback(
    async (row: Row, title: string) => {
      try {
        await client.updateMilestone(row.item.id, { title });
        setFlash(`${row.item.id} title updated`);
        await reloadItems();
      } catch (e) {
        setFlash(errMsg(e));
      }
      setOverlay(null);
    },
    [client, reloadItems],
  );

  const beginCreate = useCallback(async () => {
    if (top.kind !== "items") return;
    if (isMilestonesLedger) {
      setOverlay({ t: "createMilestone" });
      return;
    }
    try {
      const ms = await client.fetchLedger(MILESTONES);
      setOverlay({ t: "createItem", milestones: ms.milestones.flatMap((g) => g.items) });
    } catch (e) {
      setFlash(errMsg(e));
    }
  }, [client, top, isMilestonesLedger]);

  /**
   * Toggle the archive section for the current ledger. On first activation,
   * lazily fetches all archive pointers and assembles rows. On deactivation,
   * clears the rows and resets the cursor to stay within active items.
   */
  const toggleArchive = useCallback(async () => {
    if (top.kind !== "items") return;
    if (top.showArchive) {
      // Turn off: hide the archive section and reset cursor to active items.
      const activeCount = visibleRows(top.view).length;
      patchTop({
        showArchive: false,
        archiveRows: [],
        archiveLoading: false,
        cursor: Math.min(top.cursor, Math.max(0, activeCount - 1)),
      });
      return;
    }
    // Turn on: fetch all archive pointers concurrently.
    const ptrs = top.view.archivePointers;
    if (ptrs.length === 0) {
      patchTop({ showArchive: true, archiveRows: [], archiveLoading: false });
      setFlash("no archived milestones");
      return;
    }
    patchTop({ showArchive: true, archiveRows: [], archiveLoading: true });
    try {
      const archives = await Promise.all(ptrs.map((p) => client.fetchLedgerArchive(top.ledger, p.id)));
      const rows: Row[] = [];
      for (const arc of archives) {
        if (arc.kind === "group") {
          for (const item of arc.milestone.items) {
            rows.push({ item, milestoneId: arc.milestone.id });
          }
        } else {
          // kind === "item": milestones ledger archive — the item is the milestone.
          rows.push({ item: arc.item, milestoneId: "archived" });
        }
      }
      patchTop({ archiveRows: rows, archiveLoading: false });
    } catch (e) {
      setFlash(errMsg(e));
      patchTop({ showArchive: false, archiveRows: [], archiveLoading: false });
    }
  }, [client, top, patchTop, visibleRows]);

  // The live-search overlay drives this directly as the user types.
  const search = useCallback((query: string) => client.ftsSearch(query), [client]);

  const openHit = useCallback(
    async (hit: FtsHit) => {
      try {
        const view = await client.fetchLedger(hit.ledgerId);
        const rs = ledgerRows(view);
        const idx = Math.max(0, rs.findIndex((r) => r.item.id === hit.item.id));
        // Replace the stack: a fresh ledgers root, then push the hit's ledger.
        setStack([
          { kind: "ledgers", cursor: Math.max(0, ledgers.findIndex((l) => l.name === hit.ledgerId)) },
          { kind: "items", ledger: hit.ledgerId, view, cursor: idx, focus: "list", scroll: 0, showArchive: false, archiveRows: [], archiveLoading: false },
        ]);
        // The hit's row index is into the unfiltered list — clear any filter so
        // the cursor lands on the right row.
        setFilter({ kind: "all" });
        setOverlay(null);
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client, ledgers],
  );

  // ---- memoized items-frame derivations (T85) ----------------------------
  // The O(N) list derivations recompute ONLY when their data inputs change
  // (view/filter/showArchive/archiveRows/ledger/column selection), NOT on a
  // pure cursor move. Both the input handler and the render body read this
  // bundle, so navigation does zero O(N) work. When the top frame is the
  // ledgers list this is null (the items render path is inactive).
  const itemsView = top.kind === "items" ? top.view : null;
  const itemsLedger = top.kind === "items" ? top.ledger : null;
  const itemsShowArchive = top.kind === "items" ? top.showArchive : false;
  const itemsArchiveRows = top.kind === "items" ? top.archiveRows : EMPTY_ROWS;
  // The effective extra-column selection, restricted to schema-eligible fields.
  const itemsColumnsKey =
    itemsLedger !== null ? columnsFor(itemsLedger).join("|") : "";
  const itemsDerived = useMemo<ItemsDerived | null>(() => {
    if (itemsView === null || itemsLedger === null) return null;
    const schema = itemsView.schema;
    const activeRows = filterVisibleRows(itemsView, filter);
    const allRows = itemsShowArchive ? [...activeRows, ...itemsArchiveRows] : activeRows;
    const extraColumns = columnsFor(itemsLedger).filter((c) =>
      eligibleColumnFields(schema).includes(c),
    );
    const layout = computeColumnLayout(allRows, schema, extraColumns);
    // Goals (T84 / Q48) and the milestones ledger render flat (no subsection
    // headers); buildItemEntries takes MILESTONES_SCHEMA (T81 colored header).
    const flatList = itemsLedger === MILESTONES || itemsLedger === GOALS_LEDGER;
    const activeEntries = buildItemEntries(itemsView, activeRows, flatList, MILESTONES_SCHEMA);
    return { activeRows, allRows, extraColumns, layout, activeEntries };
    // `columnsFor` is read inside; its content is captured by `itemsColumnsKey`
    // (the joined per-ledger selection), so the key — not the callback identity
    // — drives recomputation. A pure cursor move changes none of these inputs.
  }, [itemsView, itemsLedger, filter, itemsShowArchive, itemsArchiveRows, itemsColumnsKey]);

  // ---- input -------------------------------------------------------------
  useInput(
    (input, key) => {
      if (overlay !== null) return; // overlay components own input while open
      // Global layout controls (both views): toggle orientation, resize panes.
      if (input === "o") {
        setPanel((p) => ({ ...p, orientation: p.orientation === "right" ? "bottom" : "right" }));
        return;
      }
      if (input === "[") {
        setPanel((p) => ({ ...p, ratio: clampRatio(p.ratio - PANEL_STEP) }));
        return;
      }
      if (input === "]") {
        setPanel((p) => ({ ...p, ratio: clampRatio(p.ratio + PANEL_STEP) }));
        return;
      }
      if (top.kind === "ledgers") {
        if (key.upArrow || input === "k") patchTop({ cursor: Math.max(0, top.cursor - 1) });
        else if (key.downArrow || input === "j")
          patchTop({ cursor: Math.min(ledgers.length - 1, top.cursor + 1) });
        else if (key.return) {
          const sel = ledgers[top.cursor];
          if (sel !== undefined) void openLedger(sel.name);
        } else if (input === "/") setOverlay({ t: "search" });
        else if (input === "q") exit();
        return;
      }
      // items frame — read the memoized derivations (no O(N) work per key).
      if (itemsDerived === null) return;
      const activeCount = itemsDerived.activeRows.length;
      const allRows = itemsDerived.allRows;
      const totalRows = allRows.length;
      const cur = allRows[top.cursor];
      // Whether the cursor currently points at an archived row (read-only).
      const cursorInArchive = top.showArchive && top.cursor >= activeCount;
      if (top.focus === "content") {
        const clampScroll = (s: number): number => Math.max(0, Math.min(s, contentMaxScroll.current));
        if (key.upArrow || input === "k") patchTop({ scroll: clampScroll(top.scroll - 1) });
        else if (key.downArrow || input === "j") patchTop({ scroll: clampScroll(top.scroll + 1) });
        else if (key.pageUp) patchTop({ scroll: clampScroll(top.scroll - CONTENT_PAGE) });
        else if (key.pageDown) patchTop({ scroll: clampScroll(top.scroll + CONTENT_PAGE) });
        else if (key.escape) patchTop({ focus: "list", scroll: 0 });
        // Edit/transition/answer keys are inert for archived items.
        else if (input === "s" && cur && !cursorInArchive) setOverlay({ t: "status", row: cur });
        else if (input === "a" && cur && !cursorInArchive && canAnswer(top.view.schema, cur.item.status))
          setOverlay({ t: "answer", row: cur });
        else if (
          input === "r" &&
          cur &&
          !cursorInArchive &&
          canAnswer(top.view.schema, cur.item.status) &&
          !hasPersistedAnswer(cur.item) &&
          hasRecommendation(cur.item)
        )
          void applyAnswer(cur, AS_RECOMMENDED_ANSWER);
        else if (
          /^[1-9]$/.test(input) &&
          cur &&
          !cursorInArchive &&
          canAnswer(top.view.schema, cur.item.status) &&
          !hasPersistedAnswer(cur.item)
        ) {
          const n = parseInt(input, 10);
          const sugs = getSuggestions(cur.item);
          if (n <= sugs.length) void applyAnswer(cur, sugs[n - 1]!);
        } else if (input === "e" && cur && !cursorInArchive)
          setOverlay(isMilestonesLedger ? { t: "editTitle", row: cur } : { t: "pickField", row: cur });
        return;
      }
      // focus === list. ↑↓ move the cursor (resetting the detail scroll to the
      // top of the newly-selected item); PageUp/PageDown scroll the detail pane
      // in place WITHOUT switching focus, so the detail is scrollable without the
      // Enter-to-focus step; Enter focuses the pane for ↑↓ line scrolling.
      if (key.upArrow || input === "k") patchTop({ cursor: Math.max(0, top.cursor - 1), scroll: 0 });
      else if (key.downArrow || input === "j")
        patchTop({ cursor: Math.min(totalRows - 1, top.cursor + 1), scroll: 0 });
      else if (key.pageUp) patchTop({ scroll: Math.max(0, top.scroll - CONTENT_PAGE) });
      else if (key.pageDown)
        patchTop({ scroll: Math.min(contentMaxScroll.current, top.scroll + CONTENT_PAGE) });
      else if (key.return) {
        if (cur) patchTop({ focus: "content", scroll: 0 });
      } else if (key.escape) setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
      // Edit/transition/answer/create keys are inert for archived items.
      else if (input === "n" && !cursorInArchive) void beginCreate();
      else if (input === "s" && cur && !cursorInArchive) setOverlay({ t: "status", row: cur });
      else if (input === "a" && cur && !cursorInArchive && canAnswer(top.view.schema, cur.item.status))
        setOverlay({ t: "answer", row: cur });
      else if (
        input === "r" &&
        cur &&
        !cursorInArchive &&
        canAnswer(top.view.schema, cur.item.status) &&
        !hasPersistedAnswer(cur.item) &&
        hasRecommendation(cur.item)
      )
        void applyAnswer(cur, AS_RECOMMENDED_ANSWER);
      else if (
        /^[1-9]$/.test(input) &&
        cur &&
        !cursorInArchive &&
        canAnswer(top.view.schema, cur.item.status) &&
        !hasPersistedAnswer(cur.item)
      ) {
        const n = parseInt(input, 10);
        const sugs = getSuggestions(cur.item);
        if (n <= sugs.length) void applyAnswer(cur, sugs[n - 1]!);
      } else if (input === "e" && cur && !cursorInArchive)
        setOverlay(isMilestonesLedger ? { t: "editTitle", row: cur } : { t: "pickField", row: cur });
      else if (input === "b") void beginBatchAnswer();
      else if (input === "f") setOverlay({ t: "filter" });
      else if (input === "c") setOverlay({ t: "pickColumns", ledger: top.ledger });
      else if (input === "/") setOverlay({ t: "search" });
      else if (input === "A") void toggleArchive();
    },
    { isActive: true },
  );

  // ---- derived for render ------------------------------------------------
  // Chrome is a 1-row path header + a fixed 2-row status bar (STATUS_ROWS).
  // Reserving an exact, constant footer height keeps `contentInnerH` matched to
  // the actual content-pane area regardless of how the hint text wraps — a
  // miscount makes the content box overflow its pane and ink clips the top row
  // (dropping the detail header).
  const bodyRows = Math.max(3, rows - 1 - STATUS_ROWS);
  // Pane sizing from the panel layout. Each pane has a 1-char round border on
  // every side (-2) and the content pane adds paddingX={1} (-2 more on width).
  const horizontal = panel.orientation === "right";
  const listOuterW = horizontal ? Math.max(16, Math.round(cols * panel.ratio)) : cols;
  const listOuterH = horizontal ? bodyRows : Math.max(3, Math.round(bodyRows * panel.ratio));
  const listInnerH = Math.max(1, listOuterH - 2);
  const contentInnerH = Math.max(1, (horizontal ? bodyRows : bodyRows - listOuterH) - 2);
  const contentInnerW = Math.max(20, (horizontal ? cols - listOuterW : cols) - 4);

  let pathStr: string;
  let hints: string;
  let listEl: React.ReactElement;
  let contentEl: React.ReactElement;

  if (top.kind === "ledgers") {
    pathStr = "all ledgers";
    hints = "↑↓ move · Enter open · / search · o/[ ] panes · q quit";
    // Right-align the per-ledger item count: pad the name out to fill the row
    // (less the cursor prefix and a scrollbar column when one is shown).
    const showBar = ledgers.length > listInnerH;
    const labelW = Math.max(8, listOuterW - 4 - 2 - (showBar ? 1 : 0));
    listEl = (
      <ScrollList
        items={ledgers}
        getLabel={(l) => l.name}
        renderLabel={(l) => {
          const count = String(l.itemCount);
          const pad = Math.max(1, labelW - l.name.length - count.length);
          return (
            <Text>
              {l.name}
              {" ".repeat(pad)}
              <Text dimColor>{count}</Text>
            </Text>
          );
        }}
        cursor={top.cursor}
        height={listInnerH}
        active={overlay === null}
      />
    );
    const sel = ledgers[top.cursor];
    contentEl = (
      <Box flexDirection="column">
        <Text bold color="green">
          {sel?.name ?? ""}
        </Text>
        <Text dimColor>Press Enter to open this ledger.</Text>
      </Box>
    );
  } else {
    // All O(N) list derivations come from the memoized bundle (T85): a pure
    // cursor move does NOT recompute them. itemsDerived is non-null here.
    const derived = itemsDerived!;
    const rowsArr = derived.activeRows;
    const activeCount = rowsArr.length;
    const allRows = derived.allRows;
    const cur = allRows[top.cursor];
    const cursorInArchive = top.showArchive && top.cursor >= activeCount;
    const schema = top.view.schema;
    const fLabel = filterLabel(filter);
    pathStr =
      cur !== undefined
        ? cursorInArchive
          ? `${top.ledger} → [archived] → ${cur.item.id}`
          : `${top.ledger} → ${cur.milestoneId} → ${cur.item.id}`
        : top.ledger;
    if (fLabel.length > 0) pathStr += `  [${fLabel}]`;
    const answerable = cur !== undefined && !cursorInArchive && canAnswer(schema, cur.item.status);
    const answered = answerable && hasPersistedAnswer(cur!.item);
    const curSuggestions = answerable && !answered ? getSuggestions(cur!.item) : [];
    const suggestionsHint = curSuggestions.length > 0 ? ` · 1-9 pick suggestion` : "";
    const answerHint = answerable
      ? ` · a answer${!answered && hasRecommendation(cur!.item) ? " · r as-recommended" : ""}${suggestionsHint}`
      : "";
    const archiveHint = top.view.archivePointers.length > 0
      ? ` · A ${top.showArchive ? "hide" : "show"} archived`
      : "";
    hints =
      top.focus === "content"
        ? `↑↓/PgUp/Dn scroll · s status${answerHint} · e edit · o/[ ] panes · Esc back to list${cursorInArchive ? " [read-only]" : ""}`
        : `↑↓ move · PgUp/Dn scroll detail · Enter focus · s status${answerHint} · e edit · n new · b batch-answer · f filter · c columns · / search · o/[ ] panes${archiveHint} · Esc back`;
    // Column widths (T62) computed over all displayed rows, and the active
    // list entries — both from the memoized bundle (see ItemsDerived). The
    // archive section header + rows are appended cheaply below.
    const { maxIdW, maxStatusW, columnWidths } = derived.layout;
    const extraColumns = derived.extraColumns;
    const activeEntries = derived.activeEntries;
    let itemEntries: ListEntry<Row>[];
    if (top.showArchive) {
      const archiveEntries: ListEntry<Row>[] = top.archiveLoading
        ? [{ t: "header", label: "── archived (loading…) ──" }]
        : top.archiveRows.length === 0
          ? [{ t: "header", label: "── archived (none) ──" }]
          : [
              { t: "header", label: "── archived ──" },
              ...top.archiveRows.map(
                (r, i): ListEntry<Row> => ({ t: "item", item: r, itemIdx: activeCount + i }),
              ),
            ];
      itemEntries = [...activeEntries, ...archiveEntries];
    } else {
      itemEntries = activeEntries;
    }
    listEl = (
      <ScrollList
        items={allRows}
        entries={itemEntries}
        getLabel={(r) => {
          const cells = extraColumns
            .map((f, ci) => fieldToString(r.item.fields[f]).padEnd(columnWidths[ci]!))
            .join(" ");
          const extra = cells.length > 0 ? `${cells} ` : "";
          return `${r.item.id.padEnd(maxIdW)} ${r.item.status.padEnd(maxStatusW)} ${extra}${summarize(r.item)}`;
        }}
        renderLabel={(r, idx) => (
          <ItemRowLabel
            id={r.item.id}
            status={r.item.status}
            summary={summarize(r.item)}
            schema={schema}
            idW={maxIdW}
            statusW={maxStatusW}
            extraColumns={extraColumns}
            columnWidths={columnWidths}
            fields={r.item.fields}
            dimmed={top.showArchive && idx >= activeCount}
          />
        )}
        cursor={top.cursor}
        height={listInnerH}
        active={overlay === null && top.focus === "list"}
        emptyLabel={filter.kind === "all" ? "(no items — press n)" : "(no items match filter — f)"}
      />
    );
    // Flat list of all items in the current view (for relationship resolution).
    const viewItems = allRows.map((r) => r.item);
    // Cross-ledger items for secondary relationship lookups.
    const taskItems = crossItems.get(TASKS_LEDGER) ?? [];
    contentEl =
      cur !== undefined ? (
        <ContentPane
          row={cur}
          ledger={top.ledger}
          schema={schema}
          width={contentInnerW}
          height={contentInnerH}
          scroll={top.scroll}
          readOnly={cursorInArchive}
          viewItems={viewItems}
          taskItems={taskItems}
          maxScrollRef={contentMaxScroll}
        />
      ) : (
        <Text dimColor>(no item selected)</Text>
      );
  }

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* header */}
      <Box>
        <Text bold color="cyan">
          {headerTitle}
        </Text>
        <Text dimColor>
          {"  "}
          {conn === "connected" ? "● " : conn === "connecting" ? "○ " : "✕ "}
          {conn === "error" ? `error: ${connErr}` : pathStr}
        </Text>
        {liveUrl !== null && <LiveBadge stats={live} />}
        {liveUrl === null && onSubscribe !== null && (
          <Text dimColor>{"  ◆ in-process"}</Text>
        )}
      </Box>

      {/* body: a full-screen overlay (batch-answer) takes the whole body when
          active; otherwise the usual list | content split. */}
      {overlay !== null && overlay.t === "batchAnswer" ? (
        <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <BatchAnswerOverlay
            overlay={overlay}
            width={cols - 4}
            onAnswer={(row, answer) => void applyBatchAnswer(overlay, row, answer)}
            onNav={(idx) => setOverlay({ ...overlay, idx })}
            onCancel={() => setOverlay(null)}
          />
        </Box>
      ) : (
      <Box flexGrow={1} minHeight={0} flexDirection={horizontal ? "row" : "column"}>
        <Box
          {...(horizontal ? { width: listOuterW } : { height: listOuterH })}
          flexShrink={0}
          minHeight={0}
          overflow="hidden"
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          {listEl}
        </Box>
        <Box flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden" flexDirection="column" borderStyle="round" borderColor={top.kind === "items" && top.focus === "content" ? "cyan" : "gray"} paddingX={1}>
          {overlay !== null ? (
            <Overlays
              overlay={overlay}
              view={top.kind === "items" ? top.view : null}
              onStatus={applyStatus}
              onAnswer={applyAnswer}
              onField={applyField}
              onTitle={applyTitle}
              search={search}
              onOpenHit={openHit}
              onCreateMilestone={async (title) => {
                try {
                  const m = await client.createMilestone({ title });
                  setFlash(`created ${m.id}`);
                  await reloadItems();
                } catch (e) {
                  setFlash(errMsg(e));
                }
                setOverlay(null);
              }}
              onCreateItem={async (milestoneId, status, fields) => {
                if (top.kind !== "items") return;
                try {
                  const it = await client.createItem(top.ledger, milestoneId, {
                    status,
                    fields,
                    author: UI_AUTHOR,
                  });
                  setFlash(`created ${it.id}`);
                  await reloadItems();
                } catch (e) {
                  setFlash(errMsg(e));
                }
                setOverlay(null);
              }}
              onFilter={(f) => {
                setFilter(f);
                patchTop({ cursor: 0 });
                setOverlay(null);
              }}
              columnsFor={columnsFor}
              onColumns={(ledger, cols) => {
                setColumnsFor(ledger, cols);
                setOverlay(null);
              }}
              setOverlay={setOverlay}
              onCancel={() => setOverlay(null)}
            />
          ) : (
            contentEl
          )}
        </Box>
      </Box>
      )}

      {/* status bar — pinned to exactly STATUS_ROWS rows so bodyRows accounting
          stays exact. The hint text may wrap within these rows; height-bounding
          the box keeps the footer from stealing a row from the content pane. */}
      <Box height={STATUS_ROWS} flexShrink={0}>
        <Text>
          {flash.length > 0 ? <Text color="yellow">{flash}  </Text> : null}
          <Text dimColor>{hints}</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Scrollable list with a scrollbar column
// ---------------------------------------------------------------------------

/** Connection-health badge for the live channel (derived; truthful labels). */
function LiveBadge({ stats }: { stats: LiveStats | null }): React.ReactElement {
  const state = stats?.state ?? "connecting";
  const map: Record<string, { glyph: string; text: string; color: string }> = {
    alive: { glyph: "●", text: "live", color: "green" },
    connecting: { glyph: "○", text: "live…", color: "yellow" },
    stale: { glyph: "◐", text: "stale", color: "yellow" },
    dead: { glyph: "↻", text: "reconnecting", color: "yellow" },
    terminal: { glyph: "✕", text: "offline", color: "red" },
  };
  const v = map[state] ?? map["connecting"]!;
  return (
    <Text color={v.color}>
      {"  "}
      {v.glyph} {v.text}
    </Text>
  );
}

/**
 * One item row rendered as aligned columns: id (padded to idW) | status
 * (padded to statusW) | extra columns (each padded to its column width) |
 * summary (fills remaining width, truncates at end). The whole row is dimmed
 * when the item is terminal.
 */
function ItemRowLabel({
  id,
  status,
  summary,
  schema,
  idW,
  statusW,
  extraColumns = [],
  columnWidths = [],
  fields = {},
  dimmed = false,
}: {
  id: string;
  status: string;
  summary: string;
  schema: LedgerSchema;
  /** Width of the id column (chars), padded with spaces on the right. */
  idW: number;
  /** Width of the status column (chars), padded with spaces on the right. */
  statusW: number;
  /** Extra column field names rendered after status, before summary (T62). */
  extraColumns?: readonly string[];
  /** Per-extra-column widths, index-aligned with `extraColumns`. */
  columnWidths?: readonly number[];
  /** The item's fields, used to read extra-column cell values. */
  fields?: Record<string, FieldValue>;
  /** Extra dimming applied to archived rows. */
  dimmed?: boolean;
}): React.ReactElement {
  const terminal = isTerminal(status, schema);
  const color = statusColor(status, schema);
  const idPadded = id.padEnd(idW);
  const statusPadded = status.padEnd(statusW);
  return (
    <Text dimColor={terminal || dimmed}>
      {idPadded}{" "}<Text color={color}>{statusPadded}</Text>{" "}
      {extraColumns.map((field, ci) => (
        <React.Fragment key={field}>
          <Text dimColor>{fieldToString(fields[field]).padEnd(columnWidths[ci] ?? 0)}</Text>{" "}
        </React.Fragment>
      ))}
      {summary}
    </Text>
  );
}

function ScrollList<T>({
  items,
  entries: entriesProp,
  getLabel,
  renderLabel,
  cursor,
  height,
  active,
  emptyLabel = "(empty)",
}: {
  items: readonly T[];
  /**
   * When provided, overrides the flat `items` list with a pre-built entries
   * array that may include non-selectable section headers. The `cursor` still
   * indexes into item entries only (i.e. entries with `t === "item"`).
   */
  entries?: readonly ListEntry<T>[];
  getLabel: (item: T, index: number) => string;
  /** Optional rich (colored) label; falls back to getLabel's plain string. */
  renderLabel?: (item: T, index: number) => React.ReactNode;
  cursor: number;
  height: number;
  active: boolean;
  emptyLabel?: string;
}): React.ReactElement {
  // Build a flat entries array when none is provided (backward-compat path).
  const entries: readonly ListEntry<T>[] =
    entriesProp !== undefined
      ? entriesProp
      : items.map((item, i) => ({ t: "item" as const, item, itemIdx: i }));

  const itemCount = entries.filter((e) => e.t === "item").length;
  if (itemCount === 0) return <Text dimColor>{emptyLabel}</Text>;

  const totalEntries = entries.length;
  const h = Math.max(1, height);

  // Find the visual index of the selected item within entries
  const cursorVisIdx = entries.findIndex((e) => e.t === "item" && e.itemIdx === cursor);
  const selVisIdx = cursorVisIdx >= 0 ? cursorVisIdx : 0;

  // Compute topVisIdx: the first visible entry index in the viewport.
  // We want the selected item to stay in view; ensure the viewport includes
  // selVisIdx. We also keep enough room for a header above the selected item.
  let topVisIdx = 0;
  if (selVisIdx >= h) {
    // Push viewport so that the selected item is the last visible row.
    topVisIdx = Math.min(selVisIdx - h + 1, Math.max(0, totalEntries - h));
  }
  // If the row just above a selected item is a header, try to include it.
  if (topVisIdx > 0 && entries[topVisIdx]?.t === "header") {
    topVisIdx = Math.max(0, topVisIdx - 1);
  }
  topVisIdx = Math.max(0, Math.min(topVisIdx, Math.max(0, totalEntries - h)));

  const win = entries.slice(topVisIdx, topVisIdx + h);

  // scrollbar thumb — based on item count position for stability
  const showBar = totalEntries > h;
  const thumbSize = showBar ? Math.max(1, Math.round((h / totalEntries) * h)) : 0;
  const maxTop = Math.max(1, totalEntries - h);
  const thumbStart = showBar
    ? Math.min(h - thumbSize, Math.round((topVisIdx / maxTop) * (h - thumbSize)))
    : 0;

  return (
    <Box flexDirection="row">
      <Box flexDirection="column" flexGrow={1}>
        {win.map((entry, idx) => {
          const visI = topVisIdx + idx;
          if (entry.t === "header") {
            return (
              <Text key={`h-${visI}`} bold dimColor wrap="truncate-end">
                {"  "}
                {entry.node !== undefined ? entry.node : entry.label}
              </Text>
            );
          }
          const sel = entry.itemIdx === cursor;
          return (
            <Text key={`i-${entry.itemIdx}`} inverse={sel && active} {...(sel && !active ? { color: "cyan" as const } : {})} wrap="truncate-end">
              {sel ? "› " : "  "}
              {renderLabel !== undefined ? renderLabel(entry.item, entry.itemIdx) : getLabel(entry.item, entry.itemIdx)}
            </Text>
          );
        })}
      </Box>
      {showBar && (
        <Box flexDirection="column">
          {Array.from({ length: win.length }, (_, idx) => {
            const inThumb = idx >= thumbStart && idx < thumbStart + thumbSize;
            return (
              <Text key={idx} dimColor>
                {inThumb ? "█" : "░"}
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Content pane: item detail with markdown-rendered fields + line scroll
// ---------------------------------------------------------------------------

function ContentPane({
  row,
  ledger,
  schema,
  width,
  height,
  scroll,
  readOnly = false,
  viewItems = [],
  taskItems = [],
  maxScrollRef,
}: {
  row: Row;
  ledger: string;
  schema: LedgerSchema;
  width: number;
  height: number;
  scroll: number;
  /** When true, display a read-only badge (archived item). */
  readOnly?: boolean;
  /** Published with this item's max scroll offset each render (for key clamping). */
  maxScrollRef?: React.MutableRefObject<number>;
  /**
   * All items currently loaded in the view (used for relationship resolution).
   * For the hypothesis ledger: all hypothesis items for ancestry/children.
   * For the defects ledger: all defect items for forward fix-task links.
   */
  viewItems?: readonly Item[];
  /**
   * Items from the tasks ledger (lazily fetched); used for defect → fix-task
   * reverse-link resolution.
   */
  taskItems?: readonly Item[];
}): React.ReactElement {
  const f = row.item.fields;
  const question = isQuestion(schema);
  // Goals (T84 / Q48): a goal's coordination-milestone (row.milestoneId) is not
  // shown; instead its work-milestone ids (fields.milestones) are listed in the
  // leading metadata. The `milestones` field is therefore lifted out of the
  // generic field list so it is not rendered twice.
  const isGoal = ledger === GOALS_LEDGER;
  const goalMilestones = isGoal
    ? (() => {
        const v = f[GOAL_MILESTONES_FIELD];
        return Array.isArray(v) ? v : [];
      })()
    : [];
  const allEntries = (Object.entries(f) as Array<[string, FieldValue]>).filter(
    ([k]) => !(isGoal && k === GOAL_MILESTONES_FIELD),
  );
  // Questions (T23/T59): metadata/short fields first, then the fixed narrative
  // order question → context → suggestions → recommendation (highlighted) →
  // answer. Otherwise the generic short-first order.
  const entries = question
    ? [
        ...orderItemFields(allEntries.filter(([k]) => !QUESTION_FIELD_ORDER.includes(k))),
        ...QUESTION_FIELD_ORDER.filter((k) => f[k] !== undefined).map(
          (k) => [k, f[k]!] as [string, FieldValue],
        ),
      ]
    : orderItemFields(allEntries);
  const { author, session } = row.item;
  const hasProvenance = author !== undefined || session !== undefined;

  // Relationship blocks (T48): defects → fix tasks; hypothesis → ancestry + children.
  const isDefect = ledger === DEFECTS_LEDGER;
  const isHypothesis = ledger === HYPOTHESIS_LEDGER;
  const fixTaskIds = isDefect ? defectFixTaskIds(row.item.id, viewItems, taskItems) : [];
  const hypoRels = isHypothesis ? hypothesisRelationships(row.item.id, viewItems) : null;

  // Helper: find an item by id across viewItems and taskItems.
  const findItem = (id: string): Item | undefined =>
    (viewItems as Item[]).find((i) => i.id === id) ??
    (taskItems as Item[]).find((i) => i.id === id);

  // Build the detail as a FLAT list of one-row elements, then render only the
  // visible [scroll, scroll+height] slice. Windowing keeps each render cheap —
  // ink only measures the on-screen rows, not the full (possibly multi-KB) text
  // of every field, which is the dominant per-cursor-move cost (D13).
  const lines: React.ReactElement[] = [];
  let lk = 0;
  // Every line MUST render as exactly ONE terminal row: ink's overflow="hidden"
  // on the bounded content box clips the TOP rows when total rows exceed the
  // height, so a single wrapped (2-row) line would push the header/metadata off
  // the top. `wrap="truncate"` guarantees one row per line. markdownLines is
  // already pre-wrapped to `width`, so this only bites un-wrapped metadata.
  const push = (
    node: React.ReactNode,
    props: { bold?: boolean; color?: string; dimColor?: boolean } = {},
  ): void => {
    lines.push(
      <Text key={`dl-${lk++}`} wrap="truncate" {...props}>
        {node}
      </Text>,
    );
  };
  const pushBlank = (): void => push(" ");
  const byLine = (): string =>
    `by ${author ?? "?"}${session !== undefined ? ` · session ${session}` : ""}`;

  // Header: id @ ledger [status] [read-only]. Emitted as a direct <Text> (not
  // via push): a push-wrapped Fragment with nested Fragments/conditionals
  // rendered empty inside the bounded/overflow content box.
  lines.push(
    <Text key={`dl-${lk++}`} wrap="truncate">
      <Text bold>{row.item.id}</Text>
      <Text dimColor> @ {ledger}</Text>
      {!question ? (
        <>
          {"  "}
          <Text color={statusColor(row.item.status, schema)}>{row.item.status}</Text>
        </>
      ) : null}
      {readOnly ? <Text dimColor> [archived · read-only]</Text> : null}
    </Text>,
  );

  // Leading metadata (question / goal / generic variants).
  if (question) {
    push(`milestone ${row.milestoneId}`, { dimColor: true });
    push(
      <>
        status <Text color={statusColor(row.item.status, schema)}>{row.item.status}</Text>
      </>,
      { dimColor: true },
    );
    push(byLine(), { dimColor: true });
  } else if (isGoal) {
    push(
      `created ${row.item.createdAt.slice(0, 10)} · updated ${row.item.updatedAt.slice(0, 10)}`,
      { dimColor: true },
    );
    push(
      <>
        <Text bold color="gray">milestones: </Text>
        {goalMilestones.length > 0 ? goalMilestones.join(", ") : <Text dimColor>(none)</Text>}
      </>,
    );
    if (hasProvenance) push(byLine(), { dimColor: true });
  } else {
    push(
      `milestone ${row.milestoneId} · created ${row.item.createdAt.slice(0, 10)} · updated ${row.item.updatedAt.slice(0, 10)}`,
      { dimColor: true },
    );
    if (hasProvenance) push(byLine(), { dimColor: true });
  }

  // Fields.
  if (entries.length === 0) {
    push("(no fields)", { dimColor: true });
  } else {
    for (const [k, v] of entries) {
      if (k === RECOMMENDATION_FIELD) {
        pushBlank();
        push(k, { bold: true, color: "cyan" });
        if (Array.isArray(v)) push(v.join(", "));
        else for (const ln of markdownLines(v, width, `f-${k}`)) lines.push(ln);
      } else if (k === SUGGESTIONS_FIELD && Array.isArray(v)) {
        pushBlank();
        push(k, { bold: true, color: "gray" });
        for (const sg of v) push(`• ${sg}`);
      } else if (isShortField(v)) {
        push(
          <>
            <Text bold color="gray">
              {k}:{" "}
            </Text>
            {fieldToString(v)}
          </>,
        );
      } else {
        pushBlank();
        push(k, { bold: true, color: "gray" });
        if (Array.isArray(v)) push(v.join(", "));
        else for (const ln of markdownLines(v, width, `f-${k}`)) lines.push(ln);
      }
    }
  }

  // Relationship row helper (fix tasks / hypothesis tree).
  const relRow = (id: string): void => {
    const it = findItem(id);
    push(
      <>
        {"  "}
        <Text bold>{id}</Text>
        {it !== undefined ? (
          <>
            {" ["}
            <Text color={statusColor(it.status, schema)}>{it.status}</Text>
            {"] "}
            {summarize(it)}
          </>
        ) : null}
      </>,
    );
  };

  // Fix tasks block (defects).
  if (isDefect) {
    pushBlank();
    push("Fix tasks", { bold: true, color: "gray" });
    if (fixTaskIds.length === 0) push("  (none)", { dimColor: true });
    else for (const tid of fixTaskIds) relRow(tid);
  }

  // Hypothesis tree block: ancestry chain then direct children.
  if (
    isHypothesis &&
    hypoRels !== null &&
    (hypoRels.ancestors.length > 0 || hypoRels.children.length > 0)
  ) {
    if (hypoRels.ancestors.length > 0) {
      pushBlank();
      push("Ancestry", { bold: true, color: "gray" });
      for (const aid of hypoRels.ancestors) relRow(aid);
    }
    if (hypoRels.children.length > 0) {
      pushBlank();
      push("Children", { bold: true, color: "gray" });
      for (const cid of hypoRels.children) relRow(cid);
    }
  }

  const maxScroll = Math.max(0, lines.length - height);
  const clamped = Math.max(0, Math.min(scroll, maxScroll));
  // Publish for the key handler's scroll clamping (ref write, no re-render).
  if (maxScrollRef !== undefined) maxScrollRef.current = maxScroll;
  // Render the whole flat line list inside an inner box offset by `marginTop`,
  // clipped by the outer overflow box (the original, correct scroll/clip
  // structure). Slicing to exactly the window instead made ink's overflow drop
  // the TOP row at the fill boundary (the off-by-one header-clip bug). The lines
  // are flat single-row <Text> (markdownLines pre-wraps), so laying all of them
  // out stays cheap.
  const visible = lines.slice(clamped, clamped + height);
  // Scrollbar (mirrors ScrollList): a right-hand column showing the scroll
  // position when the detail is taller than the pane — the visible affordance
  // that the content is scrollable (focus the pane with Enter, then ↑↓/PgUp/Dn).
  const total = lines.length;
  const showBar = total > height;
  const thumbSize = showBar ? Math.max(1, Math.round((height / total) * height)) : 0;
  const maxTop = Math.max(1, total - height);
  const thumbStart = showBar
    ? Math.min(height - thumbSize, Math.round((clamped / maxTop) * (height - thumbSize)))
    : 0;
  return (
    <Box flexDirection="row" height={height}>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible}
      </Box>
      {showBar && (
        <Box flexDirection="column">
          {Array.from({ length: height }, (_, i) => (
            <Text key={i} dimColor>
              {i >= thumbStart && i < thumbStart + thumbSize ? "█" : "░"}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Live search — type to filter (debounced), ↑↓ to navigate, Enter to open.
// Accepts the filter query language (status:, ledger:, OR, …) verbatim; the
// server interprets it.
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 200;

function LiveSearch({
  search,
  onOpenHit,
  onCancel,
}: {
  search: (q: string) => Promise<FtsHit[]>;
  onOpenHit: (h: FtsHit) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FtsHit[]>([]);
  const [cursor, setCursor] = useState(0);

  // Debounced live query: re-run SEARCH_DEBOUNCE_MS after the last keystroke.
  // A `cancelled` guard drops a stale in-flight result that resolves late.
  useEffect(() => {
    if (query.trim().length === 0) {
      setHits([]);
      setCursor(0);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      search(query)
        .then((r) => {
          if (cancelled) return;
          setHits(r);
          setCursor(0);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query, search]);

  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(Math.max(0, hits.length - 1), c + 1));
    else if (key.return) {
      const hit = hits[cursor];
      if (hit !== undefined) onOpenHit(hit);
    } else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
    else if (input.length > 0 && !key.ctrl && !key.meta) setQuery((q) => q + input);
  });

  return (
    <Box flexDirection="column">
      <Text>
        search: <Text color="cyan">{query}</Text>
        <Text>▌</Text>
      </Text>
      <Text dimColor>filters: status: ledger: author: · OR/NOT/() · ↑↓ Enter Esc</Text>
      <Box marginTop={1} flexDirection="column">
        {query.trim().length === 0 ? (
          <Text dimColor>(type to search across all ledgers)</Text>
        ) : hits.length === 0 ? (
          <Text dimColor>(no hits)</Text>
        ) : (
          <ScrollList
            items={hits}
            getLabel={(h) => `${h.ledgerId}/${h.item.id} [${h.item.status}] ${summarize(h.item)}`}
            cursor={cursor}
            height={14}
            active
          />
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Column picker (T62) — a keyboard-driven multi-select over the schema's
// column-eligible fields. Space toggles a field, Enter commits the selection,
// Esc cancels. The selection is held in App state IN MEMORY for the session.
// ---------------------------------------------------------------------------

function ColumnPicker({
  eligible,
  selected,
  onSubmit,
  onCancel,
}: {
  eligible: readonly string[];
  selected: readonly string[];
  onSubmit: (cols: string[]) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [chosen, setChosen] = useState<Set<string>>(new Set(selected));
  const [cursor, setCursor] = useState(0);
  const sel = eligible.length === 0 ? 0 : Math.min(cursor, eligible.length - 1);

  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow || input === "k") setCursor((c) => Math.max(0, Math.min(c, eligible.length - 1) - 1));
    else if (key.downArrow || input === "j") setCursor((c) => Math.min(eligible.length - 1, c + 1));
    else if (input === " ") {
      const field = eligible[sel];
      if (field !== undefined) {
        setChosen((prev) => {
          const next = new Set(prev);
          if (next.has(field)) next.delete(field);
          else next.add(field);
          return next;
        });
      }
    } else if (key.return) {
      // Commit in eligible-field order so columns render in a stable order.
      onSubmit(eligible.filter((f) => chosen.has(f)));
    }
  });

  if (eligible.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>columns</Text>
        <Text dimColor>(no column-eligible fields) · Esc</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>columns</Text>
      <Text dimColor>Space toggle · Enter apply · Esc cancel</Text>
      <Box marginTop={1} flexDirection="column">
        {eligible.map((field, i) => (
          <Text key={field} inverse={i === sel}>
            {i === sel ? "› " : "  "}
            {chosen.has(field) ? "[x] " : "[ ] "}
            {field}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Overlays (edit / create / search) — own input while mounted
// ---------------------------------------------------------------------------

function Overlays({
  overlay,
  view,
  onStatus,
  onAnswer,
  onField,
  onTitle,
  search,
  onOpenHit,
  onCreateMilestone,
  onCreateItem,
  onFilter,
  columnsFor,
  onColumns,
  setOverlay,
  onCancel,
}: {
  overlay: Overlay;
  view: FetchedLedger | null;
  onStatus: (row: Row, status: string) => void;
  onAnswer: (row: Row, answer: string) => void;
  onField: (row: Row, field: string, value: string) => void;
  onTitle: (row: Row, title: string) => void;
  search: (q: string) => Promise<FtsHit[]>;
  onOpenHit: (h: FtsHit) => void;
  onCreateMilestone: (title: string) => void;
  onCreateItem: (milestoneId: string, status: string, fields: Record<string, FieldValue>) => void;
  onFilter: (f: StatusFilter) => void;
  columnsFor: (ledger: string) => string[];
  onColumns: (ledger: string, cols: string[]) => void;
  setOverlay: (o: Overlay | null) => void;
  onCancel: () => void;
}): React.ReactElement {
  switch (overlay.t) {
    case "filter": {
      const opts: StatusFilter[] = [
        { kind: "all" },
        { kind: "active" },
        { kind: "terminal" },
        ...(view?.schema.statusValues ?? []).map((v): StatusFilter => ({ kind: "status", value: v })),
      ];
      return (
        <SelectList
          items={opts}
          getLabel={(f) =>
            f.kind === "all"
              ? "all (everything)"
              : f.kind === "active"
                ? "active (non-terminal)"
                : f.kind === "terminal"
                  ? "terminal (done/closed)"
                  : `status: ${f.value}`
          }
          onSelect={(f) => onFilter(f)}
          onCancel={onCancel}
        />
      );
    }
    case "search":
      return <LiveSearch search={search} onOpenHit={onOpenHit} onCancel={onCancel} />;
    case "pickColumns": {
      const eligible = view !== null ? eligibleColumnFields(view.schema) : [];
      return (
        <ColumnPicker
          eligible={eligible}
          selected={columnsFor(overlay.ledger)}
          onSubmit={(cols) => onColumns(overlay.ledger, cols)}
          onCancel={onCancel}
        />
      );
    }
    case "status": {
      // Guard-aligned quick transitions: when the schema declares a
      // `transitions` map, offer ONLY the statuses legal from the item's
      // current one (a terminal status maps to `[]` → no actions). When the
      // map is absent, fall back to the full status list unchanged.
      const allowed = view?.schema.transitions?.[overlay.row.item.status] ?? null;
      const items = allowed ?? view?.schema.statusValues ?? [];
      return (
        <SelectList
          items={items}
          getLabel={(s) => s}
          onSelect={(s) => onStatus(overlay.row, s)}
          onCancel={onCancel}
          emptyLabel="(no transitions from this status)"
        />
      );
    }
    case "answer":
      return (
        <TextPrompt
          label="answer (saves + marks answered):"
          initialValue={fieldToString(overlay.row.item.fields[ANSWER_FIELD])}
          onSubmit={(v) => onAnswer(overlay.row, v)}
          onCancel={onCancel}
        />
      );
    case "pickField": {
      const fields = view !== null ? Object.keys(view.schema.fields) : [];
      return (
        <SelectList
          items={fields}
          getLabel={(f) => `${f} = ${fieldToString(overlay.row.item.fields[f])}`}
          onSelect={(f) => setOverlay({ t: "editField", row: overlay.row, field: f })}
          onCancel={onCancel}
          emptyLabel="(no editable fields)"
        />
      );
    }
    case "editField":
      return (
        <TextPrompt
          label={`${overlay.field}:`}
          initialValue={fieldToString(overlay.row.item.fields[overlay.field])}
          onSubmit={(v) => onField(overlay.row, overlay.field, v)}
          onCancel={onCancel}
        />
      );
    case "editTitle":
      return (
        <TextPrompt
          label="title:"
          initialValue={fieldToString(overlay.row.item.fields["title"])}
          onSubmit={(v) => onTitle(overlay.row, v)}
          onCancel={onCancel}
        />
      );
    case "createMilestone":
      return <TextPrompt label="new milestone title:" onSubmit={onCreateMilestone} onCancel={onCancel} />;
    case "createItem":
      return (
        <CreateItemForm
          view={view}
          milestones={overlay.milestones}
          onSubmit={onCreateItem}
          onCancel={onCancel}
        />
      );
    case "batchAnswer":
      // Rendered full-screen by the App (BatchAnswerOverlay), not here.
      return <></>;
  }
}

// ---------------------------------------------------------------------------
// Batch-answer stepper (T64): full-screen overlay walking the open answerable
// items of one ledger one at a time. Owns input while mounted — printable keys
// type the answer; Enter saves (App marks answered + auto-advances); ←/→ move
// between open items; Ctrl+R accepts the recommendation when present; Esc exits.
// ---------------------------------------------------------------------------

function BatchAnswerOverlay({
  overlay,
  width,
  onAnswer,
  onNav,
  onCancel,
}: {
  overlay: Extract<Overlay, { t: "batchAnswer" }>;
  width: number;
  onAnswer: (row: Row, answer: string) => void;
  onNav: (idx: number) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { rows, idx } = overlay;
  const row = rows[idx]!;
  const [value, setValue] = useState("");
  // Reset the typed answer whenever the position changes (nav or auto-advance).
  useEffect(() => {
    setValue(fieldToString(row.item.fields[ANSWER_FIELD]));
  }, [row.item.id]);

  const recommended = hasRecommendation(row.item);
  const persistedAnswerNonEmpty = hasPersistedAnswer(row.item);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.leftArrow) {
      onNav(Math.max(0, idx - 1));
    } else if (key.rightArrow) {
      onNav(Math.min(rows.length - 1, idx + 1));
    } else if (key.ctrl && input === "r") {
      // Ctrl+R: accept the recommendation (only when the item carries one and
      // the persisted answer is empty — symmetric with the list/content key gate).
      if (recommended && !persistedAnswerNonEmpty) onAnswer(row, AS_RECOMMENDED_ANSWER);
    } else if (key.return) {
      onAnswer(row, value);
    } else if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
    } else if (input.length > 0 && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  const question = fieldToString(row.item.fields[QUESTION_FIELD]) || summarize(row.item);
  const recText = fieldToString(row.item.fields[RECOMMENDATION_FIELD]);
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        batch answer · {row.item.id} · {idx + 1}/{rows.length} open
      </Text>
      <Box marginTop={1} width={Math.max(20, width)}>
        <Markdown text={question} />
      </Box>
      {recommended && (
        <Box marginTop={1}>
          <Text>
            <Text bold color="green">recommendation: </Text>
            <Text>{recText}</Text>
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>answer (saves + marks answered): </Text>
        <Text color="cyan">{value}</Text>
        <Text>▌</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Enter save · ←/→ prev/next{recommended ? " · Ctrl+R as-recommended" : ""} · Esc exit
        </Text>
      </Box>
    </Box>
  );
}

function CreateItemForm({
  view,
  milestones,
  onSubmit,
  onCancel,
}: {
  view: FetchedLedger | null;
  milestones: Item[];
  onSubmit: (milestoneId: string, status: string, fields: Record<string, FieldValue>) => void;
  onCancel: () => void;
}): React.ReactElement {
  type Step =
    | { t: "ms" }
    | { t: "status"; milestoneId: string }
    | { t: "field"; milestoneId: string; status: string; idx: number; acc: Record<string, FieldValue> };
  const [step, setStep] = useState<Step>({ t: "ms" });
  const fieldNames = view !== null ? Object.keys(view.schema.fields) : [];

  if (step.t === "ms") {
    return (
      <SelectList
        items={milestones}
        getLabel={(m) => `${m.id} ${fieldToString(m.fields["title"])}`}
        onSelect={(m) => setStep({ t: "status", milestoneId: m.id })}
        onCancel={onCancel}
        emptyLabel="(no active milestones)"
      />
    );
  }
  if (step.t === "status") {
    return (
      <SelectList
        items={view?.schema.statusValues ?? []}
        getLabel={(s) => s}
        onSelect={(s) =>
          fieldNames.length === 0
            ? onSubmit(step.milestoneId, s, {})
            : setStep({ t: "field", milestoneId: step.milestoneId, status: s, idx: 0, acc: {} })
        }
        onCancel={onCancel}
      />
    );
  }
  const name = fieldNames[step.idx]!;
  const spec = view!.schema.fields[name]!;
  return (
    <Box flexDirection="column">
      <Text dimColor>
        milestone {step.milestoneId} · status {step.status} · field {step.idx + 1}/{fieldNames.length}
      </Text>
      <TextPrompt
        label={`${name}${spec.required ? "*" : ""} (${spec.type}):`}
        onSubmit={(raw) => {
          const acc = { ...step.acc };
          if (raw.length > 0) acc[name] = parseFieldValue(raw, spec.type);
          const next = step.idx + 1;
          if (next >= fieldNames.length) onSubmit(step.milestoneId, step.status, acc);
          else setStep({ ...step, idx: next, acc });
        }}
        onCancel={onCancel}
      />
    </Box>
  );
}
