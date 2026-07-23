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
import type { AgentModelEntry, ArchiveContent, FetchedLedger, FetchedMilestoneGroup, FieldValue, FtsHit, Item, LedgerClient, LedgerSchema, LedgerSummary, MilestonePatch, ProjectEntry } from "./types.js";
import { DagView } from "./DagView.js";
import { Markdown } from "./Markdown.js";
import { loadDagData, type DagData } from "./dagData.js";
import { computeStateMachine } from "./stateMachine.js";
import { layoutDiagram, type LaidOutDiagram, type DiagramModel } from "./diagramLayout.js";
import { DiagramSvg } from "./DiagramSvg.js";
import { ROLE_FLOWS, ROLE_KIND_FILL, type RoleFlowDefinition, type RoleKind } from "./roleActions.js";
import { AGENT_ROLES } from "./agentsCatalogue.js";
import type { JSONSchema } from "@cq/config";
import { LiveManager, type LiveStats } from "@cq/ledger-live";
import {
  defectFixTaskIds,
  hypothesisRelationships,
  hypothesesLinkedToRef,
  hypothesisForest,
  type HypothesisForestNode,
} from "@cq/ledger/relationships";
import { HoldButton, type HoldClock } from "./HoldButton.js";
import { useBackdropDismiss } from "./useBackdropDismiss.js";
// Browser-safe JSONL transcript parser (T412): turns the raw `.jsonl` content
// returned by `onReadLog` into the structured conversation model the
// RawLogViewer renders (T414). Node-free leaf module.
import { parseRawLog, type ConversationModel, type ConversationTurn } from "./rawLog.js";
// Leaf subpath: the @cq/ledger index pulls Node builtins (node:fs/os/path),
// which must not enter the browser bundle. `./columns` is side-effect-free and
// Node-free, mirroring the `./relationships` leaf import above.
import { eligibleColumnFields, defaultColumns } from "@cq/ledger/columns";
// Leaf subpath: constants.ts is data-only (no Node.js builtins). Importing
// MILESTONES_SCHEMA from here avoids the duplicated local copy (D6).
import { MILESTONES_SCHEMA, IDEAS_LEDGER } from "@cq/ledger/constants";

// Ledger names for the relationship panels — consistent with the canonical
// constants in @cq/ledger but defined locally to avoid bundling Node.js
// modules into the browser build.
const DEFECTS_LEDGER = "defects";
const TASKS_LEDGER = "tasks";
const HYPOTHESIS_LEDGER = "hypothesis";
// G80/M246 (T561, Q262): the researches ledger reuses the hypothesis ledger
// as-is for research hypotheses, linked via `ledgerRefs: ["researches:<RS>"]`.
const RESEARCHES_LEDGER = "researches";
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

/**
 * Canonical sidebar group order (T193). Each inner array is one group;
 * ledgers render in this order with <hr> splitters between non-empty groups.
 * Any ledger not named here falls into the trailing "custom" group.
 * The Q&A button is appended inline after the questions ledger (group 0).
 */
const SIDEBAR_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["questions"],
  ["ideas"],
  ["goals", "milestones"],
  ["defects", "tasks"],
  ["handoffs"],
  ["decisions", "hypothesis", "reviews"],
] as const;

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

/** Query-string key the active project is persisted under (T589 / Q276/Q284). */
const PROJECT_QUERY_KEY = "project";

/**
 * Derive the sibling `/p/<key>/mcp` URL for a project switch (T589 / Q283/Q284
 * routing convention), sharing `baseUrl`'s origin. Any prior path/query/hash on
 * `baseUrl` is replaced — this always targets exactly the hub's per-project MCP
 * route, regardless of whether `baseUrl` was itself hub-shaped (`/p/<old>/mcp`)
 * or embedded (`/mcp`).
 */
export function deriveProjectMcpUrl(baseUrl: string, key: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/p/${encodeURIComponent(key)}/mcp`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** Derive the paired `/p/<key>/ws` (ws:/wss:) URL from a {@link deriveProjectMcpUrl} result. */
export function deriveProjectWsUrl(mcpUrl: string): string {
  const u = new URL(mcpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/mcp$/, "/ws");
  return u.toString();
}

/**
 * Append the `?token=` bearer secret to a ws URL (T588 / Q273) — browsers
 * cannot set custom headers on a WebSocket handshake, so the query param is
 * the one mechanism a token-protected hub's `/ws` accepts. The SINGLE encoding
 * point shared by main.tsx's `liveWsUrl` (boot) and {@link App}'s project
 * switch (T589-r2), so the two can never drift. No-op when no token is known
 * (`base` carries no query, so the URL stays clean — no dangling `?`).
 */
export function appendWsToken(base: string, token: string | null): string {
  return token !== null ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * Extract the `?token=` bearer secret a live `/ws` URL carries (T588), or
 * `null` when absent/blank. The `liveUrl` prop is the token's single carrier
 * into the App (main.tsx builds it via `liveWsUrl(token)`), so a project
 * switch recovers the secret from here to re-append it onto the derived
 * `/p/<key>/ws` URL (T589-r2).
 */
export function wsTokenOf(wsUrl: string | null): string | null {
  if (wsUrl === null) return null;
  try {
    const t = new URL(wsUrl).searchParams.get("token");
    return t !== null && t.length > 0 ? t : null;
  } catch {
    return null;
  }
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

/**
 * Render an {@link AgentRole}'s typed `inputSchema`/`outputSchema` from the
 * catalogue (T344, goal G41). The typed JSON Schema is present IFF the role is a
 * DISPATCHED-SUBAGENT (sourced from the `@cq/config` sidecars via T341's
 * agentsCatalogue.gen.ts); orchestrator-command roles carry no schema. Degrades
 * gracefully like the `get_agent_models` overlay-error path: when the schema is
 * ABSENT the cell shows a `(no typed schema)` placeholder rather than throwing,
 * so a role without a sidecar (or a future shape change) renders cleanly. When
 * present the schema is pretty-printed inside a COLLAPSED `<details>` so the
 * (large) JSON stays folded until the reader expands it.
 */
function renderTypedSchema(schema: JSONSchema | undefined): React.ReactElement {
  if (schema === undefined) {
    return <span className="lw-empty">(no typed schema)</span>;
  }
  return (
    <details className="lw-agent-schema">
      <summary>{typeof schema.title === "string" ? schema.title : "JSON Schema"}</summary>
      <pre className="lw-agent-schema-json">{JSON.stringify(schema, null, 2)}</pre>
    </details>
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
  /** Injectable HoldClock for tests; defaults to the real browser clock. */
  holdClock?: HoldClock | undefined;
}

export function App({ connect, initialUrl, liveUrl = null, liveWsCtor, holdClock }: AppProps): React.ReactElement {
  const [url, setUrl] = useState(initialUrl);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const [client, setClient] = useState<LedgerClient | null>(null);
  const [conn, setConn] = useState<"connecting" | "connected" | "error">("connecting");
  const [connErr, setConnErr] = useState("");
  // Per-agent live model overlay (T293), fetched once on connect via
  // get_agent_models and keyed by AgentRole.id. `agentOverlay` is the resolved
  // map on success; `agentOverlayError` is true when the fetch threw for ANY
  // reason (a LedgerToolError, OR a generic SDK unknown-tool error from an
  // older/embedded server that does not advertise the tool — catch-ALL). The
  // Agents help tab builds its per-role model cell PURELY from this overlay
  // (Q155=DROP / R341): there is no build-time AgentRole.model fallback.
  const [agentOverlay, setAgentOverlay] = useState<Map<string, AgentModelEntry> | null>(null);
  const [agentOverlayError, setAgentOverlayError] = useState(false);
  // Always-visible project selector (T589 / Q276/Q284): `projects` is the
  // server's list_projects answer (one entry for embedded/xdg, N for a `cq
  // serve` hub); `activeProjectKey` is the currently-selected entry's key.
  // `activeLiveUrl` starts at the `liveUrl` prop but is re-derived on a project
  // switch (see `switchProject`) so the live-updates effect below reconnects
  // to the newly-selected project's own /ws topic.
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [activeProjectKey, setActiveProjectKey] = useState<string | null>(null);
  const [activeLiveUrl, setActiveLiveUrl] = useState<string | null>(liveUrl);
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
  // A project switch's derived ws URL, applied to `activeLiveUrl` only once
  // the NEW client is confirmed (see the connect effect below) — so `client`
  // and `activeLiveUrl` transition TOGETHER in one batched render, rather than
  // `activeLiveUrl` jumping ahead while `client` still points at the OLD
  // project (which would open, then immediately tear down, a throwaway ws).
  const pendingLiveUrlRef = useRef<{ url: string | null } | null>(null);
  // Batch-answer modal (Q33). `batchRows` is the snapshot of open items
  // captured when the modal opens; `batchIndex` is the current step;
  // `batchSchema` is the (questions) ledger schema those rows belong to.
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRows, setBatchRows] = useState<Row[]>([]);
  const [batchSchema, setBatchSchema] = useState<LedgerSchema | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);
  // Tracks IDs answered during this batch session so we can recompute the
  // remaining-open set after each save (D19). Cleared when the modal opens.
  const batchAnsweredRef = useRef<Set<string>>(new Set());

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
    setAgentOverlay(null);
    setAgentOverlayError(false);
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
        // Apply a pending project-switch's derived ws URL in the SAME batched
        // update as `setClient(c)` (T589) — see `pendingLiveUrlRef`'s doc.
        if (pendingLiveUrlRef.current !== null) {
          setActiveLiveUrl(pendingLiveUrlRef.current.url);
          pendingLiveUrlRef.current = null;
        }
        setLedgers(ls);
        setConn("connected");
        // Fetch the project list once on connect (T589 / Q276/Q284): ALWAYS
        // answered by a real server (list_projects never throws not-implemented
        // through the public builder), so no catch-all fallback is needed here
        // — a thrown error just leaves the selector empty for this connection.
        try {
          const pr = await c.listProjects();
          if (!alive) {
            await c.close();
            return;
          }
          setProjects(pr.projects);
          // `?project=<key>` wins when it names a known project (deep-link /
          // reload persistence); otherwise default to the first listed entry.
          const fromQuery = new URLSearchParams(window.location.search).get(PROJECT_QUERY_KEY);
          const chosen =
            fromQuery !== null && pr.projects.some((p) => p.key === fromQuery)
              ? fromQuery
              : (pr.projects[0]?.key ?? null);
          setActiveProjectKey(chosen);
        } catch {
          if (alive) {
            setProjects([]);
            setActiveProjectKey(null);
          }
        }
        // Fetch the live per-agent model overlay once on connect (T293). A
        // catch-ALL: any thrown error — a LedgerToolError, or a generic SDK
        // unknown-tool error from an older/embedded server that does not
        // advertise get_agent_models — flips overlayError so the Agents tab
        // renders the overlay-unavailable / stale-server fallback rather than
        // a stale or build-time value.
        try {
          const overlay = await c.getAgentModels();
          if (!alive) {
            await c.close();
            return;
          }
          setAgentOverlay(new Map(overlay.agents.map((e) => [e.id, e])));
        } catch {
          if (alive) setAgentOverlayError(true);
        }
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

  /**
   * Switch the active project (T589 / Q276/Q284): derive the sibling
   * `/p/<key>/mcp` + `/p/<key>/ws` endpoints, persist the choice to
   * `?project=<key>` (so a reload or a shared link lands on the same
   * project), then swap `url` — the connect effect above tears down the old
   * client/ws (via its own cleanup + the live-updates effect's dependency on
   * `client`/`activeLiveUrl`) and reconnects fresh. A no-op when `key` is
   * already active (single-project mode: selecting the one entry does
   * nothing).
   */
  const switchProject = useCallback(
    (key: string) => {
      if (key === activeProjectKey) return;
      const newMcpUrl = deriveProjectMcpUrl(url, key);
      // Re-append the T588 bearer token (recovered from the current live URL,
      // its single carrier) onto the derived /p/<key>/ws — without it a
      // token-protected hub answers 401 and live updates silently stop
      // (T589-r2). The MCP side needs nothing here: the token rides as the
      // Authorization header inside the injected `connect` closure (main.tsx),
      // which this switch reuses unchanged.
      const newLiveUrl =
        liveUrl !== null ? appendWsToken(deriveProjectWsUrl(newMcpUrl), wsTokenOf(liveUrl)) : null;
      try {
        const next = new URL(window.location.href);
        next.searchParams.set(PROJECT_QUERY_KEY, key);
        window.history.replaceState(null, "", next.toString());
      } catch {
        /* URL/history unavailable — persistence degrades gracefully */
      }
      setActiveProjectKey(key);
      pendingLiveUrlRef.current = { url: newLiveUrl };
      setUrl(newMcpUrl);
    },
    [url, liveUrl, activeProjectKey],
  );

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

  // Open the batch-answer modal (Q33): fetch the questions ledger and capture a
  // stable snapshot of OPEN answerable items (canAnswer holds AND not yet
  // answered). The modal steps through that snapshot.
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
      batchAnsweredRef.current = new Set();
      setBatchOpen(true);
    } catch (e) {
      setFlash(errMsg(e));
    }
  }, [client]);

  // Persist one batch answer (`answer` field + `answered` status), then track
  // answered IDs locally (batchAnsweredRef) and recompute the remaining-open
  // set: empty closes the modal, else advance to the next still-open row so
  // mid-queue answers do not strand on an already-answered row (D19 / T115).
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
        // Track this answer locally and recompute the remaining-open set.
        batchAnsweredRef.current.add(row.item.id);
        const remaining = batchRows.filter((r) => !batchAnsweredRef.current.has(r.item.id));
        if (remaining.length === 0) {
          setBatchOpen(false);
        } else {
          // Advance to the next still-open row after the current position.
          const currentOrigIdx = batchRows.findIndex((r) => r.item.id === row.item.id);
          const nextRow =
            remaining.find((r) => batchRows.indexOf(r) > currentOrigIdx) ?? remaining[0]!;
          setBatchIndex(batchRows.indexOf(nextRow));
        }
        if (ledger === QUESTIONS_LEDGER) await reload();
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client, batchRows, ledger, reload],
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
  // `activeLiveUrl` (not the raw `liveUrl` prop) drives this so a project
  // switch tears down the old project's subscription and opens a fresh one on
  // the newly-selected project's /ws topic (T589 / Q276/Q284).
  useEffect(() => {
    if (client === null || activeLiveUrl === null) return;
    const mgr = new LiveManager({
      url: activeLiveUrl,
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
  }, [client, activeLiveUrl, liveWsCtor]);

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

  // When a researches item is selected, lazily fetch the hypothesis ledger so
  // the linked hypothesis-tree panel can resolve it (T561, G80/M246, Q262).
  useEffect(() => {
    if (client === null || ledger !== RESEARCHES_LEDGER || selected === null) return;
    if (auxItems[HYPOTHESIS_LEDGER] !== undefined) return; // already cached
    let alive = true;
    void client.fetchLedger(HYPOTHESIS_LEDGER).then((v) => {
      if (alive) {
        const items = v.milestones.flatMap((g) => g.items);
        setAuxItems((prev) => ({ ...prev, [HYPOTHESIS_LEDGER]: items }));
      }
    }).catch(() => { /* hypothesis ledger may not exist */ });
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

  // Visual order: group-ordered per SIDEBAR_GROUPS, then custom ledgers.
  // Both the render and the keyboard cursor use this ordering so that
  // cursor index == visual position at all times.
  const visualLedgers = useMemo<LedgerSummary[]>(() => {
    const byName = new Map(ledgers.map((l) => [l.name, l]));
    const canonical = new Set(SIDEBAR_GROUPS.flat());
    const grouped = SIDEBAR_GROUPS.flatMap((group) =>
      group.flatMap((name) => {
        const l = byName.get(name);
        return l !== undefined ? [l] : [];
      }),
    );
    const custom = ledgers.filter((l) => !canonical.has(l.name));
    return [...grouped, ...custom];
  }, [ledgers]);

  // Reset cursors when their underlying lists change.
  useEffect(() => setHitCursor(0), [hits]);
  useEffect(
    () => setLedgerCursor(Math.max(0, visualLedgers.findIndex((l) => l.name === (ledger ?? "")))),
    [ledger, visualLedgers],
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
        setLedgerCursor((c) => Math.min(visualLedgers.length - 1, c + 1));
      } else if (up) {
        e.preventDefault();
        setLedgerCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "ArrowRight" || e.key === "l") {
        if (view !== null) setNavZone("main");
      } else if (enter) {
        const sel = visualLedgers[ledgerCursor];
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
        {/* Always-visible project selector (T589 / Q276, supersedes Q284's
            hide-when-single recommendation): one entry in embedded/xdg
            single-project mode (switch is then a no-op), N entries against a
            multi-project `cq serve` hub. Controlled <select> — fine under
            happy-dom per the uncontrolled-input convention (text inputs only). */}
        <select
          className="lw-project-selector"
          data-testid="project-selector"
          aria-label="active project"
          disabled={client === null}
          value={activeProjectKey ?? ""}
          onChange={(e) => switchProject(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.key} value={p.key}>
              {p.displayName}
            </option>
          ))}
        </select>
        {activeLiveUrl !== null && <LiveIndicator stats={live} />}
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
        <LedgerProgressBar testid="progress-questions" label="questions" ledgers={ledgers} />
        <LedgerProgressBar testid="progress-tasks" label="tasks" ledgers={ledgers} />
        <LedgerProgressBar testid="progress-defects" label="defects" ledgers={ledgers} />
        <LedgerProgressBar testid="progress-researches" label="researches" ledgers={ledgers} />
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
      {helpOpen && (
        <HelpOverlay
          onClose={() => setHelpOpen(false)}
          client={client}
          agentOverlay={agentOverlay}
          agentOverlayError={agentOverlayError}
        />
      )}
      {batchOpen && batchSchema !== null && (
        <BatchAnswerModal
          rows={batchRows}
          index={batchIndex}
          onPrev={() => setBatchIndex((i) => Math.max(0, i - 1))}
          onNext={() => setBatchIndex((i) => Math.min(batchRows.length - 1, i + 1))}
          onSave={batchSave}
          onClose={() => setBatchOpen(false)}
          holdClock={holdClock}
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
          {/* Group-ordered render (T193): SIDEBAR_GROUPS order, then custom ledgers.
              <hr> splitters appear between non-empty adjacent groups.
              The Q&A button is inlined after the questions ledger (group 0). */}
          {(() => {
            const byName = new Map(visualLedgers.map((l) => [l.name, l]));
            const canonical = new Set(SIDEBAR_GROUPS.flat());

            // Build the rendered groups (only non-empty ones).
            const canonicalGroups = SIDEBAR_GROUPS.map((group) =>
              group.flatMap((name) => {
                const l = byName.get(name);
                return l !== undefined ? [l] : [];
              }),
            ).filter((g) => g.length > 0);
            const customLedgers = visualLedgers.filter((l) => !canonical.has(l.name));
            const renderedGroups = customLedgers.length > 0
              ? [...canonicalGroups, customLedgers]
              : canonicalGroups;

            // Track running visual index to align with visualLedgers indices.
            let vi = 0;
            const elements: React.ReactNode[] = [];

            for (let gi = 0; gi < renderedGroups.length; gi++) {
              const group = renderedGroups[gi]!;
              // Splitter before each group except the first.
              if (gi > 0) {
                elements.push(
                  <hr
                    key={`divider-${gi}`}
                    className="lw-sidebar-divider"
                    data-testid="sidebar-divider"
                  />,
                );
              }
              for (const l of group) {
                const idx = vi++;
                const cls = [
                  "lw-ledger",
                  l.name === ledger ? "lw-ledger-active" : "",
                  navZone === "sidebar" && idx === ledgerCursor ? "lw-ledger-cursor" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                elements.push(
                  <button
                    key={l.name}
                    data-testid={`ledger-${l.name}`}
                    className={cls}
                    onClick={() => {
                      setLedgerCursor(idx);
                      setNavZone("main");
                      void openLedger(l.name);
                    }}
                  >
                    <span className="lw-ledger-name">{l.name}</span>
                    <span className="lw-ledger-count" data-testid={`ledger-count-${l.name}`}>
                      {l.itemCount}
                    </span>
                  </button>,
                );
                // Q&A button appears inline after the questions ledger (group 0).
                if (l.name === QUESTIONS_LEDGER) {
                  elements.push(
                    <button
                      key="batch-open"
                      type="button"
                      className="lw-batch-open"
                      data-testid="batch-open"
                      onClick={() => void openBatch()}
                    >
                      Q&A
                    </button>,
                  );
                }
              }
            }
            return elements;
          })()}
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
                  holdClock={holdClock}
                />
              )}
              <ItemTable
                groups={view.milestones}
                schema={view.schema}
                isMilestones={isMilestones}
                isGoals={ledger === GOALS_LEDGER || ledger === IDEAS_LEDGER}
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
                archivePointers={view.archivePointers}
                showArchive={showArchive}
                {...(client !== null && ledger !== null
                  ? {
                      onSelectArchive: (pointer: { id: string; path: string; summary: string; title: string; status: string }) => {
                        void (async () => {
                          try {
                            const content = await client.fetchLedgerArchive(ledger, pointer.id);
                            const rows =
                              content.kind === "group"
                                ? content.milestone.items.map((item) => ({
                                    item,
                                    milestoneId: content.milestone.id,
                                  }))
                                : [{ item: content.item, milestoneId: pointer.id }];
                            const row = rows[0];
                            if (row !== undefined) {
                              setSelectedArchiveRow(row);
                              setSelected(null);
                            }
                          } catch (e) {
                            setFlash(errMsg(e));
                          }
                        })();
                      },
                    }
                  : {})}
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
                  holdClock={holdClock}
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
                  holdClock={holdClock}
                  {...(client !== null ? { onReadLog: (p: string) => client.readLog(p) } : {})}
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
                    holdClock={holdClock}
                    {...(client !== null ? { onReadLog: (p: string) => client.readLog(p) } : {})}
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
 * Small progress bar for one ledger, fed by server-computed completedCount/itemCount.
 * Degrades gracefully: itemCount=0 or missing completedCount both render a 0% bar.
 * No client-side schema lookup — classification is entirely server-side (T1/T3);
 * progressTotal is the denominator when present (excludes withdrawn items from total).
 */
function LedgerProgressBar({
  testid,
  label,
  ledgers,
}: {
  testid: string;
  label: string;
  ledgers: LedgerSummary[];
}): React.ReactElement {
  const summary = ledgers.find((l) => l.name === label);
  const total = summary?.progressTotal ?? summary?.itemCount ?? 0;
  const done = summary?.completedCount ?? 0;
  const pct = total > 0 ? (done / total) * 100 : 0;
  // Short prefix so the three bars are distinguishable at a glance: Q/T/D.
  const short = label.charAt(0).toUpperCase();
  return (
    <div
      className="lw-progress-bar"
      data-testid={testid}
      title={`${label}: ${done}/${total}`}
      aria-label={`${label}: ${done} of ${total}`}
    >
      <div className="lw-progress-fill" style={{ width: `${pct}%` }} />
      <span className="lw-progress-label">{`${short}: ${done}/${total}`}</span>
    </div>
  );
}

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

/**
 * Smooth-scroll a help-dialog section into view by its anchor id (T328). The
 * anchor id is the section's `data-testid` (the documented per-tab scheme:
 * `help-item-state-<ledger>` / `help-flow-<id>` / `help-agent-<id>`); the
 * section also carries an `id` equal to that value so both `getElementById`
 * and the `[data-testid]` selector resolve it. Exported so the cross-nav from
 * the Flows/Agents tabs (T329) can reuse one scroll path. No-op when the
 * target is absent.
 */
export function scrollToHelpSection(anchorId: string): void {
  if (typeof document === "undefined") return;
  const el =
    document.getElementById(anchorId) ??
    document.querySelector(`[data-testid="${anchorId}"]`);
  if (el !== null) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** One left-nav entry of the docs-style help layout: a section anchor + label. */
export interface HelpNavEntry {
  /** The target section's anchor id (== its data-testid / DOM id). */
  anchorId: string;
  /** The human-readable sidebar label. */
  label: string;
}

/**
 * Test hook (T328): the most-recently-mounted {@link HelpDocsLayout} for a given
 * tab registers its active-section setter here so happy-dom tests — which lack
 * IntersectionObserver and therefore cannot trigger the scrollspy by scrolling —
 * can drive the active highlight programmatically and assert the matching entry
 * gains `aria-current`/`.lw-help-nav-entry-active`. Keyed by the tab's testid
 * stem (`item-states` / `flows` / `agents`). Not used by production code.
 */
export const helpActiveSectionSetters = new Map<string, (anchorId: string | null) => void>();

/**
 * Docs-style help body layout (T328): a persistent left vertical nav sidebar +
 * a scrolling content pane. The sidebar lists one {@link HelpNavEntry} per
 * rendered section; clicking an entry smooth-scrolls its anchor into view via
 * {@link scrollToHelpSection}. A scrollspy (IntersectionObserver scoped to the
 * content pane) marks the in-view entry with `aria-current="true"` + an active
 * class. happy-dom lacks IntersectionObserver, so the observer wiring is GUARDED
 * and the active-section setter is registered in {@link helpActiveSectionSetters}
 * (keyed by `tabKey`) so tests can drive the highlight programmatically.
 */
function HelpDocsLayout({
  tabKey,
  entries,
  children,
}: {
  tabKey: string;
  entries: readonly HelpNavEntry[];
  children: React.ReactNode;
}): React.ReactElement {
  const [active, setActive] = useState<string | null>(entries[0]?.anchorId ?? null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Register the active-section setter so happy-dom tests (no
  // IntersectionObserver) can drive the highlight; deregister on unmount.
  useEffect(() => {
    helpActiveSectionSetters.set(tabKey, setActive);
    return () => {
      if (helpActiveSectionSetters.get(tabKey) === setActive) helpActiveSectionSetters.delete(tabKey);
    };
  }, [tabKey]);

  // Scrollspy: observe each section within the content pane and mark the
  // top-most intersecting one active. Guarded for environments (happy-dom)
  // without IntersectionObserver — there the setter above drives the state.
  useEffect(() => {
    const root = contentRef.current;
    if (root === null || typeof IntersectionObserver === "undefined") return;
    const sections = entries
      .map((e) => document.getElementById(e.anchorId))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          if (r.isIntersecting) visible.set(r.target.id, r.intersectionRatio);
          else visible.delete(r.target.id);
        }
        // Pick the first entry (in declared order) that is currently visible.
        const top = entries.find((e) => visible.has(e.anchorId));
        if (top !== undefined) setActive(top.anchorId);
      },
      { root, threshold: [0, 0.1, 0.5, 1] },
    );
    for (const s of sections) observer.observe(s);
    return () => observer.disconnect();
  }, [entries]);

  return (
    <div className="lw-help-docs" data-testid={`help-docs-${tabKey}`}>
      <nav className="lw-help-nav" data-testid={`help-nav-${tabKey}`} aria-label={`${tabKey} sections`}>
        {entries.map((e) => (
          <button
            key={e.anchorId}
            type="button"
            className={`lw-help-nav-entry${active === e.anchorId ? " lw-help-nav-entry-active" : ""}`}
            data-testid={`help-nav-entry-${e.anchorId}`}
            aria-current={active === e.anchorId ? "true" : undefined}
            onClick={() => {
              setActive(e.anchorId);
              scrollToHelpSection(e.anchorId);
            }}
          >
            {e.label}
          </button>
        ))}
      </nav>
      <div className="lw-help-content" data-testid={`help-content-${tabKey}`} ref={contentRef}>
        {children}
      </div>
    </div>
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

/** A named ledger schema, paired for the state-machine tab. */
interface NamedSchema {
  ledger: string;
  schema: LedgerSchema;
}

/**
 * Tabbed help dialog (T5). Tab 1 is the unchanged keyboard-shortcut reference;
 * tab 2 renders one inline-SVG state-machine diagram per ledger, colored by the
 * same status→bucket palette as the badges. The per-ledger schemas are fetched
 * lazily — a single batched fetch on first open of tab 2 — and cached for the
 * lifetime of the dialog.
 */
function HelpOverlay({
  onClose,
  client,
  agentOverlay,
  agentOverlayError,
}: {
  onClose: () => void;
  client: LedgerClient | null;
  /** Live per-agent model overlay keyed by AgentRole.id, or null until fetched. */
  agentOverlay: Map<string, AgentModelEntry> | null;
  /** True when the overlay fetch threw (any error) — Agents tab shows the fallback. */
  agentOverlayError: boolean;
}): React.ReactElement {
  const [tab, setTab] = useState<"shortcuts" | "item-states" | "flows" | "agents">("shortcuts");
  const [schemas, setSchemas] = useState<NamedSchema[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // FU-4b cross-nav (T329): the Agents-tab anchor a Flows-diagram node
  // activation wants scrolled into view, applied AFTER the tab flips to
  // 'agents' (so the section is mounted). Cleared once consumed.
  const [pendingAgentAnchor, setPendingAgentAnchor] = useState<string | null>(null);

  // Activating an agentId-bearing Flows node: flip to the Agents tab and
  // remember the target anchor; the effect below scrolls it once the tab — and
  // thus the section — is mounted. agentId is the AGENT_ROLES id T327 authored
  // on the node; the anchor is the documented `help-agent-<id>` scheme.
  const activateAgent = useCallback((agentId: string): void => {
    setTab("agents");
    setPendingAgentAnchor(`help-agent-${agentId}`);
  }, []);

  // Consume the pending anchor once the Agents tab is active. A rAF defers the
  // scroll to after the Agents-tab sections mount/paint; under happy-dom (no
  // real frames) the fallback timer drives the same path.
  useEffect(() => {
    if (tab !== "agents" || pendingAgentAnchor === null) return;
    const anchor = pendingAgentAnchor;
    setPendingAgentAnchor(null);
    const raf: (cb: FrameRequestCallback) => void =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb) => {
            setTimeout(() => cb(0), 0);
          };
    raf(() => scrollToHelpSection(anchor));
  }, [tab, pendingAgentAnchor]);

  // Batched, cached fetch of every ledger's schema — runs once, the first time
  // the state-machines tab is shown.
  useEffect(() => {
    if (tab !== "item-states" || schemas !== null || client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const summaries = await client.enumerateLedgers();
        const fetched = await Promise.all(
          summaries.map(async (s) => ({ ledger: s.name, schema: (await client.fetchLedger(s.name)).schema })),
        );
        if (!cancelled) setSchemas(fetched);
      } catch (e) {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, schemas, client]);

  const helpBackdropProps = useBackdropDismiss(onClose);
  return (
    <div className="lw-help-backdrop" data-testid="help-overlay" {...helpBackdropProps}>
      <div className="lw-help" role="dialog" aria-label="help" onClick={(e) => e.stopPropagation()}>
        <div className="lw-help-head">
          <div className="lw-help-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "shortcuts"}
              className={`lw-help-tab${tab === "shortcuts" ? " lw-help-tab-active" : ""}`}
              data-testid="help-tab-shortcuts"
              onClick={() => setTab("shortcuts")}
            >
              Keyboard shortcuts
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "item-states"}
              className={`lw-help-tab${tab === "item-states" ? " lw-help-tab-active" : ""}`}
              data-testid="help-tab-item-states"
              onClick={() => setTab("item-states")}
            >
              Item States
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "flows"}
              className={`lw-help-tab${tab === "flows" ? " lw-help-tab-active" : ""}`}
              data-testid="help-tab-flows"
              onClick={() => setTab("flows")}
            >
              Flows
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "agents"}
              className={`lw-help-tab${tab === "agents" ? " lw-help-tab-active" : ""}`}
              data-testid="help-tab-agents"
              onClick={() => setTab("agents")}
            >
              Agents
            </button>
          </div>
          <button type="button" className="lw-close" data-testid="help-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="lw-help-body">
          {tab === "shortcuts" ? (
            <dl className="lw-help-list" data-testid="help-shortcuts">
              {SHORTCUTS.map(([keys, what]) => (
                <React.Fragment key={keys}>
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </React.Fragment>
              ))}
            </dl>
          ) : tab === "item-states" ? (
            loadErr !== null ? (
              <div className="lw-help-item-states" data-testid="help-item-states">
                <p className="lw-empty">(could not load schemas: {loadErr})</p>
              </div>
            ) : schemas === null ? (
              <div className="lw-help-item-states" data-testid="help-item-states">
                <p className="lw-empty">(loading…)</p>
              </div>
            ) : (
              <HelpDocsLayout
                tabKey="item-states"
                entries={schemas.map(({ ledger }) => ({
                  anchorId: `help-item-state-${ledger}`,
                  label: ledger,
                }))}
              >
                <div className="lw-help-item-states" data-testid="help-item-states">
                  {schemas.map(({ ledger, schema }) => (
                    <section
                      key={ledger}
                      id={`help-item-state-${ledger}`}
                      className="lw-item-state"
                      data-testid={`help-item-state-${ledger}`}
                    >
                      <h4>{ledger}</h4>
                      <StateMachineDiagram ledger={ledger} schema={schema} />
                    </section>
                  ))}
                </div>
              </HelpDocsLayout>
            )
          ) : tab === "flows" ? (
            <HelpDocsLayout
              tabKey="flows"
              entries={ROLE_FLOWS.map((flow) => ({
                anchorId: `help-flow-${flow.id}`,
                label: flow.title,
              }))}
            >
              <div className="lw-help-flows" data-testid="help-flows">
                <FlowLegend />
                {ROLE_FLOWS.map((flow) => (
                  <section
                    key={flow.id}
                    id={`help-flow-${flow.id}`}
                    className="lw-flow"
                    data-testid={`help-flow-${flow.id}`}
                  >
                    <h4>{flow.title}</h4>
                    <FlowDiagram flow={flow} onActivateAgent={activateAgent} />
                  </section>
                ))}
              </div>
            </HelpDocsLayout>
          ) : (
            <HelpDocsLayout
              tabKey="agents"
              entries={AGENT_ROLES.map((role) => ({
                anchorId: `help-agent-${role.id}`,
                label: role.name,
              }))}
            >
              <AgentsTab overlay={agentOverlay} overlayError={agentOverlayError} />
            </HelpDocsLayout>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The resolved model VIEW for one role's Agents-tab cell (T293, R341/Q155=DROP).
 *
 * Built PURELY from the live `get_agent_models` overlay entry (keyed by
 * `AgentRole.id`) plus the overlay-error flag — it never reads static catalogue
 * fields. A discriminated union so the render (T295) only formats
 * what is resolved here:
 *
 * - `resolved`        — a live token (or tokens) was found; carries the tier
 *                       `modelClass` and the per-harness `mappings`.
 * - `no-live-token`   — cq.toml present but no live token of the role's class;
 *                       carries the (nullable) `tier` for the label.
 * - `not-configured`  — no cq.toml at all.
 * - `not-model-configurable` — orchestrator command; model selection is N/A.
 * - `unavailable`     — the overlay fetch threw (overlayError) OR the role has
 *                       no overlay entry; renders the offline fallback.
 */
export type AgentModelView =
  | { kind: "resolved"; modelClass: "frontier" | "standard" | "fast"; mappings: { claude?: readonly string[]; pi?: readonly string[] } }
  | { kind: "no-live-token"; tier: string | null }
  | { kind: "not-configured" }
  | { kind: "not-model-configurable" }
  | { kind: "unavailable" };

/**
 * Resolve a role's {@link AgentModelView} from the live overlay (T293). When the
 * overlay fetch failed (`overlayError`) OR the role has no entry, the view is
 * `unavailable` (the overlay-unavailable / stale-server fallback). A `resolved` entry
 * with a null `modelClass` is treated as `no-live-token` — a resolved tier class
 * is the operational precondition for the resolved label.
 */
export function resolveAgentModelView(
  entry: AgentModelEntry | undefined,
  overlayError: boolean,
): AgentModelView {
  if (overlayError || entry === undefined) return { kind: "unavailable" };
  switch (entry.status) {
    case "resolved":
      return entry.modelClass !== null
        ? { kind: "resolved", modelClass: entry.modelClass, mappings: entry.modelMappings }
        : { kind: "no-live-token", tier: null };
    case "no-live-token":
      return { kind: "no-live-token", tier: entry.modelClass };
    case "not-configured":
      return { kind: "not-configured" };
    case "not-model-configurable":
      return { kind: "not-model-configurable" };
  }
}

/**
 * Render a role's model cell from its resolved {@link AgentModelView} (T293
 * resolves the value; T295 owns the final formatting). One status→label mapping
 * is the single source of truth for what the user sees:
 * - `resolved`              → the tier class + per-harness token chips;
 * - `no-live-token`         → `no live token for <tier>`;
 * - `not-configured`        → `not configured (no cq.toml)`;
 * - `not-model-configurable`→ `N/A`;
 * - `unavailable`           → stale-server message (overlay unavailable; rebuild + restart).
 */
function AgentModelCell({ view }: { view: AgentModelView }): React.ReactElement {
  switch (view.kind) {
    case "resolved": {
      const entries: [string, readonly string[]][] = [];
      if (view.mappings.claude !== undefined) entries.push(["claude", view.mappings.claude]);
      if (view.mappings.pi !== undefined) entries.push(["pi", view.mappings.pi]);
      return (
        <span className="lw-agent-model-resolved">
          {view.modelClass}
          {entries.length > 0 && (
            <ul className="lw-field-list">
              {entries.map(([harness, tokens]) => (
                <li key={harness}>
                  <strong>{harness}:</strong>{" "}
                  {tokens.length > 0
                    ? tokens.map((t, i) => (
                        <span key={i} className="lw-token-chip">{t}</span>
                      ))
                    : "default"}
                </li>
              ))}
            </ul>
          )}
        </span>
      );
    }
    case "no-live-token":
      return <span className="lw-agent-model-no-token">{`no live token for ${view.tier ?? "?"}`}</span>;
    case "not-configured":
      return <span className="lw-agent-model-unconfigured">not configured (no cq.toml)</span>;
    case "not-model-configurable":
      return <span className="lw-agent-model-na">N/A</span>;
    case "unavailable":
      return <span className="lw-agent-model-unavailable">model overlay unavailable — server predates get_agent_models; rebuild + restart ledger-web/ledger-mcp</span>;
  }
}

/**
 * Agents help tab (T278, goal G34): one section per Q148 role from the
 * GENERATED {@link AGENT_ROLES} catalogue (re-exported by `agentsCatalogue.ts`).
 * Static data only — like ROLE_FLOWS, no MCP fetch. Each section shows the role's
 * identity, IO model, configured model class + per-harness mappings, the
 * MECHANICALLY-DERIVED privilege as an RO/RW badge, the exposed-tools
 * descriptor, and the full prompt-template body folded inside a COLLAPSED
 * `<details>` (no `open` attribute) so the (possibly large) markdown stays
 * folded until the reader expands it. Per-role testids follow the documented
 * scheme: `help-agent-<id>`, `-privilege`, `-tools`, `-prompt`.
 */
function AgentsTab({
  overlay,
  overlayError,
}: {
  overlay: Map<string, AgentModelEntry> | null;
  overlayError: boolean;
}): React.ReactElement {
  return (
    <div className="lw-help-agents" data-testid="help-agents">
      {AGENT_ROLES.map((role) => (
        <section key={role.id} id={`help-agent-${role.id}`} className="lw-agent" data-testid={`help-agent-${role.id}`}>
          <div className="lw-agent-head">
            <h4 className="lw-agent-name">{role.name}</h4>
            <span
              className={`lw-agent-privilege lw-agent-privilege-${role.privilege.toLowerCase()}`}
              data-testid={`help-agent-${role.id}-privilege`}
            >
              {role.privilege}
            </span>
          </div>
          <dl className="lw-agent-fields">
            <dt>Kind</dt>
            <dd>{role.kind}</dd>
            <dt>Source</dt>
            <dd>{role.source}</dd>
            <dt>Description</dt>
            <dd>{role.description}</dd>
            <dt>Inputs</dt>
            <dd>{role.inputs.length > 0 ? renderListField(role.inputs) : <span className="lw-empty">(none)</span>}</dd>
            <dt>Outputs</dt>
            <dd>{role.outputs.length > 0 ? renderListField(role.outputs) : <span className="lw-empty">(none)</span>}</dd>
            <dt>IO schema</dt>
            <dd>{role.ioSchema.length > 0 ? renderListField(role.ioSchema) : <span className="lw-empty">(none)</span>}</dd>
            <dt>Input schema</dt>
            <dd data-testid={`help-agent-${role.id}-input-schema`}>{renderTypedSchema(role.inputSchema)}</dd>
            <dt>Output schema</dt>
            <dd data-testid={`help-agent-${role.id}-output-schema`}>{renderTypedSchema(role.outputSchema)}</dd>
            <dt>Model</dt>
            <dd data-testid={`help-agent-${role.id}-model`}>
              <AgentModelCell view={resolveAgentModelView(overlay?.get(role.id), overlayError)} />
            </dd>
            <dt>Exposed tools</dt>
            <dd className="lw-agent-tools" data-testid={`help-agent-${role.id}-tools`}>
              {role.exposedTools}
            </dd>
          </dl>
          <details className="lw-agent-prompt" data-testid={`help-agent-${role.id}-prompt`}>
            <summary>Prompt template</summary>
            <Markdown text={role.promptTemplate} />
          </details>
        </section>
      ))}
    </div>
  );
}

/**
 * Inline-SVG state-machine diagram for a single ledger (T5, migrated to the elk
 * renderer in T203 / decision K37). {@link computeStateMachine} maps the schema
 * to the generic graph model (status nodes filled by their bucket color, edges
 * from the `transitions` pairs INCLUDING self-loops); {@link layoutDiagram}
 * positions it via elkjs (async — driven in a useEffect), then {@link DiagramSvg}
 * renders it. The per-ledger `idPrefix` (`help-item-state-${ledger}`) makes the
 * documented T202 scheme resolve per-ledger: svg `${idPrefix}-svg`, node
 * `${idPrefix}-node-${status}`, edge `${idPrefix}-edge-${from}-${to}`.
 *
 * elk lays out left→right with no empty leading layer, so wide diagrams stay
 * left-aligned (no D33 right-shift): the homegrown `computeDagLayout` is no
 * longer in this path.
 */
function StateMachineDiagram({ ledger, schema }: { ledger: string; schema: LedgerSchema }): React.ReactElement {
  const model = useMemo(() => computeStateMachine(schema), [schema]);
  const [laid, setLaid] = useState<LaidOutDiagram | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out = await layoutDiagram(model);
      if (!cancelled) setLaid(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [model]);
  if (laid === null) return <p className="lw-empty">(laying out…)</p>;
  return <DiagramSvg idPrefix={`help-item-state-${ledger}`} model={laid} className="lw-item-state-svg" />;
}

/**
 * Inline-SVG diagram for one cq: flow's roles & actions (T316, decision Q171).
 * Mirrors {@link StateMachineDiagram}'s elk pattern, but the data is the
 * hand-authored role→actions catalogue ({@link ROLE_FLOWS}): each flow's
 * `model` is ALREADY the generic {@link DiagramModel} the elk layer consumes
 * (role nodes + labelled action edges), so it feeds {@link layoutDiagram}
 * directly — no `kind`→fill mapping. {@link DiagramSvg} renders it under the
 * per-flow idPrefix `help-flow-${flow.id}` (svg `${idPrefix}-svg`, node
 * `${idPrefix}-node-${id}`, edge `${idPrefix}-edge-${from}-${to}`, edge label
 * `${idPrefix}-edge-label-…`). The data is static (no MCP fetch), so it lays
 * out on first tab open.
 */
function FlowDiagram({
  flow,
  onActivateAgent,
}: {
  flow: RoleFlowDefinition;
  /** FU-4b (T329): forwarded to {@link DiagramSvg} so agentId nodes cross-nav. */
  onActivateAgent: (agentId: string) => void;
}): React.ReactElement {
  const model: DiagramModel = flow.model;
  const [laid, setLaid] = useState<LaidOutDiagram | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out = await layoutDiagram(model);
      if (!cancelled) setLaid(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [model]);
  if (laid === null) return <p className="lw-empty">(laying out…)</p>;
  return (
    <DiagramSvg
      idPrefix={`help-flow-${flow.id}`}
      model={laid}
      className="lw-flow-svg"
      onActivateAgent={onActivateAgent}
    />
  );
}

/**
 * Flows-tab color legend (FU-4d, T329): one swatch + label per {@link RoleKind},
 * generated from the EXPORTED {@link ROLE_KIND_FILL} palette so the node hues on
 * the flow diagrams are interpretable. The swatch background-color is exactly
 * `ROLE_KIND_FILL[kind]` (asserted by the happy-dom test).
 */
function FlowLegend(): React.ReactElement {
  const kinds = Object.keys(ROLE_KIND_FILL) as RoleKind[];
  return (
    <div className="lw-flow-legend" data-testid="help-flow-legend" aria-label="role color legend">
      {kinds.map((kind) => (
        <span key={kind} className="lw-flow-legend-item" data-testid={`help-flow-legend-${kind}`}>
          <span
            className="lw-flow-legend-swatch"
            data-testid={`help-flow-legend-swatch-${kind}`}
            style={{ backgroundColor: ROLE_KIND_FILL[kind] }}
          />
          {kind}
        </span>
      ))}
    </div>
  );
}

/**
 * Batch-answer modal (Q33): steps through the captured set of open answerable
 * questions one at a time, reusing the HelpOverlay backdrop. Same two actions as
 * the detail answerBox ("save & mark answered" / "as recommended"). The answer
 * textarea is UNCONTROLLED (ref) so happy-dom can drive it, and is remounted per
 * step via the item-id key so each question starts from its own stored answer.
 * Prev/Next mirror the global ctrl/cmd+[ and ctrl/cmd+] chords.
 */
function BatchAnswerModal({
  rows,
  index,
  onPrev,
  onNext,
  onSave,
  onClose,
  holdClock,
}: {
  rows: Row[];
  index: number;
  onPrev: () => void;
  onNext: () => void;
  onSave: (row: Row, answer: string) => void;
  onClose: () => void;
  holdClock?: HoldClock | undefined;
}): React.ReactElement {
  const answerRef = useRef<HTMLTextAreaElement>(null);
  // True when the answer textarea contains non-whitespace text; gates the
  // 'save & mark answered' button (must have text) and the 'as recommended'
  // button (must NOT have text, to avoid clobbering a draft) (T88 / Web #15, D29).
  const [answerHasText, setAnswerHasText] = useState(
    () => fieldToString(rows[index]?.item.fields[ANSWER_FIELD]).trim().length > 0,
  );
  // Re-sync the guard whenever the active question changes.
  useEffect(() => {
    setAnswerHasText(fieldToString(rows[index]?.item.fields[ANSWER_FIELD]).trim().length > 0);
  }, [index, rows]);
  const row = rows[index];
  const renderVal = (v: FieldValue): React.ReactNode =>
    Array.isArray(v) ? renderListField(v) : <Markdown text={v} />;
  const batchBackdropProps = useBackdropDismiss(onClose);
  return (
    <div className="lw-help-backdrop" data-testid="batch-overlay" {...batchBackdropProps}>
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
                  <dd data-testid="batch-field-suggestions">
                    {(() => {
                      const sv = row.item.fields[SUGGESTIONS_FIELD]!;
                      const items = Array.isArray(sv) ? sv : [sv];
                      return (
                        <ul className="lw-field-list">
                          {items.map((suggestion, i) => (
                            <li key={i}>
                              {suggestion}
                              <HoldButton
                                className="lw-pick-suggestion"
                                data-testid={`batch-pick-suggestion-${i}`}
                                disabled={answerHasText}
                                onConfirm={() => onSave(row, suggestion)}
                                clock={holdClock}
                              >
                                pick
                              </HoldButton>
                            </li>
                          ))}
                        </ul>
                      );
                    })()}
                  </dd>
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
                <HoldButton
                  data-testid="batch-answer-submit"
                  disabled={!answerHasText}
                  onConfirm={() => onSave(row, answerRef.current?.value ?? "")}
                  clock={holdClock}
                >
                  save &amp; mark answered
                </HoldButton>
                {fieldToString(row.item.fields[RECOMMENDATION_FIELD]).trim().length > 0 && (
                  <HoldButton
                    data-testid="batch-answer-as-recommended"
                    disabled={answerHasText}
                    onConfirm={() => onSave(row, AS_RECOMMENDED_ANSWER)}
                    clock={holdClock}
                  >
                    as recommended
                  </HoldButton>
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
   * When provided (non-empty), renders a status badge using the shared
   * `lw-status lw-status-<bucket>` class derived from MILESTONES_SCHEMA.
   * Passed for both active and archived milestone groups; absent or empty means
   * no badge renders.
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
 * Renders the item table, in one of three layouts:
 *
 * - non-milestones: per-milestone collapsible SUBSECTIONS (header = id + title +
 *   status, in fetch_ledger order); the per-row milestone column is omitted.
 * - milestones (isMilestones): flat table with the milestone column — sub-
 *   grouping by milestone is not meaningful there.
 * - goals (isGoals; T83 / Q48, user-deviated): FLAT list, no coordination-
 *   milestone subsections and no milestone column — a goal's work-milestone ids
 *   live in fields.milestones and show in the detail panel. Reuses
 *   SubsectionItemTable so row structure/classes match the other ledgers.
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
  archivePointers = [],
  showArchive = false,
  onSelectArchive,
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
  /** Archived milestone pointers — only used when isMilestones=true. */
  archivePointers?: Array<{ id: string; path: string; summary: string; title: string; status: string }>;
  /** Whether to show archived rows (from the toggle-archive button). */
  showArchive?: boolean;
  /** Called when an archived row is clicked. */
  onSelectArchive?: (pointer: { id: string; path: string; summary: string; title: string; status: string }) => void;
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
    const visibleArchived = showArchive ? archivePointers : [];
    if (rows.length === 0 && visibleArchived.length === 0)
      return <p className="lw-empty">(no items)</p>;
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
          {visibleArchived.map((p) => (
            <tr
              key={`archive-${p.id}`}
              data-testid={`item-${p.id}`}
              className="lw-row lw-row-terminal"
              onClick={() => onSelectArchive?.(p)}
            >
              <td>—</td>
              <td>{p.id}</td>
              <td>
                {p.status.length > 0 && (
                  <span
                    className={`lw-status lw-status-${statusBucket(p.status, MILESTONES_SCHEMA)}`}
                    data-testid={`status-${p.id}`}
                  >
                    {p.status}
                  </span>
                )}
              </td>
              <td className="lw-summary-cell">
                {p.title.length > 0 ? p.title : p.id}
              </td>
              {extraColumns.map((c) => (
                <td key={c} data-testid={`cell-${p.id}-${c}`} />
              ))}
            </tr>
          ))}
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
              {...(p.status.length > 0 ? { milestoneStatus: p.status } : {})}
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
  holdClock,
  onReadLog,
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
  /** Injectable HoldClock for tests; defaults to the real browser clock. */
  holdClock?: HoldClock | undefined;
  /** Callback to read a log file via the read_log MCP tool. */
  onReadLog?: (path: string) => Promise<import("./types.js").ReadLogResult>;
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
  // answer textarea; gates the 'save & mark answered' button (must have text)
  // and the 'as recommended' / per-suggestion 'pick' buttons (must NOT have
  // text, to avoid clobbering a draft) (T88 / Web #15, D29).
  const [answerHasText, setAnswerHasText] = useState(
    () => fieldToString(row.item.fields[ANSWER_FIELD]).trim().length > 0,
  );

  // Reset to the initial mode + values whenever the row changes (a different
  // item loads, or a fresh create session starts → blank draft row).
  useEffect(() => {
    setEditing(isDraft);
    setStatus(row.item.status);
    setAnswerHasText(fieldToString(row.item.fields[ANSWER_FIELD]).trim().length > 0);
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
            <HoldButton data-testid="save" onConfirm={save} clock={holdClock}>
              {isDraft ? "create" : "save"}
            </HoldButton>
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
  // map, the legal next statuses become one-click buttons (terminal → `[]` →
  // none); when absent (null), only the status editor is offered. Each button
  // issues a status-only patch preserving the item's current fields.
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
  // (T23); non-questions keep the top answer box + short-first order.
  const isQ = !isMilestones && isQuestion(schema);
  // Goals (T83 / Q48): show work-milestone ids (fields.milestones) as a list
  // instead of the coordination-milestone (row.milestoneId); the field is lifted
  // out of the generic field list below so it is not rendered twice.
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
        <HoldButton data-testid="answer-submit" disabled={!answerHasText} onConfirm={submitAnswer} clock={holdClock}>
          save &amp; mark answered
        </HoldButton>
        {hasRecommendation && (
          <HoldButton
            data-testid="answer-as-recommended"
            disabled={answerHasText}
            onConfirm={() => answerWith(AS_RECOMMENDED_ANSWER)}
            clock={holdClock}
          >
            as recommended
          </HoldButton>
        )}
      </div>
    </div>
  );

  // Question field rendering (Q31 ANSWER): metadata trio (milestone, status, by)
  // first, then any other metadata, then the narrative question → context →
  // suggestions → recommendation (highlighted) → answer (editable box when
  // answerable, else the stored value). Owns the whole question <dl> body — the
  // outer dl does not repeat status/milestone/by.
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
                        <HoldButton
                          className="lw-pick-suggestion"
                          data-testid={`answer-pick-suggestion-${i}`}
                          disabled={answerHasText}
                          onConfirm={() => answerWith(item)}
                          clock={holdClock}
                        >
                          pick
                        </HoldButton>
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
        {transitionTargets.length > 0 && onSave !== undefined && !isArchived && (
          <>
            <dt>transition to</dt>
            <dd>
              <div className="lw-transitions" data-testid="transitions">
                {transitionTargets.map((target) => (
                  <HoldButton
                    key={target}
                    className={`lw-transition lw-status-${statusBucket(target, schema)}`}
                    data-testid={`transition-${target}`}
                    onConfirm={() => onSave(target, row.item.fields as Record<string, FieldValue>)}
                    clock={holdClock}
                  >
                    {target}
                  </HoldButton>
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
            {transitionTargets.length > 0 && onSave !== undefined && !isArchived && (
              <>
                <dt>transition to</dt>
                <dd>
                  <div className="lw-transitions" data-testid="transitions">
                    {transitionTargets.map((target) => (
                      <HoldButton
                        key={target}
                        className={`lw-transition lw-status-${statusBucket(target, schema)}`}
                        data-testid={`transition-${target}`}
                        onConfirm={() =>
                          onSave(target, row.item.fields as Record<string, FieldValue>)
                        }
                        clock={holdClock}
                      >
                        {target}
                      </HoldButton>
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
      {/* Research → linked hypothesis tree panel (T561, G80/M246, Q262) */}
      {ledger === RESEARCHES_LEDGER && !isDraft && (
        <ResearchHypothesisTreePanel
          researchId={row.item.id}
          hypotheses={auxItems?.[HYPOTHESIS_LEDGER] ?? []}
          onNavigate={(id) => onNavigateToItem?.(HYPOTHESIS_LEDGER, id)}
        />
      )}
      {/* Session logs panel */}
      {!isDraft && onReadLog !== undefined && (
        <SessionLogsPanel item={row.item} onReadLog={onReadLog} />
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

/**
 * Renders the FULL linked hypothesis tree for a selected `researches` item
 * (T561, G80/M246, Q262): every hypothesis whose `ledgerRefs` contains
 * `researches:<researchId>` (the investigate-flow convention of tagging every
 * node in the tree with the owning ref — see
 * `nix/pkg/cq-assets/commands/cq/investigate/advance.md`), nested into a
 * forest by `parentHypothesis` via the shared `hypothesisForest` helper.
 * Unlike `HypothesisTreePanel` (a single hypothesis's ancestry + direct
 * children), this shows every linked node at every depth, since a research
 * may have multiple root hypotheses.
 */
function ResearchHypothesisTreePanel({
  researchId,
  hypotheses,
  onNavigate,
}: {
  researchId: string;
  hypotheses: readonly Item[];
  onNavigate: (hypothesisId: string) => void;
}): React.ReactElement | null {
  const linked = hypothesesLinkedToRef(`researches:${researchId}`, hypotheses);
  if (linked.length === 0) return null;
  const forest = hypothesisForest(linked);

  const byId = new Map<string, Item>();
  for (const h of linked) byId.set(h.id, h);

  const renderNode = (node: HypothesisForestNode): React.ReactElement => {
    const item = byId.get(node.id);
    return (
      <li key={node.id}>
        <button
          type="button"
          className="lw-rel-row"
          data-testid={`research-hyp-${node.id}`}
          onClick={() => onNavigate(node.id)}
        >
          <span className="lw-rel-id">{node.id}</span>
          {item !== undefined && (
            <>
              <span className={`lw-status lw-status-${item.status}`} data-testid={`research-hyp-status-${node.id}`}>
                {item.status}
              </span>
              <span className="lw-rel-summary lw-dim">{summarize(item)}</span>
            </>
          )}
        </button>
        {node.children.length > 0 && (
          <ul className="lw-rel-list">{node.children.map(renderNode)}</ul>
        )}
      </li>
    );
  };

  return (
    <section className="lw-rel-section" data-testid="research-hypothesis-tree-section">
      <h4 className="lw-rel-heading">Hypothesis tree</h4>
      <ul className="lw-rel-list" data-testid="research-hypothesis-tree">
        {forest.map(renderNode)}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Session-log popup (T152 / Q87)
// ---------------------------------------------------------------------------

/**
 * How the modal renders a successfully-read log:
 * - "markdown": the existing summary/plain path (a `<Markdown>` blob);
 * - "rawlog": a `.jsonl` transcript parsed by `parseRawLog` and rendered as a
 *   structured, collapsible conversation (T414).
 * The format is decided at open time (by file extension), so it is threaded
 * through every non-closed state.
 */
type LogFormat = "markdown" | "rawlog";

/** State for the log-content modal. */
type LogModalState =
  | { kind: "closed" }
  | { kind: "loading"; path: string; format: LogFormat }
  | { kind: "ok"; path: string; content: string; truncated: boolean; format: LogFormat }
  | { kind: "error"; path: string; message: string; format: LogFormat };

/**
 * Modal overlay that renders a single log file's content (preformatted).
 * Closes on the ✕ button, on Escape, or on backdrop click.
 */
function LogModal({ state, onClose }: { state: LogModalState; onClose: () => void }): React.ReactElement | null {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );
  useEffect(() => {
    if (state.kind === "closed") return;
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [state.kind, handleKey]);

  const logBackdropProps = useBackdropDismiss(onClose);
  if (state.kind === "closed") return null;

  return (
    <div
      className="lw-modal-backdrop"
      data-testid="log-modal-backdrop"
      {...logBackdropProps}
    >
      <div
        className="lw-modal"
        data-testid="log-modal"
        role="dialog"
        aria-label={`log: ${state.path}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lw-modal-head">
          <span className="lw-modal-title" data-testid="log-modal-path">{state.path}</span>
          <button type="button" className="lw-close" data-testid="log-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="lw-modal-body">
          {state.kind === "loading" && (
            <span className="lw-dim" data-testid="log-modal-loading">loading…</span>
          )}
          {state.kind === "error" && (
            <span className="lw-error" data-testid="log-modal-error">{state.message}</span>
          )}
          {state.kind === "ok" && state.format === "markdown" && (
            <>
              {state.truncated && (
                <p className="lw-dim lw-log-truncated" data-testid="log-modal-truncated">
                  (log truncated — file exceeds the read cap)
                </p>
              )}
              <div className="lw-log-content" data-testid="log-modal-content"><Markdown text={state.content} /></div>
            </>
          )}
          {state.kind === "ok" && state.format === "rawlog" && (
            <RawLogViewer content={state.content} truncated={state.truncated} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Human-facing role label for a conversation turn. */
function turnRoleLabel(kind: ConversationTurn["kind"]): string {
  switch (kind) {
    case "assistant":
      return "assistant";
    case "user":
      return "user";
    case "tool_use":
      return "tool call";
    case "tool_result":
      return "tool result";
    case "raw":
      return "raw";
  }
}

/**
 * Render one conversation turn (T414). Text turns (assistant/user) show a role
 * label + the text. Tool turns (tool_use / tool_result) and raw lines are
 * COLLAPSIBLE — rendered as `<details>` so a long transcript stays scannable;
 * the summary carries the role + tool name, the body the pretty-printed args /
 * result / raw line.
 */
function RawLogTurn({ turn }: { turn: ConversationTurn }): React.ReactElement {
  const label = turnRoleLabel(turn.kind);
  if (turn.kind === "assistant" || turn.kind === "user") {
    return (
      <div className={`lw-raw-turn lw-raw-turn-${turn.kind}`} data-testid={`raw-turn-${turn.kind}`}>
        <span className="lw-raw-role" data-testid="raw-turn-role">{label}</span>
        <div className="lw-raw-text"><Markdown text={turn.text} /></div>
      </div>
    );
  }
  // Collapsible turns: tool_use, tool_result, raw.
  const summary =
    turn.kind === "tool_use"
      ? `${label}: ${turn.toolName}`
      : turn.kind === "tool_result"
        ? `${label}${turn.pairedToolName !== null ? `: ${turn.pairedToolName}` : ""}${turn.isError ? " (error)" : ""}`
        : `${label} (${turn.reason})`;
  const body =
    turn.kind === "tool_use"
      ? turn.inputPretty
      : turn.kind === "tool_result"
        ? turn.resultPretty
        : turn.raw;
  return (
    <details className={`lw-raw-turn lw-raw-turn-${turn.kind}`} data-testid={`raw-turn-${turn.kind}`}>
      <summary className="lw-raw-role" data-testid="raw-turn-role">{summary}</summary>
      <pre className="lw-raw-pre" data-testid="raw-turn-body">{body}</pre>
    </details>
  );
}

/**
 * Structured, collapsible conversation view for a `.jsonl` raw transcript
 * (T414). Parses the raw content with the T412 `parseRawLog` and renders each
 * turn; tool calls/results are collapsible. A truncated read shows a banner.
 */
function RawLogViewer({ content, truncated }: { content: string; truncated: boolean }): React.ReactElement {
  const model: ConversationModel = useMemo(() => parseRawLog(content, truncated), [content, truncated]);
  return (
    <div className="lw-raw-log" data-testid="raw-log-viewer">
      {model.truncatedNotice !== null && (
        <p className="lw-dim lw-log-truncated" data-testid="raw-log-truncated">
          (log {model.truncatedNotice})
        </p>
      )}
      {model.turns.map((turn, i) => (
        <RawLogTurn key={`${turn.lineIndex}-${i}`} turn={turn} />
      ))}
    </div>
  );
}

/** Filename stem (basename without its final extension) for raw/summary pairing. */
function logStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Renders the `sessionLogs` field of an item as a labeled section of clickable
 * links. Each link opens `LogModal` and fetches the file via `onReadLog`.
 * When the item has no `sessionLogs` (or the array is empty), renders nothing.
 */
function SessionLogsPanel({
  item,
  onReadLog,
}: {
  item: Item;
  onReadLog: (path: string) => Promise<import("./types.js").ReadLogResult>;
}): React.ReactElement | null {
  const raw = item.fields["sessionLogs"];
  const paths: string[] = Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [];
  // Paired raw transcripts (Q220): an explicit `rawLogs` string[] field, NOT
  // probed/inferred. A summary entry exposes a "raw" toggle only when a
  // rawLogs entry shares its filename stem.
  const rawRaw = item.fields["rawLogs"];
  const rawPaths: string[] = Array.isArray(rawRaw) ? rawRaw.filter((v) => typeof v === "string") : [];
  const rawByStem = new Map<string, string>();
  for (const rp of rawPaths) rawByStem.set(logStem(rp), rp);
  const [modal, setModal] = useState<LogModalState>({ kind: "closed" });

  if (paths.length === 0) return null;

  const open = (path: string, format: LogFormat): void => {
    setModal({ kind: "loading", path, format });
    void onReadLog(path)
      .then((r) =>
        setModal({
          kind: "ok",
          path: r.path,
          content: r.content,
          truncated: r.truncated === true,
          format,
        }),
      )
      .catch((err: unknown) =>
        setModal({
          kind: "error",
          path,
          message: err instanceof Error ? err.message : String(err),
          format,
        }),
      );
  };

  return (
    <>
      <section className="lw-rel-section" data-testid="session-logs-section">
        <h4 className="lw-rel-heading">logs</h4>
        <ul className="lw-rel-list">
          {paths.map((p) => {
            const rawPath = rawByStem.get(logStem(p));
            // A .jsonl raw transcript renders via the T412 parser (structured,
            // collapsible conversation); any other extension (pi .md) opens via
            // the existing markdown modal path.
            const rawFormat: LogFormat = rawPath !== undefined && rawPath.endsWith(".jsonl") ? "rawlog" : "markdown";
            return (
              <li key={p}>
                <button
                  type="button"
                  className="lw-log-link"
                  data-testid={`log-link-${p}`}
                  onClick={() => open(p, "markdown")}
                >
                  {p}
                </button>
                {rawPath !== undefined && (
                  <button
                    type="button"
                    className="lw-log-raw-toggle"
                    data-testid={`log-raw-toggle-${p}`}
                    title={rawPath}
                    onClick={() => open(rawPath, rawFormat)}
                  >
                    raw
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      <LogModal state={modal} onClose={() => setModal({ kind: "closed" })} />
    </>
  );
}

function CreateMilestoneForm({
  onCreate,
  onCancel,
  holdClock,
}: {
  onCreate: (title: string) => void;
  onCancel: () => void;
  holdClock?: HoldClock | undefined;
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
      <HoldButton data-testid="ms-create" onConfirm={go} clock={holdClock}>
        create
      </HoldButton>
      <button type="button" onClick={onCancel}>
        cancel
      </button>
    </form>
  );
}

