/**
 * ledger-web — the browser explorer/editor.
 *
 * A pure MCP client UI with the same capability scope as ledger-tui:
 * browse ledgers → items/milestones, view detail, full-text search, and edit
 * (item status & fields, milestone status & title, create items & milestones).
 *
 * The client is injected via `connect` so the production wiring
 * (McpLedgerClient over HTTP) and the test wiring (in-memory fake) share one
 * code path. All mutations go to the server and the current ledger is
 * re-fetched so the view reflects disk truth.
 *
 * Text inputs are uncontrolled (read via refs on action); `<select>`s are
 * controlled. This keeps real-browser UX intact while staying drivable from
 * the happy-dom test harness, where synthetic input events do not trigger
 * React's controlled-input onChange.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveContent, FetchedLedger, FetchedMilestoneGroup, FieldValue, FtsHit, Item, LedgerClient, LedgerSchema, LedgerSummary, MilestonePatch } from "./types.js";
import { DagView } from "./DagView.js";
import { Markdown } from "./Markdown.js";
import { loadDagData, type DagData } from "./dagData.js";
import { LiveManager, type LiveStats } from "@cq/ledger-live";
import { defectFixTaskIds, hypothesisRelationships } from "@cq/ledger/relationships";
// Leaf subpath: the @cq/ledger index pulls Node builtins (node:fs/os/path),
// which must not enter the browser bundle. `./columns` is side-effect-free and
// Node-free, mirroring the `./relationships` leaf import above.
import { eligibleColumnFields, defaultColumns } from "@cq/ledger/columns";
// Leaf subpath: constants.ts is data-only (no Node.js builtins). Importing
// MILESTONES_SCHEMA from here avoids the duplicated local copy (D6).
import { MILESTONES_SCHEMA } from "@cq/ledger/constants";

// Ledger names for the relationship panels — consistent with the canonical
// constants in @cq/ledger but defined locally to avoid bundling Node.js
// modules into the browser build.
const DEFECTS_LEDGER = "defects";
const TASKS_LEDGER = "tasks";
const HYPOTHESIS_LEDGER = "hypothesis";
// Default ledger the batch-answer modal (Q33) steps through. The modal scope is
// ANY answerable ledger (via canAnswer), but it opens on the questions ledger.
const QUESTIONS_LEDGER = "questions";
// Goals (T83 / Q48, user-deviated): the goals ledger renders as a FLAT list
// with NO per-coordination-milestone subsections, and a goal's detail panel
// shows its WORK-milestone ids (fields.milestones) instead of the single
// coordination-milestone row. Mirrors the TUI (T84).
const GOALS_LEDGER = "goals";
/** The `id[]` field on a goal holding its work-milestone ids (e.g. M12,M13). */
const GOAL_MILESTONES_FIELD = "milestones";
import {
  statusBucket,
  isTerminal,
  statusMatchesFilter,
  filterToValue,
  valueToFilter,
  canAnswer,
  ANSWER_FIELD,
  ANSWERED_STATUS,
  RECOMMENDATION_FIELD,
  AS_RECOMMENDED_ANSWER,
  QUESTION_FIELD,
  CONTEXT_FIELD,
  SUGGESTIONS_FIELD,
  isQuestion,
  type StatusFilter,
} from "./status.js";

const MILESTONES = "milestones";
/** Provenance author stamped on writes made by a human through this editor. */
const UI_AUTHOR = "user";

/** Debounce for as-you-type search (ms). */
const SEARCH_DEBOUNCE_MS = 200;

// Detail-panel layout, persisted to localStorage.
const PANEL_KEY = "ledger-web.panel";
const MIN_PANEL = 180;
type PanelOrientation = "right" | "bottom";
interface PanelLayout {
  orientation: PanelOrientation;
  size: number;
}
const DEFAULT_PANEL: PanelLayout = { orientation: "right", size: 380 };

function loadPanel(): PanelLayout {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PANEL_KEY) : null;
    if (raw !== null) {
      const p = JSON.parse(raw) as Partial<PanelLayout>;
      return {
        orientation: p.orientation === "bottom" ? "bottom" : "right",
        size: typeof p.size === "number" && p.size >= MIN_PANEL ? p.size : DEFAULT_PANEL.size,
      };
    }
  } catch {
    /* fall through to default */
  }
  return { ...DEFAULT_PANEL };
}

// Current navigation view, persisted so a page reload restores where you were:
// the open ledger, the selected item, and whether the table or graph was shown.
const VIEW_KEY = "ledger-web.view";
interface SavedView {
  ledger: string | null;
  itemId: string | null;
  mainView: "ledger" | "dag";
}
function loadView(): SavedView {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(VIEW_KEY) : null;
    if (raw !== null) {
      const p = JSON.parse(raw) as Partial<SavedView>;
      return {
        ledger: typeof p.ledger === "string" ? p.ledger : null,
        itemId: typeof p.itemId === "string" ? p.itemId : null,
        mainView: p.mainView === "dag" ? "dag" : "ledger",
      };
    }
  } catch {
    /* fall through to default */
  }
  return { ledger: null, itemId: null, mainView: "ledger" };
}

// Per-ledger extra-column selection, persisted to localStorage (mirrors
// PANEL_KEY/VIEW_KEY). Maps a ledger name → the chosen extra column field
// names. A ledger absent from the map has never been customised, so its
// columns are seeded lazily from defaultColumns(ledgerName) on first read.
const COLUMNS_KEY = "ledger-web.columns";
function loadColumns(): Record<string, string[]> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(COLUMNS_KEY) : null;
    if (raw !== null) {
      const p = JSON.parse(raw) as unknown;
      if (p !== null && typeof p === "object" && !Array.isArray(p)) {
        const out: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
          if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
        }
        return out;
      }
    }
  } catch {
    /* fall through to default */
  }
  return {};
}

export function clampPanelSize(size: number, max: number): number {
  return Math.max(MIN_PANEL, Math.min(size, Math.max(MIN_PANEL, max)));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function fieldToString(v: FieldValue | undefined): string {
  if (v === undefined) return "";
  return Array.isArray(v) ? v.join(", ") : v;
}
function renderListField(items: string[]): React.ReactElement {
  return (
    <ul className="lw-field-list">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
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

interface Row {
  item: Item;
  milestoneId: string;
}
function ledgerRows(view: FetchedLedger): Row[] {
  return view.milestones.flatMap((g) => g.items.map((item) => ({ item, milestoneId: g.id })));
}

export interface AppProps {
  connect: (url: string) => Promise<LedgerClient>;
  initialUrl: string;
  /** Same-origin /ws URL for live updates; null disables live. */
  liveUrl?: string | null;
  /** Injectable WebSocket ctor (tests); defaults to the global. */
  liveWsCtor?: { new (url: string): WebSocket };
}

export function App({ connect, initialUrl, liveUrl = null, liveWsCtor }: AppProps): React.ReactElement {
  const [url, setUrl] = useState(initialUrl);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const [client, setClient] = useState<LedgerClient | null>(null);
  const [conn, setConn] = useState<"connecting" | "connected" | "error">("connecting");
  const [connErr, setConnErr] = useState("");
  const [ledgers, setLedgers] = useState<LedgerSummary[]>([]);
  const [ledger, setLedger] = useState<string | null>(null);
  const [view, setView] = useState<FetchedLedger | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [hits, setHits] = useState<FtsHit[] | null>(null);
  const [creating, setCreating] = useState<"item" | "milestone" | null>(null);
  const [draftMilestones, setDraftMilestones] = useState<Item[]>([]);
  const [filter, setFilter] = useState<StatusFilter>({ kind: "all" });
  /** "" means "all milestones"; otherwise the id of the one to show. */
  const [milestoneFilter, setMilestoneFilter] = useState("");
  // Keyboard navigation: which zone has the cursor, plus per-zone cursors.
  // Items reuse `selected` as their cursor (it live-previews into the detail).
  const [navZone, setNavZone] = useState<"sidebar" | "main">("sidebar");
  const [ledgerCursor, setLedgerCursor] = useState(0);
  const [hitCursor, setHitCursor] = useState(0);
  const [selectedArchiveRow, setSelectedArchiveRow] = useState<Row | null>(null);
  const [flash, setFlash] = useState("");
  const [mainView, setMainView] = useState<"ledger" | "dag">("ledger");
  const [dag, setDag] = useState<DagData | null>(null);
  const [panel, setPanel] = useState<PanelLayout>(loadPanel);
  const [dragging, setDragging] = useState(false);
  // Per-ledger extra-column selection (persisted) + the open/closed state of
  // the column-selector popup in the toolbar.
  const [columnsByLedger, setColumnsByLedger] = useState<Record<string, string[]>>(loadColumns);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const workareaRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<LiveStats | null>(null);
  // Archive: show/hide the archived subsections. Per-group expand + lazy-fetch
  // state lives inside ArchiveSubsections (it remounts when the toggle/ledger
  // resets showArchive, so its cache resets with it).
  const [showArchive, setShowArchive] = useState(false);
  // Auxiliary items for cross-ledger relationship panels. Lazily fetched when
  // a defects or hypothesis item is selected; keyed by ledger name.
  const [auxItems, setAuxItems] = useState<Record<string, Item[]>>({});
  // Latest-callback ref: the live connection lives across ledger changes, so
  // its onChanged must call the freshest refresh closure, not a stale one.
  const refreshRef = useRef<() => void>(() => {});
  // Batch-answer modal (Q33): steps through all open answerable questions one
  // at a time in a focused, larger-font layout. `batchRows` is the captured
  // snapshot of open items taken when the modal opens; `batchIndex` is the
  // current step; `batchSchema` is the (questions) ledger schema those rows
  // belong to. Closed when batchOpen is false.
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRows, setBatchRows] = useState<Row[]>([]);
  const [batchSchema, setBatchSchema] = useState<LedgerSchema | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);

  // Filters are per-ledger; reset them whenever the active ledger changes.
  useEffect(() => {
    setFilter({ kind: "all" });
    setMilestoneFilter("");
    setShowArchive(false);
  }, [ledger]);

  // Persist panel layout.
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify(panel));
    } catch {
      /* ignore (e.g. storage disabled) */
    }
  }, [panel]);

  // Persist the per-ledger column selection.
  useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(columnsByLedger));
    } catch {
      /* ignore (e.g. storage disabled) */
    }
  }, [columnsByLedger]);

  // Close the column-selector popup whenever the active ledger changes.
  useEffect(() => {
    setColumnMenuOpen(false);
  }, [ledger]);

  // Set document.title and derive the header label from displayName once connected.
  const appTitle = client !== null ? `[${client.displayName()}] LLM ledgers` : "LLM ledgers";
  useEffect(() => {
    document.title = appTitle;
  }, [appTitle]);

  // Effective extra columns for a ledger: the persisted selection if present,
  // otherwise the per-ledger default (seeded lazily — an unsaved ledger shows
  // defaultColumns(ledgerName) without writing it back until the user edits).
  const columnsFor = useCallback(
    (name: string): string[] =>
      Object.prototype.hasOwnProperty.call(columnsByLedger, name)
        ? columnsByLedger[name]!
        : defaultColumns(name),
    [columnsByLedger],
  );

  // Toggle an extra column on/off for the active ledger. Materialises the
  // seeded default into the map on first edit so the choice persists.
  const toggleColumn = useCallback(
    (name: string, field: string): void => {
      setColumnsByLedger((prev) => {
        const current = Object.prototype.hasOwnProperty.call(prev, name)
          ? prev[name]!
          : defaultColumns(name);
        const next = current.includes(field)
          ? current.filter((c) => c !== field)
          : [...current, field];
        return { ...prev, [name]: next };
      });
    },
    [],
  );

  // While dragging the splitter, resize from the pointer position.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent): void => {
      const el = workareaRef.current;
      if (el === null) return;
      const r = el.getBoundingClientRect();
      const raw = panel.orientation === "right" ? r.right - e.clientX : r.bottom - e.clientY;
      const max = (panel.orientation === "right" ? r.width : r.height) - MIN_PANEL;
      setPanel((p) => ({ ...p, size: clampPanelSize(raw, max) }));
    };
    const onUp = (): void => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, panel.orientation]);

  const toggleOrientation = useCallback(() => {
    setPanel((p) => ({ ...p, orientation: p.orientation === "right" ? "bottom" : "right" }));
  }, []);

  useEffect(() => {
    let alive = true;
    // Capture the persisted view BEFORE the resets below trigger the
    // persistence effect (which would overwrite it with the cleared state).
    const saved = loadView();
    setConn("connecting");
    setConnErr("");
    setClient(null);
    setLedger(null);
    setView(null);
    setSelected(null);
    setHits(null);
    setMainView("ledger");
    setDag(null);
    connect(url)
      .then(async (c) => {
        if (!alive) {
          await c.close();
          return;
        }
        const ls = await c.enumerateLedgers();
        if (!alive) {
          await c.close();
          return;
        }
        setClient(c);
        setLedgers(ls);
        setConn("connected");
        // Restore the previous view (reload persistence): re-open the saved
        // ledger, re-select the saved item, and re-enter graph mode if it was
        // active. Silently skipped when the saved ledger/item no longer exists.
        if (saved.ledger !== null && ls.some((l) => l.name === saved.ledger)) {
          const v = await c.fetchLedger(saved.ledger);
          if (!alive) {
            await c.close();
            return;
          }
          setLedger(saved.ledger);
          setView(v);
          setNavZone("main");
          if (saved.itemId !== null) {
            for (const g of v.milestones)
              for (const it of g.items)
                if (it.id === saved.itemId) setSelected({ item: it, milestoneId: g.id });
          }
          if (saved.mainView === "dag") {
            setMainView("dag");
            setDag(await loadDagData(c, saved.ledger));
          }
        }
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
  }, [connect, url]);

  // Persist the current view so a page reload can restore it (see loadView).
  useEffect(() => {
    try {
      localStorage.setItem(
        VIEW_KEY,
        JSON.stringify({ ledger, itemId: selected?.item.id ?? null, mainView }),
      );
    } catch {
      /* ignore (e.g. storage disabled) */
    }
  }, [ledger, selected, mainView]);

  const isMilestones = ledger === MILESTONES;

  const openLedger = useCallback(
    async (name: string) => {
      if (client === null) return;
      try {
        const v = await client.fetchLedger(name);
        setLedger(name);
        setView(v);
        setSelected(null);
        setHits(null);
        setCreating(null);
        setFlash("");
        // In graph mode, re-graph the newly selected ledger (stay in graph).
        if (mainView === "dag") setDag(await loadDagData(client, name));
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client, mainView],
  );

  const reload = useCallback(async () => {
    if (client === null || ledger === null) return;
    try {
      const v = await client.fetchLedger(ledger);
      setView(v);
      setSelected((cur) => {
        if (cur === null) return null;
        for (const g of v.milestones)
          for (const it of g.items) if (it.id === cur.item.id) return { item: it, milestoneId: g.id };
        return null;
      });
    } catch (e) {
      setFlash(errMsg(e));
    }
  }, [client, ledger]);

  /**
   * Persist an edited item: status + all fields in one call. Milestones route
   * through update_milestone (mapping title/description/blockedBy/dependsOn);
   * every other ledger through update_item.
   */
  const saveEdit = useCallback(
    async (row: Row, status: string, fields: Record<string, FieldValue>) => {
      if (client === null) return;
      try {
        if (isMilestones) {
          const patch: MilestonePatch = { status };
          if (typeof fields["title"] === "string") patch.title = fields["title"];
          if (typeof fields["description"] === "string") patch.description = fields["description"];
          if (Array.isArray(fields["blockedBy"])) patch.blockedBy = fields["blockedBy"];
          if (Array.isArray(fields["dependsOn"])) patch.dependsOn = fields["dependsOn"];
          await client.updateMilestone(row.item.id, patch);
        } else {
          await client.updateItem(ledger!, row.item.id, { status, fields, author: UI_AUTHOR });
        }
        setFlash(`saved ${row.item.id}`);
        await reload();
        if (mainView === "dag" && ledger !== null) setDag(await loadDagData(client, ledger));
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client, isMilestones, ledger, reload, mainView],
  );

  // Open the batch-answer modal (Q33): fetch the questions ledger (the default
  // scope) and capture the set of OPEN answerable items — those where
  // canAnswer(schema, status) holds AND the item is not yet answered. The set
  // is captured once (a stable snapshot); the modal steps through it.
  const openBatch = useCallback(async () => {
    if (client === null) return;
    try {
      const v = await client.fetchLedger(QUESTIONS_LEDGER);
      const open: Row[] = [];
      for (const g of v.milestones)
        for (const it of g.items)
          if (it.status !== ANSWERED_STATUS && canAnswer(v.schema, it.status))
            open.push({ item: it, milestoneId: g.id });
      setBatchRows(open);
      setBatchSchema(v.schema);
      setBatchIndex(0);
      setBatchOpen(true);
    } catch (e) {
      setFlash(errMsg(e));
    }
  }, [client]);

  // Persist one batch answer: write the `answer` field + the `answered` status
  // for the row at `i`, then advance to the next step. Mirrors the detail
  // panel's answer path (update_item, UI_AUTHOR provenance) and refreshes the
  // underlying ledger view so counts/badges stay current.
  const batchSave = useCallback(
    async (row: Row, answer: string) => {
      if (client === null) return;
      try {
        await client.updateItem(QUESTIONS_LEDGER, row.item.id, {
          status: ANSWERED_STATUS,
          fields: { ...(row.item.fields as Record<string, FieldValue>), [ANSWER_FIELD]: answer },
          author: UI_AUTHOR,
        });
        setFlash(`saved ${row.item.id}`);
        setBatchIndex((i) => Math.min(batchRows.length - 1, i + 1));
        if (ledger === QUESTIONS_LEDGER) await reload();
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client, batchRows.length, ledger, reload],
  );

  const runSearch = useCallback(
    async (query: string) => {
      if (client === null) return;
      if (query.trim().length === 0) {
        setHits(null); // cleared input → leave search mode, show the ledger
        return;
      }
      try {
        const r = await client.ftsSearch(query);
        setHits(r);
        setSelected(null);
        setFlash(`${r.length} hit(s) for "${query}"`);
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client],
  );

  const openHit = useCallback(
    async (hit: FtsHit) => {
      if (client === null) return;
      try {
        const v = await client.fetchLedger(hit.ledgerId);
        setLedger(hit.ledgerId);
        setView(v);
        setHits(null);
        setSelected({ item: hit.item, milestoneId: hit.item.milestoneId });
        setNavZone("main"); // opening a hit lands in the item/detail zone

      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client],
  );

  // Toggle to the graph; graph the currently-selected ledger (or milestones).
  const showDag = useCallback(async () => {
    if (client === null) return;
    const target = ledger ?? MILESTONES;
    try {
      const v = await client.fetchLedger(target);
      setLedger(target);
      setView(v);
      setSelected(null);
      setHits(null);
      setMainView("dag");
      setDag(null);
      setDag(await loadDagData(client, target));
    } catch (e) {
      setFlash(errMsg(e));
    }
  }, [client, ledger]);

  // Open a graph node into the detail panel, finding it in the current view.
  const openNode = useCallback(
    (id: string) => {
      if (view === null) return;
      for (const g of view.milestones)
        for (const it of g.items) if (it.id === id) {
          setSelected({ item: it, milestoneId: g.id });
          return;
        }
    },
    [view],
  );

  // Navigate to a specific item in a (possibly different) ledger.  Used by
  // the relationship panels (fix-tasks, hypothesis tree) to let the user jump
  // between related items without leaving the MCP client.
  const navigateToItem = useCallback(
    async (targetLedger: string, itemId: string) => {
      if (client === null) return;
      try {
        const v = await client.fetchLedger(targetLedger);
        setLedger(targetLedger);
        setView(v);
        setHits(null);
        setCreating(null);
        setNavZone("main");
        for (const g of v.milestones)
          for (const it of g.items)
            if (it.id === itemId) {
              setSelected({ item: it, milestoneId: g.id });
              return;
            }
        setSelected(null);
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client],
  );

  // Keep the refresh closure current (used by the long-lived live connection).
  useEffect(() => {
    refreshRef.current = (): void => {
      if (client === null) return;
      void (async () => {
        try {
          setLedgers(await client.enumerateLedgers());
          await reload();
          if (mainView === "dag" && ledger !== null) setDag(await loadDagData(client, ledger));
        } catch {
          /* a transient fetch error surfaces on the next change */
        }
      })();
    };
  }, [client, reload, ledger, mainView]);

  // Live updates: subscribe once we have a client + a /ws URL; refetch on push.
  useEffect(() => {
    if (client === null || liveUrl === null) return;
    const mgr = new LiveManager({
      url: liveUrl,
      ...(liveWsCtor !== undefined ? { WebSocketCtor: liveWsCtor } : {}),
      onChanged: () => refreshRef.current(),
      onUpdate: (s) => setLive(s),
    });
    mgr.start();
    // React to tab visibility / network coming back (resilient-ws-ui R9 subset).
    const onVisible = (): void => {
      if (document.visibilityState === "visible") mgr.poke();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      mgr.destroy();
      setLive(null);
    };
  }, [client, liveUrl, liveWsCtor]);

  // All items in the currently-fetched ledger (unfiltered; used by relationship panels).
  const allCurrentItems = useMemo<Item[]>(
    () => (view === null ? [] : view.milestones.flatMap((g) => g.items)),
    [view],
  );

  // The item rows currently visible (ledger rows after status + milestone filter).
  // The keyboard handler and the table render from the same derived list.
  const visibleRows = useMemo(
    () =>
      view === null
        ? []
        : ledgerRows(view).filter(
            (r) =>
              statusMatchesFilter(r.item.status, view.schema, filter) &&
              (milestoneFilter === "" || r.milestoneId === milestoneFilter),
          ),
    [view, filter, milestoneFilter],
  );

  // When creating a new item, load the milestones to pick from (the editor
  // shows a milestone selector in create mode).
  useEffect(() => {
    if (creating !== "item" || client === null) return;
    let alive = true;
    void client.fetchLedger(MILESTONES).then((ms) => {
      if (alive) setDraftMilestones(ms.milestones.flatMap((g) => g.items));
    });
    return () => {
      alive = false;
    };
  }, [creating, client]);

  // When a defects item is selected, lazily fetch the tasks ledger so the
  // fix-tasks relationship panel can resolve both link directions.
  useEffect(() => {
    if (client === null || ledger !== DEFECTS_LEDGER || selected === null) return;
    if (auxItems[TASKS_LEDGER] !== undefined) return; // already cached
    let alive = true;
    void client.fetchLedger(TASKS_LEDGER).then((v) => {
      if (alive) {
        const items = v.milestones.flatMap((g) => g.items);
        setAuxItems((prev) => ({ ...prev, [TASKS_LEDGER]: items }));
      }
    }).catch(() => { /* tasks ledger may not exist */ });
    return () => {
      alive = false;
    };
  }, [client, ledger, selected, auxItems]);

  // A stable blank row to seed the editor in create mode (per create session).
  const draftRow = useMemo<Row>(
    () => ({
      item: {
        id: "",
        milestoneId: "",
        status: view?.schema.statusValues[0] ?? "",
        fields: {},
        createdAt: "",
        updatedAt: "",
      },
      milestoneId: "",
    }),
    [view, creating],
  );

  const createDraft = useCallback(
    async (milestoneId: string, status: string, fields: Record<string, FieldValue>): Promise<void> => {
      if (client === null || ledger === null) return;
      try {
        const it = await client.createItem(ledger, milestoneId, { status, fields, author: UI_AUTHOR });
        setFlash(`created ${it.id}`);
        setCreating(null);
        await reload();
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client, ledger, reload],
  );

  // Reset cursors when their underlying lists change.
  useEffect(() => setHitCursor(0), [hits]);
  useEffect(
    () => setLedgerCursor(Math.max(0, ledgers.findIndex((l) => l.name === (ledger ?? "")))),
    [ledger, ledgers],
  );

  // ---- keyboard navigation ----------------------------------------------
  // A stable document listener delegates to the freshest handler via a ref, so
  // it sees current state without re-binding on every keystroke.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    const typing =
      t !== null &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    // While the batch-answer modal is open it captures the keyboard: Esc closes
    // it, ctrl/cmd+[ steps to the previous open question and ctrl/cmd+] to the
    // next. The modifier-chord prev/next fire even while a textarea is focused
    // (the answer box) so the user can navigate without leaving the field.
    if (batchOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        setBatchOpen(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "[") {
        e.preventDefault();
        setBatchIndex((i) => Math.max(0, i - 1));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "]") {
        e.preventDefault();
        setBatchIndex((i) => Math.min(batchRows.length - 1, i + 1));
        return;
      }
      return;
    }
    // While the help dialog is open it captures the keyboard: only Esc/? close
    // it; nav keys must not drive the list underneath.
    if (helpOpen) {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        setHelpOpen(false);
      }
      return;
    }
    if (e.key === "/" && !typing) {
      e.preventDefault();
      const box = document.querySelector('[data-testid="search-input"]') as HTMLInputElement | null;
      box?.focus();
      box?.select(); // typing replaces the previous query → "start a new search"
      return;
    }
    if (e.key === "?" && !typing) {
      e.preventDefault();
      setHelpOpen(true);
      return;
    }
    if (typing) return; // inputs own every other key while focused

    if (e.key === "Escape") {
      if (selected !== null) setSelected(null);
      else if (hits !== null) setHits(null);
      else if (navZone === "main") setNavZone("sidebar");
      return;
    }
    if (mainView === "dag") return; // graph view isn't list-navigable

    const down = e.key === "ArrowDown" || e.key === "j";
    const up = e.key === "ArrowUp" || e.key === "k";
    const enter = e.key === "Enter";

    if (hits !== null) {
      if (down) {
        e.preventDefault();
        setHitCursor((c) => Math.min(hits.length - 1, c + 1));
      } else if (up) {
        e.preventDefault();
        setHitCursor((c) => Math.max(0, c - 1));
      } else if (enter) {
        const h = hits[hitCursor];
        if (h !== undefined) void openHit(h);
      }
      return;
    }

    if (navZone === "sidebar") {
      if (down) {
        e.preventDefault();
        setLedgerCursor((c) => Math.min(ledgers.length - 1, c + 1));
      } else if (up) {
        e.preventDefault();
        setLedgerCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "ArrowRight" || e.key === "l") {
        if (view !== null) setNavZone("main");
      } else if (enter) {
        const sel = ledgers[ledgerCursor];
        if (sel !== undefined) {
          void openLedger(sel.name);
          setNavZone("main");
        }
      }
      return;
    }

    // navZone === "main": move through the item rows; `selected` is the cursor
    // and live-previews into the detail panel (mirrors the TUI two-pane).
    if (e.key === "ArrowLeft" || e.key === "h") {
      setNavZone("sidebar");
      return;
    }
    if (visibleRows.length === 0) return;
    const idx = selected === null ? -1 : visibleRows.findIndex((r) => r.item.id === selected.item.id);
    if (down) {
      e.preventDefault();
      setSelected(visibleRows[Math.min(visibleRows.length - 1, idx + 1)] ?? visibleRows[0]!);
    } else if (up) {
      e.preventDefault();
      setSelected(visibleRows[idx <= 0 ? 0 : idx - 1]!);
    } else if (enter && idx < 0) {
      setSelected(visibleRows[0]!);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keyRef.current(e);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Keep the active cursor row scrolled into view.
  useEffect(() => {
    const id = selected?.item.id;
    if (id !== undefined) {
      document.querySelector(`[data-testid="item-${id}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  // ---- render ------------------------------------------------------------
  return (
    <div className="lw-root">
      <header className="lw-header">
        <span className="lw-title" data-testid="app-title">{appTitle}</span>
        <span className={`lw-conn lw-conn-${conn}`} data-testid="conn-status">
          {conn === "connected" ? "● connected" : conn === "connecting" ? "○ connecting…" : "✕ error"}
        </span>
        {liveUrl !== null && <LiveIndicator stats={live} />}
        <SearchBar onSearch={(q) => void runSearch(q)} disabled={client === null} />
        <button
          type="button"
          data-testid="toggle-dag"
          className={mainView === "dag" ? "lw-toggle lw-toggle-active" : "lw-toggle"}
          disabled={client === null}
          onClick={() => {
            if (mainView === "dag") setMainView("ledger");
            else void showDag();
          }}
        >
          {mainView === "dag" ? "table" : "graph"}
        </button>
        <div className="lw-header-right">
        <button
          type="button"
          data-testid="help-toggle"
          className="lw-gear"
          aria-label="keyboard shortcuts"
          title="Keyboard shortcuts ( ? )"
          onClick={() => setHelpOpen((o) => !o)}
        >
          ?
        </button>
        <div className="lw-settings">
          <button
            type="button"
            data-testid="settings-toggle"
            className="lw-gear"
            aria-label="settings"
            title="Server connection"
            onClick={() => setSettingsOpen((o) => !o)}
          >
            ⚙
          </button>
          {settingsOpen && (
            <form
              className="lw-settings-popup"
              data-testid="settings-popup"
              onSubmit={(e) => {
                e.preventDefault();
                if (urlRef.current !== null) setUrl(urlRef.current.value);
                setSettingsOpen(false);
              }}
            >
              <input aria-label="MCP URL" data-testid="mcp-url" ref={urlRef} defaultValue={url} />
              <button
                type="button"
                data-testid="connect"
                onClick={() => {
                  if (urlRef.current !== null) setUrl(urlRef.current.value);
                  setSettingsOpen(false);
                }}
              >
                connect
              </button>
            </form>
          )}
        </div>
        </div>
      </header>
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {batchOpen && batchSchema !== null && (
        <BatchAnswerModal
          rows={batchRows}
          index={batchIndex}
          onPrev={() => setBatchIndex((i) => Math.max(0, i - 1))}
          onNext={() => setBatchIndex((i) => Math.min(batchRows.length - 1, i + 1))}
          onSave={batchSave}
          onClose={() => setBatchOpen(false)}
        />
      )}

      {conn === "error" && (
        <div className="lw-error" data-testid="conn-error">
          connection failed: {connErr}
        </div>
      )}
      {flash.length > 0 && (
        <div className="lw-flash" data-testid="flash">
          {flash}
        </div>
      )}

      <div className="lw-body">
        <nav className="lw-sidebar" data-testid="ledger-list">
          {ledgers.map((l, i) => {
            const cls = [
              "lw-ledger",
              l.name === ledger ? "lw-ledger-active" : "",
              navZone === "sidebar" && i === ledgerCursor ? "lw-ledger-cursor" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={l.name}
                data-testid={`ledger-${l.name}`}
                className={cls}
                onClick={() => {
                  setLedgerCursor(i);
                  setNavZone("main");
                  void openLedger(l.name);
                }}
              >
                <span className="lw-ledger-name">{l.name}</span>
                <span className="lw-ledger-count" data-testid={`ledger-count-${l.name}`}>
                  {l.itemCount}
                </span>
              </button>
            );
          })}
          {/* Batch-answer entry point (Q33): pinned to the BOTTOM of the
              sidebar. Opens the modal that steps through all open questions. */}
          <button
            type="button"
            className="lw-batch-open"
            data-testid="batch-open"
            onClick={() => void openBatch()}
          >
            answer questions…
          </button>
        </nav>

        <div className={`lw-workarea lw-workarea-${panel.orientation}`} ref={workareaRef}>
        <main className="lw-main">
          {mainView === "dag" ? (
            dag !== null ? (
              <DagView data={dag} selectedId={selected?.item.id ?? null} onSelect={(id) => openNode(id)} />
            ) : (
              <p className="lw-empty" data-testid="dag-loading">
                loading graph…
              </p>
            )
          ) : hits !== null ? (
            <SearchResults
              hits={hits}
              cursor={hitCursor}
              onOpen={(h) => void openHit(h)}
              onClear={() => setHits(null)}
            />
          ) : view !== null ? (
            <>
              <div className="lw-toolbar">
                <button
                  type="button"
                  data-testid="new-item-or-milestone"
                  onClick={() => {
                    setSelected(null);
                    setCreating(isMilestones ? "milestone" : "item");
                  }}
                >
                  {isMilestones ? "+ milestone" : "+ item"}
                </button>
                <select
                  className="lw-filter"
                  data-testid="status-filter"
                  aria-label="filter by status"
                  value={filterToValue(filter)}
                  onChange={(e) => setFilter(valueToFilter(e.target.value))}
                >
                  <option value="all">all statuses</option>
                  <option value="active">active (non-terminal)</option>
                  <option value="terminal">terminal (done/closed)</option>
                  {view.schema.statusValues.map((s) => (
                    <option key={s} value={`status:${s}`}>
                      status: {s}
                    </option>
                  ))}
                </select>
                {!isMilestones && (
                  <select
                    className="lw-filter"
                    data-testid="milestone-filter"
                    aria-label="filter by milestone"
                    value={milestoneFilter}
                    onChange={(e) => setMilestoneFilter(e.target.value)}
                  >
                    <option value="">all milestones</option>
                    {view.milestones.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.id}{g.milestone.title ? `: ${g.milestone.title}` : ""}
                      </option>
                    ))}
                  </select>
                )}
                {view.archivePointers.length > 0 && (
                  <button
                    type="button"
                    data-testid="toggle-archive"
                    className={showArchive ? "lw-toggle lw-toggle-active" : "lw-toggle"}
                    onClick={() => {
                      setShowArchive((s) => !s);
                      // Hiding the archive drops any open read-only archived row.
                      if (showArchive) {
                        setSelectedArchiveRow(null);
                      }
                    }}
                  >
                    {showArchive ? "hide archived" : "show archived"}
                  </button>
                )}
                <div className="lw-column-menu">
                  <button
                    type="button"
                    data-testid="column-menu-toggle"
                    className={columnMenuOpen ? "lw-toggle lw-toggle-active" : "lw-toggle"}
                    aria-label="choose columns"
                    aria-expanded={columnMenuOpen}
                    onClick={() => setColumnMenuOpen((o) => !o)}
                  >
                    ⋮
                  </button>
                  {columnMenuOpen && ledger !== null && (
                    <div className="lw-column-popup" data-testid="column-popup" role="menu">
                      {eligibleColumnFields(view.schema).map((field) => (
                        <label key={field} className="lw-column-option">
                          <input
                            type="checkbox"
                            data-testid={`column-toggle-${field}`}
                            checked={columnsFor(ledger).includes(field)}
                            onChange={() => toggleColumn(ledger, field)}
                          />
                          {field}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {creating === "milestone" && client !== null && (
                <CreateMilestoneForm
                  onCreate={async (title) => {
                    try {
                      const m = await client.createMilestone({ title });
                      setFlash(`created ${m.id}`);
                      setCreating(null);
                      await reload();
                    } catch (e) {
                      setFlash(errMsg(e));
                    }
                  }}
                  onCancel={() => setCreating(null)}
                />
              )}
              <ItemTable
                groups={view.milestones}
                schema={view.schema}
                isMilestones={isMilestones}
                isGoals={ledger === GOALS_LEDGER}
                statusFilter={filter}
                milestoneFilter={milestoneFilter}
                extraColumns={
                  ledger === null
                    ? []
                    : eligibleColumnFields(view.schema).filter((f) =>
                        columnsFor(ledger).includes(f),
                      )
                }
                selectedId={selected?.item.id ?? null}
                onSelect={(r) => {
                  setNavZone("main");
                  setCreating(null);
                  setSelected(r);
                  setSelectedArchiveRow(null);
                }}
              />
              {showArchive && !isMilestones && view.archivePointers.length > 0 && client !== null && ledger !== null && (
                <ArchiveSubsections
                  pointers={view.archivePointers}
                  fetchArchive={(archiveId) => client.fetchLedgerArchive(ledger, archiveId)}
                  schema={view.schema}
                  selectedId={selectedArchiveRow?.item.id ?? null}
                  onSelectRow={(r) => {
                    setSelectedArchiveRow(r);
                    setSelected(null);
                  }}
                  onError={(msg) => setFlash(msg)}
                />
              )}
            </>
          ) : (
            <p className="lw-empty">{conn === "connected" ? "select a ledger" : "…"}</p>
          )}
        </main>

        {(selected !== null || creating === "item" || selectedArchiveRow !== null) && view !== null && (
          <>
            <div
              className={`lw-splitter lw-splitter-${panel.orientation}`}
              data-testid="splitter"
              role="separator"
              onPointerDown={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
            />
            <div
              className="lw-detail-wrap"
              style={panel.orientation === "right" ? { width: panel.size } : { height: panel.size }}
            >
              {creating === "item" ? (
                <DetailPanel
                  row={draftRow}
                  ledger={ledger ?? ""}
                  schema={view.schema}
                  isMilestones={isMilestones}
                  orientation={panel.orientation}
                  onToggleOrientation={toggleOrientation}
                  draftMilestones={draftMilestones}
                  onCreate={(milestoneId, status, fields) =>
                    void createDraft(milestoneId, status, fields)
                  }
                  onClose={() => setCreating(null)}
                />
              ) : selectedArchiveRow !== null ? (
                <DetailPanel
                  row={selectedArchiveRow}
                  ledger={ledger ?? ""}
                  schema={view.schema}
                  isMilestones={isMilestones}
                  orientation={panel.orientation}
                  onToggleOrientation={toggleOrientation}
                  isArchived={true}
                  onClose={() => setSelectedArchiveRow(null)}
                />
              ) : (
                selected !== null && (
                  <DetailPanel
                    row={selected}
                    ledger={ledger ?? ""}
                    schema={view.schema}
                    isMilestones={isMilestones}
                    orientation={panel.orientation}
                    onToggleOrientation={toggleOrientation}
                    onSave={(status, fields) => void saveEdit(selected, status, fields)}
                    onClose={() => setSelected(null)}
                    allCurrentItems={allCurrentItems}
                    auxItems={auxItems}
                    onNavigateToItem={(targetLedger, itemId) => void navigateToItem(targetLedger, itemId)}
                  />
                )
              )}
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

/**
 * Connection-health indicator for the live channel (resilient-ws-ui V2/V3/V10):
 * state is DERIVED from stats (never stored), shown with colour + glyph + text,
 * and labeled truthfully (terminal = "offline", not a forever-spinner).
 */
function LiveIndicator({ stats }: { stats: LiveStats | null }): React.ReactElement {
  const state = stats?.state ?? "connecting";
  const view: Record<string, { glyph: string; text: string }> = {
    alive: { glyph: "●", text: "live" },
    connecting: { glyph: "○", text: "connecting" },
    stale: { glyph: "◐", text: "stale" },
    dead: { glyph: "↻", text: "reconnecting" },
    terminal: { glyph: "✕", text: "offline" },
  };
  const v = view[state] ?? view["connecting"]!;
  const title =
    stats === null
      ? "live: connecting"
      : `live: ${state}` +
        (stats.rttMs !== null ? ` · rtt ${Math.round(stats.rttMs)}ms` : "") +
        (state === "dead" ? ` · attempt ${stats.attempt}/${stats.maxAttempts}` : "") +
        (stats.lastCloseCode !== null ? ` · last close ${stats.lastCloseCode}` : "");
  return (
    <span className={`lw-live lw-live-${state}`} data-testid="live-status" data-state={state} title={title}>
      {v.glyph} {v.text}
      {state === "dead" && stats !== null ? ` ${stats.attempt}/${stats.maxAttempts}` : ""}
    </span>
  );
}

/** Keyboard shortcut reference (opened with `?` or the header button). */
const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ["↑ / ↓  ·  j / k", "Move within the focused list"],
  ["Enter", "Open the highlighted ledger / item / hit"],
  ["→ / l  ·  ← / h", "Move between the ledger sidebar and the item list"],
  ["Esc", "Close detail → leave search → back to sidebar (and close dialogs)"],
  ["/", "Focus the search box (start a new search)"],
  ["in search: Enter / ↓", "Run it and jump to the results"],
  ["?", "Show / hide this help"],
];

function HelpOverlay({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <div className="lw-help-backdrop" data-testid="help-overlay" onClick={onClose}>
      <div className="lw-help" role="dialog" aria-label="keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="lw-help-head">
          <strong>Keyboard shortcuts</strong>
          <button type="button" className="lw-close" data-testid="help-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <dl className="lw-help-list">
          {SHORTCUTS.map(([keys, what]) => (
            <React.Fragment key={keys}>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{what}</dd>
            </React.Fragment>
          ))}
        </dl>
      </div>
    </div>
  );
}

/**
 * Batch-answer modal (Q33): a large, focused, LARGER-FONT popup that steps
 * through the captured set of open answerable questions one at a time. Reuses
 * the HelpOverlay backdrop pattern. Each step shows the question's narrative
 * fields (question, context, suggestions list, highlighted recommendation) and
 * the same two actions as the detail answerBox — "save & mark answered" and
 * "as recommended". The answer textarea is UNCONTROLLED (ref) so happy-dom can
 * drive it; it is remounted per step via the item-id key so each question
 * starts from its own stored answer. Prev/Next buttons mirror the global
 * ctrl/cmd+[ and ctrl/cmd+] chords (wired in the App keydown handler).
 */
function BatchAnswerModal({
  rows,
  index,
  onPrev,
  onNext,
  onSave,
  onClose,
}: {
  rows: Row[];
  index: number;
  onPrev: () => void;
  onNext: () => void;
  onSave: (row: Row, answer: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const answerRef = useRef<HTMLTextAreaElement>(null);
  // True once the user has typed at least one non-whitespace character; gates
  // the 'as recommended' button so it cannot clobber a draft answer (T88 / Web #15).
  const [answerHasText, setAnswerHasText] = useState(false);
  // Reset the guard whenever the active question changes.
  useEffect(() => {
    setAnswerHasText(false);
  }, [index]);
  const row = rows[index];
  const renderVal = (v: FieldValue): React.ReactNode =>
    Array.isArray(v) ? renderListField(v) : <Markdown text={v} />;
  return (
    <div className="lw-help-backdrop" data-testid="batch-overlay" onClick={onClose}>
      <div
        className="lw-batch"
        role="dialog"
        aria-label="answer open questions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lw-help-head">
          <strong data-testid="batch-progress">
            {rows.length === 0 ? "no open questions" : `open question ${index + 1} of ${rows.length}`}
          </strong>
          <button type="button" className="lw-close" data-testid="batch-close" onClick={onClose}>
            ✕
          </button>
        </div>
        {row === undefined ? (
          <p className="lw-empty" data-testid="batch-empty">
            nothing to answer.
          </p>
        ) : (
          <div className="lw-batch-body" data-testid="batch-question">
            <dl className="lw-fields">
              <dt>{QUESTION_FIELD}</dt>
              <dd data-testid="batch-field-question">{renderVal(row.item.fields[QUESTION_FIELD] ?? "")}</dd>
              {row.item.fields[CONTEXT_FIELD] !== undefined && (
                <>
                  <dt>{CONTEXT_FIELD}</dt>
                  <dd data-testid="batch-field-context">{renderVal(row.item.fields[CONTEXT_FIELD]!)}</dd>
                </>
              )}
              {row.item.fields[SUGGESTIONS_FIELD] !== undefined && (
                <>
                  <dt>{SUGGESTIONS_FIELD}</dt>
                  <dd data-testid="batch-field-suggestions">{renderVal(row.item.fields[SUGGESTIONS_FIELD]!)}</dd>
                </>
              )}
              {fieldToString(row.item.fields[RECOMMENDATION_FIELD]).trim().length > 0 && (
                <>
                  <dt>{RECOMMENDATION_FIELD}</dt>
                  <dd data-testid="batch-field-recommendation">
                    <div className="lw-recommendation" data-testid="batch-recommendation">
                      {renderVal(row.item.fields[RECOMMENDATION_FIELD]!)}
                    </div>
                  </dd>
                </>
              )}
            </dl>
            <div className="lw-answer">
              <textarea
                key={row.item.id}
                data-testid="batch-answer-input"
                className="lw-answer-input"
                rows={5}
                ref={answerRef}
                defaultValue={fieldToString(row.item.fields[ANSWER_FIELD])}
                placeholder="type an answer…"
                onInput={(e) => setAnswerHasText((e.currentTarget as HTMLTextAreaElement).value.trim().length > 0)}
              />
              <div className="lw-answer-actions">
                <button
                  type="button"
                  data-testid="batch-answer-submit"
                  onClick={() => onSave(row, answerRef.current?.value ?? "")}
                >
                  save &amp; mark answered
                </button>
                {fieldToString(row.item.fields[RECOMMENDATION_FIELD]).trim().length > 0 && (
                  <button
                    type="button"
                    data-testid="batch-answer-as-recommended"
                    disabled={answerHasText}
                    onClick={() => onSave(row, AS_RECOMMENDED_ANSWER)}
                  >
                    as recommended
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        <div className="lw-batch-nav">
          <button
            type="button"
            data-testid="batch-prev"
            onClick={onPrev}
            disabled={index <= 0}
          >
            ← prev
          </button>
          <span className="lw-dim">ctrl/⌘ + [ / ]</span>
          <button
            type="button"
            data-testid="batch-next"
            onClick={onNext}
            disabled={index >= rows.length - 1}
          >
            next →
          </button>
        </div>
      </div>
    </div>
  );
}

function SearchBar({ onSearch, disabled }: { onSearch: (q: string) => void; disabled: boolean }): React.ReactElement {
  // As-you-type: debounce each keystroke. Enter or ArrowDown commit immediately
  // and BLUR, handing keyboard focus to the results list so the global handler
  // can arrow through hits (Esc also blurs). Uncontrolled input (ref) so
  // keystrokes register under happy-dom in tests.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fire = (v: string): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    onSearch(v);
  };
  const schedule = (v: string): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => onSearch(v), SEARCH_DEBOUNCE_MS);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      fire(inputRef.current?.value ?? "");
      inputRef.current?.blur(); // → results navigation takes over
    } else if (e.key === "Escape") {
      inputRef.current?.blur();
    }
  };
  return (
    <form className="lw-search" onSubmit={(e) => e.preventDefault()}>
      <input
        ref={inputRef}
        name="q"
        aria-label="search"
        data-testid="search-input"
        placeholder="search… e.g. status:wip OR ledger:goals  ( / )"
        disabled={disabled}
        defaultValue=""
        onInput={(e) => schedule((e.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
      />
    </form>
  );
}

/**
 * The id/status/summary (+ extra columns) row table for ONE milestone
 * subsection. Shared by the active subsections (ItemTable) and the archived
 * subsections (ArchiveSubsections) so both render identical structure/classes.
 */
function SubsectionItemTable({
  rows,
  schema,
  extraColumns,
  selectedId,
  onSelect,
}: {
  rows: Row[];
  schema: FetchedLedger["schema"];
  extraColumns: string[];
  selectedId: string | null;
  onSelect: (row: Row) => void;
}): React.ReactElement {
  return (
    <table className="lw-table">
      <colgroup>
        <col className="lw-col-narrow" />
        <col className="lw-col-narrow" />
        <col />
        {extraColumns.map((c) => (
          <col key={c} className="lw-col-narrow" />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th>id</th>
          <th>status</th>
          <th>summary</th>
          {extraColumns.map((c) => (
            <th key={c} data-testid={`column-header-${c}`}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const terminal = isTerminal(r.item.status, schema);
          const cls = [
            "lw-row",
            r.item.id === selectedId ? "lw-row-active" : "",
            terminal ? "lw-row-terminal" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <tr
              key={r.item.id}
              data-testid={`item-${r.item.id}`}
              className={cls}
              onClick={() => onSelect(r)}
            >
              <td>{r.item.id}</td>
              <td>
                <span
                  className={`lw-status lw-status-${statusBucket(r.item.status, schema)}`}
                  data-testid={`status-${r.item.id}`}
                >
                  {r.item.status}
                </span>
              </td>
              <td className="lw-summary-cell">{summarize(r.item)}</td>
              {extraColumns.map((c) => (
                <td key={c} data-testid={`cell-${r.item.id}-${c}`}>
                  {fieldToString(r.item.fields[c])}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * One collapsible milestone subsection: a `<section className="lw-milestone-section">`
 * with a header button (chevron + label + optional 'archived' badge) and, when
 * expanded, its item table. Used for BOTH active and archived groups so they
 * render identical structure/classes (the only visual difference is the badge).
 *
 * `children` renders the expanded body. Kept as a render-prop-ish slot so the
 * archived path can show a loading placeholder while its items lazy-fetch and
 * so later overrides (T80 milestone-status badge, T83 goals flat-list) compose
 * by passing different `headExtra` / body content without forking this shell.
 */
function MilestoneSubsection({
  id,
  headerLabel,
  milestoneStatus,
  archived,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  headerLabel: string;
  /**
   * When provided (active milestone groups), renders a status badge using the
   * shared `lw-status lw-status-<bucket>` class derived from MILESTONES_SCHEMA.
   * Absent for archived groups (status badge rendering is a separate task — T104).
   */
  milestoneStatus?: string;
  archived: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="lw-milestone-section" data-testid={`ms-section-${id}`}>
      <button
        type="button"
        className="lw-ms-header"
        data-testid={`ms-toggle-${id}`}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span className="lw-ms-chevron">{collapsed ? "▶" : "▼"}</span>
        <span className="lw-ms-label">{headerLabel}</span>
        {milestoneStatus !== undefined && (
          <span
            className={`lw-status lw-status-${statusBucket(milestoneStatus, MILESTONES_SCHEMA)}`}
            data-testid={`ms-status-badge-${id}`}
          >
            {milestoneStatus}
          </span>
        )}
        {archived && (
          <span className="lw-archived-badge" data-testid={`archived-badge-${id}`}>
            archived
          </span>
        )}
      </button>
      {!collapsed && children}
    </section>
  );
}

/**
 * Renders the item table.
 *
 * For non-milestones ledgers the table is broken into per-milestone
 * SUBSECTIONS (collapsible headers = milestone id + title + status, in
 * fetch_ledger group order). The per-row milestone column is omitted; the
 * subsection header carries that information.
 *
 * For the milestones ledger itself (isMilestones=true) the table falls back
 * to the simple flat layout (milestone column included) because sub-grouping
 * by milestone is not meaningful there.
 *
 * For the goals ledger (isGoals=true; T83 / Q48, user-deviated) the table is a
 * FLAT list with NO per-coordination-milestone subsections AND no single
 * milestone column — a goal's coordination grouping is suppressed; its
 * work-milestone ids live in fields.milestones and are shown in the detail
 * panel instead. It reuses SubsectionItemTable (id/status/summary) so the row
 * structure/classes match the other ledgers.
 */
function ItemTable({
  groups,
  schema,
  isMilestones,
  isGoals,
  statusFilter,
  milestoneFilter,
  extraColumns,
  selectedId,
  onSelect,
}: {
  groups: FetchedMilestoneGroup[];
  schema: FetchedLedger["schema"];
  isMilestones: boolean;
  isGoals: boolean;
  statusFilter: StatusFilter;
  milestoneFilter: string;
  /** Extra column field names (after id/status/summary), already filtered to
   *  the schema's eligible fields and in eligible-field order. */
  extraColumns: string[];
  selectedId: string | null;
  onSelect: (row: Row) => void;
}): React.ReactElement {
  // Track which milestone subsections are collapsed (default: all expanded).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (isGoals) {
    // Goals (T83 / Q48): FLAT list, no subsection grouping, no milestone column.
    // Honour both the status filter and the milestone filter (the milestone-
    // filter select is still offered for non-milestones ledgers), flattening
    // across coordination groups while preserving fetch_ledger order.
    const rows: Row[] = groups
      .filter((g) => milestoneFilter === "" || g.id === milestoneFilter)
      .flatMap((g) =>
        g.items
          .filter((item) => statusMatchesFilter(item.status, schema, statusFilter))
          .map((item) => ({ item, milestoneId: g.id })),
      );
    if (rows.length === 0) return <p className="lw-empty">(no items)</p>;
    return (
      <div className="lw-subsections" data-testid="item-table">
        <SubsectionItemTable
          rows={rows}
          schema={schema}
          extraColumns={extraColumns}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      </div>
    );
  }

  if (isMilestones) {
    // Flat table for the milestones ledger (original layout).
    const rows: Row[] = groups.flatMap((g) =>
      g.items
        .filter((item) => statusMatchesFilter(item.status, schema, statusFilter))
        .map((item) => ({ item, milestoneId: g.id })),
    );
    if (rows.length === 0) return <p className="lw-empty">(no items)</p>;
    return (
      <table className="lw-table" data-testid="item-table">
        <colgroup>
          <col className="lw-col-narrow" />
          <col className="lw-col-narrow" />
          <col className="lw-col-narrow" />
          <col />
          {extraColumns.map((c) => (
            <col key={c} className="lw-col-narrow" />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th>milestone</th>
            <th>id</th>
            <th>status</th>
            <th>summary</th>
            {extraColumns.map((c) => (
              <th key={c} data-testid={`column-header-${c}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const terminal = isTerminal(r.item.status, schema);
            const cls = [
              "lw-row",
              r.item.id === selectedId ? "lw-row-active" : "",
              terminal ? "lw-row-terminal" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <tr
                key={r.item.id}
                data-testid={`item-${r.item.id}`}
                className={cls}
                onClick={() => onSelect(r)}
              >
                <td>{r.milestoneId}</td>
                <td>{r.item.id}</td>
                <td>
                  <span
                    className={`lw-status lw-status-${statusBucket(r.item.status, schema)}`}
                    data-testid={`status-${r.item.id}`}
                  >
                    {r.item.status}
                  </span>
                </td>
                <td className="lw-summary-cell">{summarize(r.item)}</td>
                {extraColumns.map((c) => (
                  <td key={c} data-testid={`cell-${r.item.id}-${c}`}>
                    {fieldToString(r.item.fields[c])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  // Non-milestones: per-milestone collapsible subsections.
  const visibleGroups = groups.filter(
    (g) => milestoneFilter === "" || g.id === milestoneFilter,
  );
  const totalVisible = visibleGroups.reduce(
    (n, g) => n + g.items.filter((item) => statusMatchesFilter(item.status, schema, statusFilter)).length,
    0,
  );
  if (totalVisible === 0) return <p className="lw-empty">(no items)</p>;

  return (
    <div className="lw-subsections" data-testid="item-table">
      {visibleGroups.map((g) => {
        const rows: Row[] = g.items
          .filter((item) => statusMatchesFilter(item.status, schema, statusFilter))
          .map((item) => ({ item, milestoneId: g.id }));
        // Omit groups that have no visible items under the current status filter.
        if (rows.length === 0) return null;
        const ms = g.milestone;
        const headerLabel = ms.title ? `${g.id}: ${ms.title}` : g.id;
        return (
          <MilestoneSubsection
            key={g.id}
            id={g.id}
            headerLabel={headerLabel}
            milestoneStatus={ms.status}
            archived={false}
            collapsed={collapsed.has(g.id)}
            onToggle={() => toggleCollapsed(g.id)}
          >
            <SubsectionItemTable
              rows={rows}
              schema={schema}
              extraColumns={extraColumns}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          </MilestoneSubsection>
        );
      })}
    </div>
  );
}

function SearchResults({
  hits,
  cursor,
  onOpen,
  onClear,
}: {
  hits: FtsHit[];
  cursor: number;
  onOpen: (h: FtsHit) => void;
  onClear: () => void;
}): React.ReactElement {
  return (
    <div data-testid="search-results">
      <div className="lw-toolbar">
        <button type="button" onClick={onClear} data-testid="search-clear">
          ← back
        </button>
      </div>
      {hits.length === 0 ? (
        <p className="lw-empty">(no hits)</p>
      ) : (
        <ul className="lw-hits">
          {hits.map((h, i) => (
            <li key={`${h.ledgerId}/${h.item.id}`}>
              <button
                type="button"
                data-testid={`hit-${h.item.id}`}
                className={i === cursor ? "lw-hit-cursor" : undefined}
                onClick={() => onOpen(h)}
              >
                <code>
                  {h.ledgerId}/{h.item.id}
                </code>{" "}
                [{h.item.status}] {summarize(h.item)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Renders the ledger's ARCHIVED milestone-groups through the SAME subsection
 * renderer as the active groups (MilestoneSubsection + SubsectionItemTable),
 * listed AFTER the active sections — each carries an 'archived' badge in its
 * head. Sections DEFAULT COLLAPSED and LAZY-FETCH their items (one
 * fetchArchive per pointer) on first expand; the content is then cached so
 * collapse/re-expand does not refetch. Archived rows open read-only via
 * `onSelectRow` (the App routes them to the read-only DetailPanel).
 */
function ArchiveSubsections({
  pointers,
  fetchArchive,
  schema,
  selectedId,
  onSelectRow,
  onError,
}: {
  pointers: Array<{ id: string; path: string; summary: string; title: string; status: string }>;
  fetchArchive: (archiveId: string) => Promise<ArchiveContent>;
  schema: FetchedLedger["schema"];
  selectedId: string | null;
  onSelectRow: (row: Row) => void;
  onError: (message: string) => void;
}): React.ReactElement {
  // Per-pointer expansion + lazily-fetched content. Default: all collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [content, setContent] = useState<Record<string, ArchiveContent>>({});
  // Pointers whose lazy fetch rejected — tracked so the placeholder shows an
  // error instead of staying stuck on 'loading…', and re-armed for retry on
  // the next expand.
  const [failed, setFailed] = useState<Set<string>>(new Set());

  const toggle = useCallback(
    (id: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          return next;
        }
        next.add(id);
        // Clear any prior failure so a re-expand reverts to 'loading…' and retries.
        setFailed((prevFailed) => {
          if (!prevFailed.has(id)) return prevFailed;
          const nextFailed = new Set(prevFailed);
          nextFailed.delete(id);
          return nextFailed;
        });
        // Lazy-fetch on first expand only (not yet cached).
        setContent((cur) => {
          if (cur[id] === undefined) {
            void fetchArchive(id)
              .then((c) => setContent((c2) => ({ ...c2, [id]: c })))
              .catch((e: unknown) => {
                // Boundary error handling: surface the failure and mark the
                // pointer failed so it shows an error, not 'loading…' forever.
                setFailed((f) => new Set(f).add(id));
                onError(errMsg(e));
              });
          }
          return cur;
        });
        return next;
      });
    },
    [fetchArchive, onError],
  );

  const rowsOf = (c: ArchiveContent | undefined, id: string): Row[] => {
    if (c === undefined) return [];
    if (c.kind === "group") {
      return c.milestone.items.map((item) => ({ item, milestoneId: c.milestone.id }));
    }
    return [{ item: c.item, milestoneId: id }];
  };

  return (
    <section className="lw-archive-section" data-testid="archive-section">
      <h3 className="lw-archive-heading">Archived milestones</h3>
      <div className="lw-subsections">
        {pointers.map((p) => {
          const collapsed = !expanded.has(p.id);
          const c = content[p.id];
          const didFail = failed.has(p.id);
          const rows = rowsOf(c, p.id);
          const headerLabel = p.title.length > 0 ? `${p.id}: ${p.title}` : p.id;
          return (
            <MilestoneSubsection
              key={p.id}
              id={p.id}
              headerLabel={headerLabel}
              archived={true}
              collapsed={collapsed}
              onToggle={() => toggle(p.id)}
            >
              {c === undefined && didFail ? (
                <p className="lw-empty" data-testid={`archive-error-${p.id}`}>
                  failed to load — expand again to retry
                </p>
              ) : c === undefined ? (
                <p className="lw-empty" data-testid={`archive-loading-${p.id}`}>
                  loading…
                </p>
              ) : (
                <SubsectionItemTable
                  rows={rows}
                  schema={schema}
                  extraColumns={[]}
                  selectedId={selectedId}
                  onSelect={onSelectRow}
                />
              )}
            </MilestoneSubsection>
          );
        })}
      </div>
    </section>
  );
}

function DetailPanel({
  row,
  ledger,
  schema,
  isMilestones,
  orientation,
  onToggleOrientation,
  onSave,
  onCreate,
  draftMilestones,
  isArchived,
  onClose,
  allCurrentItems,
  auxItems,
  onNavigateToItem,
}: {
  row: Row;
  ledger: string;
  schema: FetchedLedger["schema"];
  isMilestones: boolean;
  orientation: PanelOrientation;
  onToggleOrientation: () => void;
  onSave?: (status: string, fields: Record<string, FieldValue>) => void;
  // Create mode: present `draftMilestones` (the milestone options) + `onCreate`.
  onCreate?: (milestoneId: string, status: string, fields: Record<string, FieldValue>) => void;
  draftMilestones?: Item[];
  /** When true, suppress ALL edit affordances (archived items are read-only). */
  isArchived?: boolean;
  onClose: () => void;
  /** All items from the currently-fetched ledger (for relationship resolution). */
  allCurrentItems?: Item[];
  /** Items fetched from auxiliary ledgers keyed by ledger name. */
  auxItems?: Record<string, Item[]>;
  /** Navigate to a specific item in a (possibly different) ledger. */
  onNavigateToItem?: (targetLedger: string, itemId: string) => void;
}): React.ReactElement {
  const isDraft = draftMilestones !== undefined;
  const fieldNames = Object.keys(schema.fields);
  const [editing, setEditing] = useState(isDraft);
  const [status, setStatus] = useState(row.item.status);
  const [milestoneId, setMilestoneId] = useState(draftMilestones?.[0]?.id ?? "");
  const fieldRefs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});
  // Uncontrolled answer box for the questions "answer & resolve" affordance.
  const answerRef = useRef<HTMLTextAreaElement>(null);
  // True once the user has typed at least one non-whitespace character into the
  // answer textarea; gates the 'as recommended' and per-suggestion 'pick'
  // buttons so they cannot clobber a draft answer (T88 / Web #15).
  const [answerHasText, setAnswerHasText] = useState(false);

  // Reset to the initial mode + values whenever the row changes (a different
  // item loads, or a fresh create session starts → blank draft row).
  useEffect(() => {
    setEditing(isDraft);
    setStatus(row.item.status);
    setAnswerHasText(false);
  }, [row, isDraft]);

  // Default the milestone selection once the options arrive.
  useEffect(() => {
    if (isDraft && milestoneId === "" && draftMilestones && draftMilestones.length > 0) {
      setMilestoneId(draftMilestones[0]!.id);
    }
  }, [isDraft, draftMilestones, milestoneId]);

  const save = (): void => {
    const built: Record<string, FieldValue> = {};
    for (const name of fieldNames) {
      const raw = fieldRefs.current[name]?.value ?? "";
      // Keep an existing field even if cleared (lets you blank it); skip
      // brand-new empty fields so we don't add empties.
      if (raw.length > 0 || row.item.fields[name] !== undefined) {
        built[name] = parseFieldValue(raw, schema.fields[name]!.type);
      }
    }
    if (isDraft) {
      if (milestoneId.length === 0) return; // need a milestone to attach to
      onCreate?.(milestoneId, status, built);
    } else {
      onSave?.(status, built);
      setEditing(false);
    }
  };
  const cancel = (): void => {
    if (isDraft) onClose();
    else setEditing(false);
  };

  // The header carries the action cluster (right-aligned). In edit mode it is
  // save/cancel (close is hidden); in view mode it is dock-toggle/edit/close.
  const head = (
    <div className="lw-detail-head">
      <strong data-testid="detail-id">{isDraft ? "new item" : row.item.id}</strong>
      <span className="lw-dim"> @ {ledger}</span>
      {isArchived === true && <span className="lw-archived-badge" data-testid="archived-badge">archived</span>}
      <div className="lw-detail-actions">
        {editing ? (
          <>
            <button type="button" data-testid="cancel-edit" onClick={cancel}>
              cancel
            </button>
            <button type="button" data-testid="save" onClick={save}>
              {isDraft ? "create" : "save"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="lw-dock"
              data-testid="panel-orientation"
              title={orientation === "right" ? "Dock panel to bottom" : "Dock panel to right"}
              aria-label="toggle panel orientation"
              onClick={onToggleOrientation}
            >
              {orientation === "right" ? "▭" : "▯"}
            </button>
            {!isArchived && (
              <button type="button" className="lw-edit-btn" data-testid="edit" onClick={() => setEditing(true)}>
                edit
              </button>
            )}
            <button type="button" className="lw-close" onClick={onClose} data-testid="detail-close">
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  );

  if (editing) {
    return (
      <aside className="lw-detail" data-testid="detail">
        {head}
        <form
          className="lw-form"
          data-testid="edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {isDraft && !isMilestones && (
            <label className="lw-field">
              <span>milestone</span>
              <select
                data-testid="edit-milestone"
                value={milestoneId}
                onChange={(e) => setMilestoneId(e.target.value)}
              >
                {draftMilestones!.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id} {fieldToString(m.fields["title"])}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="lw-field">
            <span>status</span>
            <select data-testid="edit-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {schema.statusValues.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {fieldNames.map((name) => {
            const spec = schema.fields[name]!;
            const multiline = spec.type === "string";
            return (
              <label key={name} className="lw-field">
                <span>
                  {name}
                  {spec.required ? " *" : ""}
                  <span className="lw-dim"> ({spec.type})</span>
                </span>
                {multiline ? (
                  <textarea
                    data-testid={`edit-field-${name}`}
                    rows={4}
                    ref={(el) => {
                      fieldRefs.current[name] = el;
                    }}
                    defaultValue={fieldToString(row.item.fields[name])}
                  />
                ) : (
                  <input
                    data-testid={`edit-field-${name}`}
                    ref={(el) => {
                      fieldRefs.current[name] = el;
                    }}
                    defaultValue={fieldToString(row.item.fields[name])}
                    placeholder={spec.type === "string[]" ? "semicolon; or newline separated" : spec.type === "id[]" ? "comma,separated" : ""}
                  />
                )}
              </label>
            );
          })}
        </form>
      </aside>
    );
  }

  // Guard-aligned quick transitions: when the schema declares a `transitions`
  // map, the legal next statuses from the item's current one are offered as
  // one-click buttons (a terminal status maps to `[]` → none). When the map is
  // absent (null), no buttons render and the existing status editor is the
  // only path — left untouched. Each button issues the existing update path
  // (status-only patch, preserving the item's current fields).
  const allowed = schema.transitions?.[row.item.status] ?? null;

  // "Answer & resolve" affordance (questions ledger): a single action that
  // writes the `answer` field AND transitions to `answered`. When available it
  // supersedes the bare `answered` quick-transition (still offering the others,
  // e.g. `withdrawn`) and owns the `answer` field (dropped from the read-only
  // field list below to avoid showing it twice).
  // Suppressed for archived items (read-only).
  const answerable = !isMilestones && onSave !== undefined && !isArchived && canAnswer(schema, row.item.status);
  const hasRecommendation = fieldToString(row.item.fields[RECOMMENDATION_FIELD]).trim().length > 0;
  // A question item gets a fixed field order with a highlighted recommendation
  // (T23). For non-questions the original top answer box + short-first order is
  // kept unchanged.
  const isQ = !isMilestones && isQuestion(schema);
  // Goals (T83 / Q48): the goal's coordination-milestone (row.milestoneId) is
  // NOT shown; instead its work-milestone ids (fields.milestones) are rendered
  // as a `milestones` list. The `milestones` field is therefore lifted out of
  // the generic field list so it is not rendered twice.
  const isGoal = !isMilestones && ledger === GOALS_LEDGER;
  const goalMilestonesRaw = isGoal ? row.item.fields[GOAL_MILESTONES_FIELD] : undefined;
  const goalMilestones = Array.isArray(goalMilestonesRaw)
    ? goalMilestonesRaw
    : typeof goalMilestonesRaw === "string" && goalMilestonesRaw.length > 0
      ? [goalMilestonesRaw]
      : [];
  const answerWith = (answer: string): void => {
    if (onSave === undefined) return;
    onSave(ANSWERED_STATUS, {
      ...(row.item.fields as Record<string, FieldValue>),
      [ANSWER_FIELD]: answer,
    });
  };
  const submitAnswer = (): void => answerWith(answerRef.current?.value ?? "");
  const transitionTargets = (allowed ?? []).filter((t) => !(answerable && t === ANSWERED_STATUS));

  // The editable "answer & resolve" control, reused at the top (non-questions)
  // or just below the highlighted recommendation (questions).
  const answerBox = (
    <div className="lw-answer" data-testid="answer-box">
      <textarea
        key={row.item.id}
        data-testid="answer-input"
        className="lw-answer-input"
        rows={4}
        ref={answerRef}
        defaultValue={fieldToString(row.item.fields[ANSWER_FIELD])}
        placeholder="type an answer…"
        onInput={(e) => setAnswerHasText((e.currentTarget as HTMLTextAreaElement).value.trim().length > 0)}
      />
      <div className="lw-answer-actions">
        <button type="button" data-testid="answer-submit" onClick={submitAnswer}>
          save &amp; mark answered
        </button>
        {hasRecommendation && (
          <button
            type="button"
            data-testid="answer-as-recommended"
            disabled={answerHasText}
            onClick={() => answerWith(AS_RECOMMENDED_ANSWER)}
          >
            as recommended
          </button>
        )}
      </div>
    </div>
  );

  // Question field rendering (Q31 ANSWER): the structural metadata trio
  // (milestone, status, by) renders FIRST in that exact order, then the
  // narrative sequence question → context → suggestions → recommendation →
  // answer. The recommendation keeps its HIGHLIGHTED block; the answer is the
  // editable box when answerable, else the stored value. Any other metadata
  // fields render after the trio but before the narrative. Owns the whole
  // question <dl> body (status/milestone/by are NOT repeated by the outer dl).
  const renderQuestionFields = (): React.ReactElement => {
    const trio = new Set([QUESTION_FIELD, CONTEXT_FIELD, SUGGESTIONS_FIELD, RECOMMENDATION_FIELD, ANSWER_FIELD]);
    const entries = Object.entries(row.item.fields) as Array<[string, FieldValue]>;
    const extraMetadata = orderItemFields(entries.filter(([k]) => !trio.has(k)));
    const fieldDtDd = (k: string, body: React.ReactNode): React.ReactElement => (
      <React.Fragment key={k}>
        <dt>{k}</dt>
        <dd data-testid={`detail-field-${k}`}>{body}</dd>
      </React.Fragment>
    );
    const valueOf = (k: string): FieldValue | undefined => row.item.fields[k];
    const renderVal = (v: FieldValue): React.ReactNode =>
      Array.isArray(v) ? renderListField(v) : <Markdown text={v} />;
    const recVal = valueOf(RECOMMENDATION_FIELD);
    const ansVal = valueOf(ANSWER_FIELD);
    const hasBy = row.item.author !== undefined || row.item.session !== undefined;
    return (
      <>
        {/* metadata trio: milestone → status → by */}
        <dt>milestone</dt>
        <dd>{row.milestoneId}</dd>
        <dt>status</dt>
        <dd data-testid="detail-status">
          <span className={`lw-status lw-status-${statusBucket(row.item.status, schema)}`}>
            {row.item.status}
          </span>
        </dd>
        {hasBy && (
          <>
            <dt>by</dt>
            <dd data-testid="detail-provenance">
              {row.item.author ?? "?"}
              {row.item.session !== undefined ? ` · session ${row.item.session}` : ""}
            </dd>
          </>
        )}
        {extraMetadata.map(([k, v]) => fieldDtDd(k, renderVal(v)))}
        {/* narrative: question → context → suggestions → recommendation → answer */}
        {valueOf(QUESTION_FIELD) !== undefined &&
          fieldDtDd(QUESTION_FIELD, renderVal(valueOf(QUESTION_FIELD)!))}
        {valueOf(CONTEXT_FIELD) !== undefined &&
          fieldDtDd(CONTEXT_FIELD, renderVal(valueOf(CONTEXT_FIELD)!))}
        {valueOf(SUGGESTIONS_FIELD) !== undefined &&
          fieldDtDd(
            SUGGESTIONS_FIELD,
            (() => {
              const sv = valueOf(SUGGESTIONS_FIELD)!;
              const items = Array.isArray(sv) ? sv : [sv];
              return (
                <ul className="lw-field-list">
                  {items.map((item, i) => (
                    <li key={i}>
                      {item}
                      {answerable && (
                        <button
                          type="button"
                          className="lw-pick-suggestion"
                          data-testid={`answer-pick-suggestion-${i}`}
                          disabled={answerHasText}
                          onClick={() => answerWith(item)}
                        >
                          pick
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              );
            })(),
          )}
        {recVal !== undefined && (
          <React.Fragment key={RECOMMENDATION_FIELD}>
            <dt>{RECOMMENDATION_FIELD}</dt>
            <dd data-testid={`detail-field-${RECOMMENDATION_FIELD}`}>
              <div className="lw-recommendation" data-testid="recommendation">
                {renderVal(recVal)}
              </div>
            </dd>
          </React.Fragment>
        )}
        {answerable
          ? fieldDtDd(ANSWER_FIELD, answerBox)
          : ansVal !== undefined && fieldDtDd(ANSWER_FIELD, renderVal(ansVal))}
        {transitionTargets.length > 0 && !isMilestones && onSave !== undefined && !isArchived && (
          <>
            <dt>transition to</dt>
            <dd>
              <div className="lw-transitions" data-testid="transitions">
                {transitionTargets.map((target) => (
                  <button
                    key={target}
                    type="button"
                    className={`lw-transition lw-status-${statusBucket(target, schema)}`}
                    data-testid={`transition-${target}`}
                    onClick={() => onSave(target, row.item.fields as Record<string, FieldValue>)}
                  >
                    {target}
                  </button>
                ))}
              </div>
            </dd>
          </>
        )}
      </>
    );
  };

  return (
    <aside className="lw-detail" data-testid="detail">
      {head}
      <dl className="lw-fields">
        {isQ ? (
          // Question items own their entire <dl> body (metadata trio +
          // narrative + transitions) via renderQuestionFields, in the fixed
          // Q31 order. Non-questions keep the original short-first layout.
          renderQuestionFields()
        ) : (
          <>
            <dt>status</dt>
            <dd data-testid="detail-status">
              <span className={`lw-status lw-status-${statusBucket(row.item.status, schema)}`}>
                {row.item.status}
              </span>
            </dd>
            {answerable && (
              <>
                <dt>answer</dt>
                <dd>{answerBox}</dd>
              </>
            )}
            {transitionTargets.length > 0 && !isMilestones && onSave !== undefined && !isArchived && (
              <>
                <dt>transition to</dt>
                <dd>
                  <div className="lw-transitions" data-testid="transitions">
                    {transitionTargets.map((target) => (
                      <button
                        key={target}
                        type="button"
                        className={`lw-transition lw-status-${statusBucket(target, schema)}`}
                        data-testid={`transition-${target}`}
                        onClick={() =>
                          onSave(target, row.item.fields as Record<string, FieldValue>)
                        }
                      >
                        {target}
                      </button>
                    ))}
                  </div>
                </dd>
              </>
            )}
            {orderItemFields(Object.entries(row.item.fields) as Array<[string, FieldValue]>)
              .filter(([k]) => !(answerable && k === ANSWER_FIELD))
              .filter(([k]) => !(isGoal && k === GOAL_MILESTONES_FIELD))
              .map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt>{k}</dt>
                  <dd data-testid={`detail-field-${k}`}>
                    {Array.isArray(v) ? renderListField(v) : <Markdown text={v} />}
                  </dd>
                </React.Fragment>
              ))}
            {isGoal ? (
              // Goals (T83 / Q48): show the work-milestone ids as a `milestones`
              // list in place of the single coordination-milestone row.
              <>
                <dt>milestones</dt>
                <dd data-testid="detail-goal-milestones">
                  {goalMilestones.length > 0 ? (
                    renderListField(goalMilestones)
                  ) : (
                    <span className="lw-dim">(none)</span>
                  )}
                </dd>
              </>
            ) : (
              <>
                <dt>milestone</dt>
                <dd>{row.milestoneId}</dd>
              </>
            )}
            {(row.item.author !== undefined || row.item.session !== undefined) && (
              <>
                <dt>by</dt>
                <dd data-testid="detail-provenance">
                  {row.item.author ?? "?"}
                  {row.item.session !== undefined ? ` · session ${row.item.session}` : ""}
                </dd>
              </>
            )}
          </>
        )}
      </dl>
      {isMilestones && <p className="lw-dim">Milestone fields (title/deps) are edited via the form.</p>}
      {/* Defect → fix-tasks relationship panel */}
      {ledger === DEFECTS_LEDGER && !isDraft && (
        <FixTasksPanel
          defectId={row.item.id}
          defects={allCurrentItems ?? []}
          tasks={auxItems?.[TASKS_LEDGER] ?? []}
          onNavigate={(id) => onNavigateToItem?.(TASKS_LEDGER, id)}
        />
      )}
      {/* Hypothesis ancestry + children panel */}
      {ledger === HYPOTHESIS_LEDGER && !isDraft && (
        <HypothesisTreePanel
          hypothesisId={row.item.id}
          hypotheses={allCurrentItems ?? []}
          onNavigate={(id) => onNavigateToItem?.(HYPOTHESIS_LEDGER, id)}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Relationship sub-panels (defect fix-tasks, hypothesis tree)
// ---------------------------------------------------------------------------

/**
 * Renders the "Fix tasks" section for a selected defect item.
 * Uses the pure `defectFixTaskIds` helper to resolve linked tasks from both
 * forward (defect.dependsOn) and reverse (task.ledgerRefs) directions.
 */
function FixTasksPanel({
  defectId,
  defects,
  tasks,
  onNavigate,
}: {
  defectId: string;
  defects: readonly Item[];
  tasks: readonly Item[];
  onNavigate: (taskId: string) => void;
}): React.ReactElement | null {
  const taskIds = defectFixTaskIds(defectId, defects, tasks);
  if (taskIds.length === 0) return null;
  // Build a lookup so we can render status + summary for each resolved task.
  const taskById = new Map<string, Item>();
  for (const t of tasks) taskById.set(t.id, t);

  return (
    <section className="lw-rel-section" data-testid="fix-tasks-section">
      <h4 className="lw-rel-heading">Fix tasks</h4>
      <ul className="lw-rel-list">
        {taskIds.map((id) => {
          const task = taskById.get(id);
          return (
            <li key={id}>
              <button
                type="button"
                className="lw-rel-row"
                data-testid={`fix-task-${id}`}
                onClick={() => onNavigate(id)}
              >
                <span className="lw-rel-id">{id}</span>
                {task !== undefined && (
                  <>
                    <span className={`lw-status lw-status-${task.status}`} data-testid={`fix-task-status-${id}`}>
                      {task.status}
                    </span>
                    <span className="lw-rel-summary lw-dim">{summarize(task)}</span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Renders the ancestry breadcrumb (root..parent) and direct children for a
 * selected hypothesis item.
 */
function HypothesisTreePanel({
  hypothesisId,
  hypotheses,
  onNavigate,
}: {
  hypothesisId: string;
  hypotheses: readonly Item[];
  onNavigate: (hypothesisId: string) => void;
}): React.ReactElement | null {
  const { ancestors, children } = hypothesisRelationships(hypothesisId, hypotheses);
  if (ancestors.length === 0 && children.length === 0) return null;

  // Build a lookup for rendering status + summary.
  const byId = new Map<string, Item>();
  for (const h of hypotheses) byId.set(h.id, h);

  const renderHypLink = (id: string, testPrefix: string): React.ReactElement => {
    const item = byId.get(id);
    return (
      <button
        type="button"
        key={id}
        className="lw-rel-row"
        data-testid={`${testPrefix}-${id}`}
        onClick={() => onNavigate(id)}
      >
        <span className="lw-rel-id">{id}</span>
        {item !== undefined && (
          <>
            <span className={`lw-status lw-status-${item.status}`} data-testid={`${testPrefix}-status-${id}`}>
              {item.status}
            </span>
            <span className="lw-rel-summary lw-dim">{summarize(item)}</span>
          </>
        )}
      </button>
    );
  };

  return (
    <section className="lw-rel-section" data-testid="hypothesis-tree-section">
      {ancestors.length > 0 && (
        <>
          <h4 className="lw-rel-heading">Ancestry</h4>
          <nav className="lw-rel-breadcrumb" data-testid="hypothesis-ancestry" aria-label="hypothesis ancestry">
            {[...ancestors].reverse().map((id, i) => (
              <React.Fragment key={id}>
                {i > 0 && <span className="lw-rel-sep"> › </span>}
                {renderHypLink(id, "ancestor")}
              </React.Fragment>
            ))}
          </nav>
        </>
      )}
      {children.length > 0 && (
        <>
          <h4 className="lw-rel-heading">Children</h4>
          <ul className="lw-rel-list" data-testid="hypothesis-children">
            {children.map((id) => (
              <li key={id}>{renderHypLink(id, "child")}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function CreateMilestoneForm({
  onCreate,
  onCancel,
}: {
  onCreate: (title: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  const go = (): void => {
    const v = ref.current?.value ?? "";
    if (v.trim().length > 0) onCreate(v);
  };
  return (
    <form
      className="lw-create"
      data-testid="create-milestone"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <input data-testid="ms-title" placeholder="milestone title" ref={ref} defaultValue="" />
      <button type="button" data-testid="ms-create" onClick={go}>
        create
      </button>
      <button type="button" onClick={onCancel}>
        cancel
      </button>
    </form>
  );
}

