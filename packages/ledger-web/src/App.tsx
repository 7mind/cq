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
import type { FetchedLedger, FieldValue, FtsHit, Item, LedgerClient } from "./types.js";
import { DagView } from "./DagView.js";
import { loadDagData, type DagData } from "./dagData.js";

const MILESTONES = "milestones";

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
}

export function App({ connect, initialUrl }: AppProps): React.ReactElement {
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
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client],
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

  const setStatus = useCallback(
    async (row: Row, status: string) => {
      if (client === null) return;
      try {
        if (isMilestones) await client.updateMilestone(row.item.id, { status });
        else await client.updateItem(ledger!, row.item.id, { status });
        setFlash(`${row.item.id} → ${status}`);
        await reload();
        if (mainView === "dag") setDag(await loadDagData(client));
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client, isMilestones, ledger, reload, mainView],
  );

  const setFieldValue = useCallback(
    async (row: Row, field: string, raw: string) => {
      if (client === null || view === null) return;
      try {
        const spec = view.schema.fields[field];
        const value = parseFieldValue(raw, spec?.type ?? "string");
        await client.updateItem(ledger!, row.item.id, { fields: { [field]: value } });
        setFlash(`${row.item.id}.${field} updated`);
        await reload();
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client, view, ledger, reload],
  );

  const setTitle = useCallback(
    async (row: Row, title: string) => {
      if (client === null) return;
      try {
        await client.updateMilestone(row.item.id, { title });
        setFlash(`${row.item.id} title updated`);
        await reload();
        if (mainView === "dag") setDag(await loadDagData(client));
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client, reload, mainView],
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

  const refreshDag = useCallback(async () => {
    if (client === null) return;
    try {
      setDag(await loadDagData(client));
    } catch (e) {
      setFlash(errMsg(e));
    }
  }, [client]);

  const showDag = useCallback(async () => {
    setMainView("dag");
    setDag(null);
    await refreshDag();
  }, [refreshDag]);

  const openMilestoneNode = useCallback(
    async (id: string) => {
      if (client === null) return;
      try {
        const v = await client.fetchLedger(MILESTONES);
        setLedger(MILESTONES);
        setView(v);
        setHits(null);
        let found: Row | null = null;
        for (const g of v.milestones)
          for (const it of g.items) if (it.id === id) found = { item: it, milestoneId: g.id };
        setSelected(found);
      } catch (e) {
        setFlash(errMsg(e));
      }
    },
    [client],
  );

  // ---- render ------------------------------------------------------------
  return (
    <div className="lw-root">
      <header className="lw-header">
        <span className="lw-title">ledger-web</span>
        <span className={`lw-conn lw-conn-${conn}`} data-testid="conn-status">
          {conn === "connected" ? "● connected" : conn === "connecting" ? "○ connecting…" : "✕ error"}
        </span>
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

        <main className="lw-main">
          {mainView === "dag" ? (
            dag !== null ? (
              <DagView data={dag} selectedId={selected?.item.id ?? null} onSelect={(id) => void openMilestoneNode(id)} />
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
                      const it = await client.createItem(ledger!, milestoneId, { status, fields });
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
          <DetailPanel
            row={selected}
            ledger={ledger ?? ""}
            schema={view.schema}
            isMilestones={isMilestones}
            onSetStatus={(s) => void setStatus(selected, s)}
            onSetField={(f, v) => void setFieldValue(selected, f, v)}
            onSetTitle={(t) => void setTitle(selected, t)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

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
  onSetStatus,
  onSetField,
  onSetTitle,
  onClose,
}: {
  row: Row;
  ledger: string;
  schema: FetchedLedger["schema"];
  isMilestones: boolean;
  onSetStatus: (status: string) => void;
  onSetField: (field: string, value: string) => void;
  onSetTitle: (title: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const fieldNames = Object.keys(schema.fields);
  const [status, setStatusVal] = useState(row.item.status);
  const [field, setFieldName] = useState(fieldNames[0] ?? "");
  const fieldValRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setStatusVal(row.item.status);
    setFieldName(Object.keys(schema.fields)[0] ?? "");
  }, [row, schema]);

  return (
    <aside className="lw-detail" data-testid="detail">
      <div className="lw-detail-head">
        <strong data-testid="detail-id">{row.item.id}</strong>
        <span className="lw-dim"> @ {ledger}</span>
        <button type="button" className="lw-close" onClick={onClose} data-testid="detail-close">
          ✕
        </button>
      </div>
      <dl className="lw-fields">
        <dt>status</dt>
        <dd data-testid="detail-status">{row.item.status}</dd>
        {Object.entries(row.item.fields).map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd>{fieldToString(v)}</dd>
          </React.Fragment>
        ))}
        <dt>milestone</dt>
        <dd>{row.milestoneId}</dd>
      </dl>

      <fieldset className="lw-edit">
        <legend>status</legend>
        <select data-testid="status-select" value={status} onChange={(e) => setStatusVal(e.target.value)}>
          {schema.statusValues.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="button" data-testid="status-save" onClick={() => onSetStatus(status)}>
          set status
        </button>
      </fieldset>

      {isMilestones ? (
        <fieldset className="lw-edit">
          <legend>title</legend>
          <input
            data-testid="title-input"
            key={`title-${row.item.id}`}
            ref={titleRef}
            defaultValue={fieldToString(row.item.fields["title"])}
          />
          <button type="button" data-testid="title-save" onClick={() => onSetTitle(titleRef.current?.value ?? "")}>
            set title
          </button>
        </fieldset>
      ) : fieldNames.length > 0 ? (
        <fieldset className="lw-edit">
          <legend>field</legend>
          <select data-testid="field-select" value={field} onChange={(e) => setFieldName(e.target.value)}>
            {fieldNames.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <input
            data-testid="field-input"
            key={`${row.item.id}-${field}`}
            ref={fieldValRef}
            defaultValue={fieldToString(row.item.fields[field])}
          />
          <button type="button" data-testid="field-save" onClick={() => onSetField(field, fieldValRef.current?.value ?? "")}>
            set field
          </button>
        </fieldset>
      ) : null}
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
