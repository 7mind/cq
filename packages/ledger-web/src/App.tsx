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

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { FetchedLedger, FieldValue, FtsHit, Item, LedgerClient, MilestonePatch } from "./types.js";
import { DagView } from "./DagView.js";
import { Markdown } from "./Markdown.js";
import { loadDagData, type DagData } from "./dagData.js";
import { LiveManager, type LiveStats } from "@cq/ledger-live";

const MILESTONES = "milestones";
/** Provenance author stamped on writes made by a human through this editor. */
const UI_AUTHOR = "user";

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
  const urlRef = useRef<HTMLInputElement>(null);
  const [client, setClient] = useState<LedgerClient | null>(null);
  const [conn, setConn] = useState<"connecting" | "connected" | "error">("connecting");
  const [connErr, setConnErr] = useState("");
  const [ledgers, setLedgers] = useState<string[]>([]);
  const [ledger, setLedger] = useState<string | null>(null);
  const [view, setView] = useState<FetchedLedger | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [hits, setHits] = useState<FtsHit[] | null>(null);
  const [creating, setCreating] = useState<"item" | "milestone" | null>(null);
  const [flash, setFlash] = useState("");
  const [mainView, setMainView] = useState<"ledger" | "dag">("ledger");
  const [dag, setDag] = useState<DagData | null>(null);
  const [panel, setPanel] = useState<PanelLayout>(loadPanel);
  const [dragging, setDragging] = useState(false);
  const workareaRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<LiveStats | null>(null);
  // Latest-callback ref: the live connection lives across ledger changes, so
  // its onChanged must call the freshest refresh closure, not a stale one.
  const refreshRef = useRef<() => void>(() => {});

  // Persist panel layout.
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify(panel));
    } catch {
      /* ignore (e.g. storage disabled) */
    }
  }, [panel]);

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

  const runSearch = useCallback(
    async (query: string) => {
      if (client === null || query.trim().length === 0) return;
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

  // ---- render ------------------------------------------------------------
  return (
    <div className="lw-root">
      <header className="lw-header">
        <span className="lw-title">ledger-web</span>
        <span className={`lw-conn lw-conn-${conn}`} data-testid="conn-status">
          {conn === "connected" ? "● connected" : conn === "connecting" ? "○ connecting…" : "✕ error"}
        </span>
        {liveUrl !== null && <LiveIndicator stats={live} />}
        <form
          className="lw-urlform"
          onSubmit={(e) => {
            e.preventDefault();
            if (urlRef.current !== null) setUrl(urlRef.current.value);
          }}
        >
          <input aria-label="MCP URL" data-testid="mcp-url" ref={urlRef} defaultValue={url} />
          <button
            type="button"
            data-testid="connect"
            onClick={() => {
              if (urlRef.current !== null) setUrl(urlRef.current.value);
            }}
          >
            connect
          </button>
        </form>
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
        <button
          type="button"
          data-testid="panel-orientation"
          className="lw-toggle"
          title="Move the detail panel"
          onClick={toggleOrientation}
        >
          {panel.orientation === "right" ? "panel ▸ bottom" : "panel ▸ right"}
        </button>
      </header>

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
          {ledgers.map((l) => (
            <button
              key={l}
              data-testid={`ledger-${l}`}
              className={l === ledger ? "lw-ledger lw-ledger-active" : "lw-ledger"}
              onClick={() => void openLedger(l)}
            >
              {l}
            </button>
          ))}
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
            <SearchResults hits={hits} onOpen={(h) => void openHit(h)} onClear={() => setHits(null)} />
          ) : view !== null ? (
            <>
              <div className="lw-toolbar">
                <button
                  type="button"
                  data-testid="new-item-or-milestone"
                  onClick={() => setCreating(isMilestones ? "milestone" : "item")}
                >
                  {isMilestones ? "+ milestone" : "+ item"}
                </button>
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
              {creating === "item" && client !== null && (
                <CreateItemForm
                  view={view}
                  loadMilestones={() => client.fetchLedger(MILESTONES)}
                  onCreate={async (milestoneId, status, fields) => {
                    try {
                      const it = await client.createItem(ledger!, milestoneId, {
                        status,
                        fields,
                        author: UI_AUTHOR,
                      });
                      setFlash(`created ${it.id}`);
                      setCreating(null);
                      await reload();
                    } catch (e) {
                      setFlash(errMsg(e));
                    }
                  }}
                  onCancel={() => setCreating(null)}
                />
              )}
              <ItemTable rows={ledgerRows(view)} selectedId={selected?.item.id ?? null} onSelect={setSelected} />
            </>
          ) : (
            <p className="lw-empty">{conn === "connected" ? "select a ledger" : "…"}</p>
          )}
        </main>

        {selected !== null && view !== null && (
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
              <DetailPanel
                row={selected}
                ledger={ledger ?? ""}
                schema={view.schema}
                isMilestones={isMilestones}
                onSave={(status, fields) => void saveEdit(selected, status, fields)}
                onClose={() => setSelected(null)}
              />
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

function SearchBar({ onSearch, disabled }: { onSearch: (q: string) => void; disabled: boolean }): React.ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  const go = (): void => {
    const v = ref.current?.value ?? "";
    if (v.trim().length > 0) onSearch(v);
  };
  return (
    <form
      className="lw-search"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <input aria-label="search" data-testid="search-input" placeholder="search…" ref={ref} disabled={disabled} defaultValue="" />
      <button type="button" data-testid="search-go" disabled={disabled} onClick={go}>
        search
      </button>
    </form>
  );
}

function ItemTable({
  rows,
  selectedId,
  onSelect,
}: {
  rows: Row[];
  selectedId: string | null;
  onSelect: (row: Row) => void;
}): React.ReactElement {
  if (rows.length === 0) return <p className="lw-empty">(no items)</p>;
  return (
    <table className="lw-table" data-testid="item-table">
      <thead>
        <tr>
          <th>milestone</th>
          <th>id</th>
          <th>status</th>
          <th>summary</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.item.id}
            data-testid={`item-${r.item.id}`}
            className={r.item.id === selectedId ? "lw-row lw-row-active" : "lw-row"}
            onClick={() => onSelect(r)}
          >
            <td>{r.milestoneId}</td>
            <td>{r.item.id}</td>
            <td>
              <span className="lw-status">{r.item.status}</span>
            </td>
            <td>{summarize(r.item)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SearchResults({
  hits,
  onOpen,
  onClear,
}: {
  hits: FtsHit[];
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
          {hits.map((h) => (
            <li key={`${h.ledgerId}/${h.item.id}`}>
              <button type="button" data-testid={`hit-${h.item.id}`} onClick={() => onOpen(h)}>
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

function DetailPanel({
  row,
  ledger,
  schema,
  isMilestones,
  onSave,
  onClose,
}: {
  row: Row;
  ledger: string;
  schema: FetchedLedger["schema"];
  isMilestones: boolean;
  onSave: (status: string, fields: Record<string, FieldValue>) => void;
  onClose: () => void;
}): React.ReactElement {
  const fieldNames = Object.keys(schema.fields);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState(row.item.status);
  const fieldRefs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});

  // Reset to view mode (and resync status) whenever a different item loads.
  useEffect(() => {
    setEditing(false);
    setStatus(row.item.status);
  }, [row]);

  const head = (
    <div className="lw-detail-head">
      <strong data-testid="detail-id">{row.item.id}</strong>
      <span className="lw-dim"> @ {ledger}</span>
      {!editing && (
        <button type="button" className="lw-edit-btn" data-testid="edit" onClick={() => setEditing(true)}>
          edit
        </button>
      )}
      <button type="button" className="lw-close" onClick={onClose} data-testid="detail-close">
        ✕
      </button>
    </div>
  );

  if (editing) {
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
      onSave(status, built);
      setEditing(false);
    };
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
                    placeholder={spec.type.endsWith("[]") ? "comma,separated" : ""}
                  />
                )}
              </label>
            );
          })}
          <div className="lw-form-actions">
            <button type="button" data-testid="save" onClick={save}>
              save
            </button>
            <button type="button" data-testid="cancel-edit" onClick={() => setEditing(false)}>
              cancel
            </button>
          </div>
        </form>
      </aside>
    );
  }

  return (
    <aside className="lw-detail" data-testid="detail">
      {head}
      <dl className="lw-fields">
        <dt>status</dt>
        <dd data-testid="detail-status">{row.item.status}</dd>
        {Object.entries(row.item.fields).map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd data-testid={`detail-field-${k}`}>
              {Array.isArray(v) ? v.join(", ") : <Markdown text={v} />}
            </dd>
          </React.Fragment>
        ))}
        <dt>milestone</dt>
        <dd>{row.milestoneId}</dd>
      </dl>
      {isMilestones && <p className="lw-dim">Milestone fields (title/deps) are edited via the form.</p>}
    </aside>
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

function CreateItemForm({
  view,
  loadMilestones,
  onCreate,
  onCancel,
}: {
  view: FetchedLedger;
  loadMilestones: () => Promise<FetchedLedger>;
  onCreate: (milestoneId: string, status: string, fields: Record<string, FieldValue>) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [milestones, setMilestones] = useState<Item[]>([]);
  const [milestoneId, setMilestoneId] = useState("");
  const [status, setStatus] = useState(view.schema.statusValues[0] ?? "");
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const fieldNames = Object.keys(view.schema.fields);

  useEffect(() => {
    let alive = true;
    void loadMilestones().then((ms) => {
      if (!alive) return;
      const items = ms.milestones.flatMap((g) => g.items);
      setMilestones(items);
      setMilestoneId(items[0]?.id ?? "");
    });
    return () => {
      alive = false;
    };
  }, [loadMilestones]);

  const go = (): void => {
    const built: Record<string, FieldValue> = {};
    for (const name of fieldNames) {
      const raw = fieldRefs.current[name]?.value ?? "";
      if (raw.length === 0) continue;
      built[name] = parseFieldValue(raw, view.schema.fields[name]!.type);
    }
    if (milestoneId.length > 0) onCreate(milestoneId, status, built);
  };

  return (
    <form
      className="lw-create"
      data-testid="create-item"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <label>
        milestone
        <select data-testid="ci-milestone" value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
          {milestones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id} {fieldToString(m.fields["title"])}
            </option>
          ))}
        </select>
      </label>
      <label>
        status
        <select data-testid="ci-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          {view.schema.statusValues.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {fieldNames.map((name) => (
        <label key={name}>
          {name}
          {view.schema.fields[name]!.required ? "*" : ""}
          <input
            data-testid={`ci-field-${name}`}
            ref={(el) => {
              fieldRefs.current[name] = el;
            }}
            defaultValue=""
          />
        </label>
      ))}
      <button type="button" data-testid="ci-create" onClick={go}>
        create
      </button>
      <button type="button" onClick={onCancel}>
        cancel
      </button>
    </form>
  );
}
