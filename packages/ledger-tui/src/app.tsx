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

import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { SelectList } from "./components/SelectList.js";
import { TextPrompt } from "./components/TextPrompt.js";
import { Markdown } from "./markdownText.js";
import { useTermSize } from "./useTermSize.js";
import { LiveManager, type LiveStats } from "@cq/ledger-live";
import {
  statusColor,
  isTerminal,
  statusMatchesFilter,
  filterLabel,
  type StatusFilter,
} from "./status.js";
import type { FetchedLedger, FieldValue, FtsHit, Item, LedgerClient, LedgerSchema } from "./types.js";

const MILESTONES = "milestones";
/** Provenance author stamped on writes made by a human through this editor. */
const UI_AUTHOR = "user";

/** List/detail split: orientation + the list pane's fraction of the body. */
type PanelOrientation = "right" | "bottom";
interface PanelLayout {
  orientation: PanelOrientation;
  ratio: number;
}
const PANEL_DEFAULT: PanelLayout = { orientation: "right", ratio: 0.5 };
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
function summarize(item: Item): string {
  const f = item.fields;
  const pick = f["headline"] ?? f["title"] ?? f["question"] ?? f["summary"] ?? Object.values(f)[0];
  return fieldToString(pick as FieldValue | undefined);
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
function parseFieldValue(raw: string, type: string): FieldValue {
  if (type === "string[]" || type === "id[]") {
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
    };

type Overlay =
  | { t: "search" }
  | { t: "status"; row: Row }
  | { t: "pickField"; row: Row }
  | { t: "editField"; row: Row; field: string }
  | { t: "editTitle"; row: Row }
  | { t: "createMilestone" }
  | { t: "createItem"; milestones: Item[] }
  | { t: "filter" };

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App({
  client,
  liveUrl = null,
  liveWsCtor,
}: {
  client: LedgerClient;
  liveUrl?: string | null;
  liveWsCtor?: { new (url: string): WebSocket };
}): React.ReactElement {
  const { exit } = useApp();
  const { cols, rows } = useTermSize();
  const [conn, setConn] = useState<"connecting" | "connected" | "error">("connecting");
  const [connErr, setConnErr] = useState("");
  const [ledgers, setLedgers] = useState<string[]>([]);
  const [stack, setStack] = useState<Frame[]>([{ kind: "ledgers", cursor: 0 }]);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [flash, setFlash] = useState("");
  const [live, setLive] = useState<LiveStats | null>(null);
  const [filter, setFilter] = useState<StatusFilter>({ kind: "all" });
  const [panel, setPanel] = useState<PanelLayout>(PANEL_DEFAULT);
  const refreshRef = React.useRef<() => void>(() => {});

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

  // Rows of an items view after the active status filter. The cursor indexes
  // into THIS list, so every input/render path must use it (not raw rows).
  const visibleRows = useCallback(
    (view: FetchedLedger): Row[] =>
      ledgerRows(view).filter((r) => statusMatchesFilter(r.item.status, view.schema, filter)),
    [filter],
  );

  const openLedger = useCallback(
    async (name: string) => {
      try {
        const view = await client.fetchLedger(name);
        setStack((s) => [...s, { kind: "items", ledger: name, view, cursor: 0, focus: "list", scroll: 0 }]);
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

  // Live updates: connect to the server's /ws, refetch the current frame on a
  // pushed change, and expose health to the status bar.
  useEffect(() => {
    if (liveUrl === null) return;
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
  }, [liveUrl, liveWsCtor]);

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
          { kind: "ledgers", cursor: Math.max(0, ledgers.indexOf(hit.ledgerId)) },
          { kind: "items", ledger: hit.ledgerId, view, cursor: idx, focus: "list", scroll: 0 },
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
          const name = ledgers[top.cursor];
          if (name !== undefined) void openLedger(name);
        } else if (input === "/") setOverlay({ t: "search" });
        else if (input === "q") exit();
        return;
      }
      // items frame
      const rowsArr = visibleRows(top.view);
      const cur = rowsArr[top.cursor];
      if (top.focus === "content") {
        if (key.upArrow || input === "k") patchTop({ scroll: Math.max(0, top.scroll - 1) });
        else if (key.downArrow || input === "j") patchTop({ scroll: top.scroll + 1 });
        else if (key.escape) patchTop({ focus: "list", scroll: 0 });
        else if (input === "s" && cur) setOverlay({ t: "status", row: cur });
        else if (input === "e" && cur)
          setOverlay(isMilestonesLedger ? { t: "editTitle", row: cur } : { t: "pickField", row: cur });
        return;
      }
      // focus === list
      if (key.upArrow || input === "k") patchTop({ cursor: Math.max(0, top.cursor - 1) });
      else if (key.downArrow || input === "j")
        patchTop({ cursor: Math.min(rowsArr.length - 1, top.cursor + 1) });
      else if (key.return) {
        if (cur) patchTop({ focus: "content", scroll: 0 });
      } else if (key.escape) setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
      else if (input === "n") void beginCreate();
      else if (input === "s" && cur) setOverlay({ t: "status", row: cur });
      else if (input === "e" && cur)
        setOverlay(isMilestonesLedger ? { t: "editTitle", row: cur } : { t: "pickField", row: cur });
      else if (input === "f") setOverlay({ t: "filter" });
      else if (input === "/") setOverlay({ t: "search" });
    },
    { isActive: true },
  );

  // ---- derived for render ------------------------------------------------
  const bodyRows = Math.max(3, rows - 2); // minus header + status bar
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
    listEl = (
      <ScrollList
        items={ledgers}
        getLabel={(l) => l}
        cursor={top.cursor}
        height={listInnerH}
        active={overlay === null}
      />
    );
    const sel = ledgers[top.cursor];
    contentEl = (
      <Box flexDirection="column">
        <Text bold color="green">
          {sel ?? ""}
        </Text>
        <Text dimColor>Press Enter to open this ledger.</Text>
      </Box>
    );
  } else {
    const rowsArr = visibleRows(top.view);
    const cur = rowsArr[top.cursor];
    const schema = top.view.schema;
    const fLabel = filterLabel(filter);
    pathStr =
      cur !== undefined ? `${top.ledger} → ${cur.milestoneId} → ${cur.item.id}` : top.ledger;
    if (fLabel.length > 0) pathStr += `  [${fLabel}]`;
    hints =
      top.focus === "content"
        ? "↑↓ scroll · s status · e edit · o/[ ] panes · Esc back to list"
        : "↑↓ move · Enter open · s status · e edit · n new · f filter · / search · o/[ ] panes · Esc back";
    listEl = (
      <ScrollList
        items={rowsArr}
        getLabel={(r) => `${r.item.id} [${r.item.status}] ${summarize(r.item)}`}
        renderLabel={(r) => (
          <ItemRowLabel
            id={r.item.id}
            status={r.item.status}
            summary={summarize(r.item)}
            schema={schema}
          />
        )}
        cursor={top.cursor}
        height={listInnerH}
        active={overlay === null && top.focus === "list"}
        emptyLabel={filter.kind === "all" ? "(no items — press n)" : "(no items match filter — f)"}
      />
    );
    contentEl =
      cur !== undefined ? (
        <ContentPane
          row={cur}
          ledger={top.ledger}
          schema={schema}
          width={contentInnerW}
          height={contentInnerH}
          scroll={top.scroll}
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
          ledger-tui
        </Text>
        <Text dimColor>
          {"  "}
          {conn === "connected" ? "● " : conn === "connecting" ? "○ " : "✕ "}
          {conn === "error" ? `error: ${connErr}` : pathStr}
        </Text>
        {liveUrl !== null && <LiveBadge stats={live} />}
      </Box>

      {/* body: list | content — split right (row) or bottom (column) */}
      <Box flexGrow={1} flexDirection={horizontal ? "row" : "column"}>
        <Box
          {...(horizontal ? { width: listOuterW } : { height: listOuterH })}
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          {listEl}
        </Box>
        <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor={top.kind === "items" && top.focus === "content" ? "cyan" : "gray"} paddingX={1}>
          {overlay !== null ? (
            <Overlays
              overlay={overlay}
              view={top.kind === "items" ? top.view : null}
              onStatus={applyStatus}
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
              setOverlay={setOverlay}
              onCancel={() => setOverlay(null)}
            />
          ) : (
            contentEl
          )}
        </Box>
      </Box>

      {/* status bar */}
      <Box>
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
 * One item row: `id [status] summary`, with the status badge colored by its
 * semantic bucket and the whole row dimmed when the item is terminal (so
 * closed work recedes). `author` provenance is shown as a trailing tag.
 */
function ItemRowLabel({
  id,
  status,
  summary,
  schema,
}: {
  id: string;
  status: string;
  summary: string;
  schema: LedgerSchema;
}): React.ReactElement {
  const terminal = isTerminal(status, schema);
  const color = statusColor(status, schema);
  return (
    <Text dimColor={terminal}>
      {id} <Text color={color}>[{status}]</Text> {summary}
    </Text>
  );
}

function ScrollList<T>({
  items,
  getLabel,
  renderLabel,
  cursor,
  height,
  active,
  emptyLabel = "(empty)",
}: {
  items: readonly T[];
  getLabel: (item: T, index: number) => string;
  /** Optional rich (colored) label; falls back to getLabel's plain string. */
  renderLabel?: (item: T, index: number) => React.ReactNode;
  cursor: number;
  height: number;
  active: boolean;
  emptyLabel?: string;
}): React.ReactElement {
  if (items.length === 0) return <Text dimColor>{emptyLabel}</Text>;
  const n = items.length;
  const h = Math.max(1, height);
  let topIdx = 0;
  if (cursor >= h) topIdx = Math.min(cursor - h + 1, Math.max(0, n - h));
  topIdx = Math.max(0, Math.min(topIdx, Math.max(0, n - h)));
  const win = items.slice(topIdx, topIdx + h);

  // scrollbar thumb
  const showBar = n > h;
  const thumbSize = showBar ? Math.max(1, Math.round((h / n) * h)) : 0;
  const thumbStart = showBar ? Math.min(h - thumbSize, Math.round((topIdx / (n - h)) * (h - thumbSize))) : 0;

  return (
    <Box flexDirection="row">
      <Box flexDirection="column" flexGrow={1}>
        {win.map((it, idx) => {
          const i = topIdx + idx;
          const sel = i === cursor;
          return (
            <Text key={i} inverse={sel && active} {...(sel && !active ? { color: "cyan" as const } : {})} wrap="truncate-end">
              {sel ? "› " : "  "}
              {renderLabel !== undefined ? renderLabel(it, i) : getLabel(it, i)}
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

function estimateLines(value: string, width: number): number {
  const w = Math.max(8, width - 2);
  return value.split("\n").reduce((acc, line) => acc + Math.max(1, Math.ceil(line.length / w)), 0);
}

function ContentPane({
  row,
  ledger,
  schema,
  width,
  height,
  scroll,
}: {
  row: Row;
  ledger: string;
  schema: LedgerSchema;
  width: number;
  height: number;
  scroll: number;
}): React.ReactElement {
  const f = row.item.fields;
  const entries = orderItemFields(Object.entries(f) as Array<[string, FieldValue]>);
  const { author, session } = row.item;
  const hasProvenance = author !== undefined || session !== undefined;
  // Estimate total height to clamp scrolling: short fields are one line each;
  // long fields are a header line + their wrapped body + a top margin.
  let est = 4 + (hasProvenance ? 1 : 0); // header + status + milestone + timestamps (+ provenance)
  for (const [, v] of entries) {
    est += isShortField(v) ? 1 : 2 + estimateLines(fieldToString(v), width);
  }
  const maxScroll = Math.max(0, est - height);
  const clamped = Math.min(scroll, maxScroll);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box flexDirection="column" marginTop={-clamped}>
        <Text>
          <Text bold>{row.item.id}</Text>
          <Text dimColor> @ {ledger}</Text>
          {"  "}
          <Text color={statusColor(row.item.status, schema)}>{row.item.status}</Text>
        </Text>
        <Text dimColor>
          milestone {row.milestoneId} · created {row.item.createdAt.slice(0, 10)} · updated{" "}
          {row.item.updatedAt.slice(0, 10)}
        </Text>
        {hasProvenance && (
          <Text dimColor>
            by {author ?? "?"}
            {session !== undefined ? ` · session ${session}` : ""}
          </Text>
        )}
        {entries.length === 0 ? (
          <Text dimColor>(no fields)</Text>
        ) : (
          entries.map(([k, v]) =>
            isShortField(v) ? (
              // Short/fixed-size field: render inline on a single line.
              <Text key={k}>
                <Text bold color="gray">
                  {k}:{" "}
                </Text>
                {fieldToString(v)}
              </Text>
            ) : (
              // Long field (description, etc.): header + markdown block.
              <Box key={k} flexDirection="column" marginTop={1}>
                <Text bold color="gray">
                  {k}
                </Text>
                {Array.isArray(v) ? <Text>{v.join(", ")}</Text> : <Markdown text={v} />}
              </Box>
            ),
          )
        )}
      </Box>
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
// Overlays (edit / create / search) — own input while mounted
// ---------------------------------------------------------------------------

function Overlays({
  overlay,
  view,
  onStatus,
  onField,
  onTitle,
  search,
  onOpenHit,
  onCreateMilestone,
  onCreateItem,
  onFilter,
  setOverlay,
  onCancel,
}: {
  overlay: Overlay;
  view: FetchedLedger | null;
  onStatus: (row: Row, status: string) => void;
  onField: (row: Row, field: string, value: string) => void;
  onTitle: (row: Row, title: string) => void;
  search: (q: string) => Promise<FtsHit[]>;
  onOpenHit: (h: FtsHit) => void;
  onCreateMilestone: (title: string) => void;
  onCreateItem: (milestoneId: string, status: string, fields: Record<string, FieldValue>) => void;
  onFilter: (f: StatusFilter) => void;
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
    case "status":
      return (
        <SelectList
          items={view?.schema.statusValues ?? []}
          getLabel={(s) => s}
          onSelect={(s) => onStatus(overlay.row, s)}
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
  }
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
