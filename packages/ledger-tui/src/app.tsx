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
import type { FetchedLedger, FieldValue, FtsHit, Item, LedgerClient } from "./types.js";

const MILESTONES = "milestones";
const LIST_WIDTH = 34;
/** Provenance author stamped on writes made by a human through this editor. */
const UI_AUTHOR = "user";

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
  | { t: "searchResults"; hits: FtsHit[] }
  | { t: "status"; row: Row }
  | { t: "pickField"; row: Row }
  | { t: "editField"; row: Row; field: string }
  | { t: "editTitle"; row: Row }
  | { t: "createMilestone" }
  | { t: "createItem"; milestones: Item[] };

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

  const openLedger = useCallback(
    async (name: string) => {
      try {
        const view = await client.fetchLedger(name);
        setStack((s) => [...s, { kind: "items", ledger: name, view, cursor: 0, focus: "list", scroll: 0 }]);
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

  const runSearch = useCallback(
    async (query: string) => {
      if (query.trim().length === 0) {
        setOverlay(null);
        return;
      }
      try {
        const hits = await client.ftsSearch(query);
        setFlash(`${hits.length} hit(s) for "${query}"`);
        setOverlay({ t: "searchResults", hits });
      } catch (e) {
        setFlash(errMsg(e));
        setOverlay(null);
      }
    },
    [client],
  );

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
      const rowsArr = ledgerRows(top.view);
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
      else if (input === "/") setOverlay({ t: "search" });
    },
    { isActive: true },
  );

  // ---- derived for render ------------------------------------------------
  const bodyHeight = Math.max(3, rows - 2); // minus header + status bar
  const contentWidth = Math.max(20, cols - LIST_WIDTH - 3);

  let pathStr: string;
  let hints: string;
  let listEl: React.ReactElement;
  let contentEl: React.ReactElement;

  if (top.kind === "ledgers") {
    pathStr = "all ledgers";
    hints = "↑↓ move · Enter open · / search · q quit";
    listEl = (
      <ScrollList
        items={ledgers}
        getLabel={(l) => l}
        cursor={top.cursor}
        height={bodyHeight}
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
    const rowsArr = ledgerRows(top.view);
    const cur = rowsArr[top.cursor];
    pathStr =
      cur !== undefined ? `${top.ledger} → ${cur.milestoneId} → ${cur.item.id}` : top.ledger;
    hints =
      top.focus === "content"
        ? "↑↓ scroll · s status · e edit · Esc back to list"
        : "↑↓ move · Enter open · s status · e edit · n new · / search · Esc back";
    listEl = (
      <ScrollList
        items={rowsArr}
        getLabel={(r) => `${r.item.id} [${r.item.status}] ${summarize(r.item)}`}
        cursor={top.cursor}
        height={bodyHeight}
        active={overlay === null && top.focus === "list"}
        emptyLabel="(no items — press n)"
      />
    );
    contentEl =
      cur !== undefined ? (
        <ContentPane row={cur} ledger={top.ledger} width={contentWidth} height={bodyHeight} scroll={top.scroll} />
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

      {/* body: list | content */}
      <Box flexGrow={1} flexDirection="row">
        <Box width={LIST_WIDTH} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
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
              onSearch={runSearch}
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

function ScrollList<T>({
  items,
  getLabel,
  cursor,
  height,
  active,
  emptyLabel = "(empty)",
}: {
  items: readonly T[];
  getLabel: (item: T, index: number) => string;
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
              {getLabel(it, i)}
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
  width,
  height,
  scroll,
}: {
  row: Row;
  ledger: string;
  width: number;
  height: number;
  scroll: number;
}): React.ReactElement {
  const f = row.item.fields;
  const entries = Object.entries(f);
  // Estimate total height to clamp scrolling.
  let est = 4; // header + status + milestone + timestamps
  for (const [, v] of entries) est += 1 + estimateLines(fieldToString(v as FieldValue), width);
  const maxScroll = Math.max(0, est - height);
  const clamped = Math.min(scroll, maxScroll);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box flexDirection="column" marginTop={-clamped}>
        <Text>
          <Text bold>{row.item.id}</Text>
          <Text dimColor> @ {ledger}</Text>
          {"  "}
          <Text color="cyan">{row.item.status}</Text>
        </Text>
        <Text dimColor>
          milestone {row.milestoneId} · created {row.item.createdAt.slice(0, 10)} · updated{" "}
          {row.item.updatedAt.slice(0, 10)}
        </Text>
        {entries.length === 0 ? (
          <Text dimColor>(no fields)</Text>
        ) : (
          entries.map(([k, v]) => (
            <Box key={k} flexDirection="column" marginTop={1}>
              <Text bold color="gray">
                {k}
              </Text>
              {Array.isArray(v) ? <Text>{v.join(", ")}</Text> : <Markdown text={v} />}
            </Box>
          ))
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
  onSearch,
  onOpenHit,
  onCreateMilestone,
  onCreateItem,
  setOverlay,
  onCancel,
}: {
  overlay: Overlay;
  view: FetchedLedger | null;
  onStatus: (row: Row, status: string) => void;
  onField: (row: Row, field: string, value: string) => void;
  onTitle: (row: Row, title: string) => void;
  onSearch: (q: string) => void;
  onOpenHit: (h: FtsHit) => void;
  onCreateMilestone: (title: string) => void;
  onCreateItem: (milestoneId: string, status: string, fields: Record<string, FieldValue>) => void;
  setOverlay: (o: Overlay | null) => void;
  onCancel: () => void;
}): React.ReactElement {
  switch (overlay.t) {
    case "search":
      return <TextPrompt label="search:" onSubmit={onSearch} onCancel={onCancel} />;
    case "searchResults":
      return (
        <SelectList
          items={overlay.hits}
          getLabel={(h) => `${h.ledgerId}/${h.item.id} [${h.item.status}] ${summarize(h.item)}`}
          onSelect={(h) => onOpenHit(h)}
          onCancel={onCancel}
          emptyLabel="(no hits)"
        />
      );
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
