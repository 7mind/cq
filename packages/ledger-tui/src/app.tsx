/**
 * ledger-tui — the Ink application.
 *
 * A keyboard-driven explorer/editor over a ledger MCP server. The UI is a
 * small mode state-machine; each mode renders exactly one interactive screen
 * so keystroke handlers never compete. Mutations go straight to the server
 * (update_item / create_item / create_milestone / update_milestone) and the
 * current ledger is re-fetched afterward so the view reflects disk truth.
 *
 * Capability scope (explore + edit items): browse ledgers → items/milestones,
 * view item detail, full-text search, edit item status & fields, edit
 * milestone status & title, create items and milestones.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { SelectList } from "./components/SelectList.js";
import { TextPrompt } from "./components/TextPrompt.js";
import type { FetchedLedger, FieldValue, FtsHit, Item, LedgerClient } from "./types.js";

/** Reserved name of the global milestones ledger (server wire contract). */
const MILESTONES = "milestones";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fieldToString(v: FieldValue | undefined): string {
  if (v === undefined) return "";
  return Array.isArray(v) ? v.join(", ") : v;
}

/** One-line summary of an item from its most title-like field. */
function summarize(item: Item): string {
  const f = item.fields;
  const pick =
    f["headline"] ?? f["title"] ?? f["question"] ?? f["summary"] ?? Object.values(f)[0];
  return fieldToString(pick as FieldValue | undefined);
}

interface Row {
  item: Item;
  milestoneId: string;
}

function ledgerRows(view: FetchedLedger): Row[] {
  return view.milestones.flatMap((g) => g.items.map((item) => ({ item, milestoneId: g.id })));
}

// ---------------------------------------------------------------------------
// Screen state
// ---------------------------------------------------------------------------

type Screen =
  | { t: "loading" }
  | { t: "fatal"; msg: string }
  | { t: "ledgers" }
  | { t: "items" }
  | { t: "detail"; row: Row }
  | { t: "editStatus"; row: Row }
  | { t: "pickField"; row: Row }
  | { t: "editField"; row: Row; field: string }
  | { t: "editTitle"; row: Row }
  | { t: "search" }
  | { t: "searchResults"; hits: FtsHit[] }
  | { t: "createMilestone" }
  | { t: "createItem"; milestones: Item[] };

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App({ client }: { client: LedgerClient }): React.ReactElement {
  const { exit } = useApp();
  const [ledgers, setLedgers] = useState<string[]>([]);
  const [ledger, setLedger] = useState<string | null>(null);
  const [view, setView] = useState<FetchedLedger | null>(null);
  const [screen, setScreen] = useState<Screen>({ t: "loading" });
  const [flash, setFlash] = useState<string>("");

  useEffect(() => {
    let alive = true;
    client
      .enumerateLedgers()
      .then((ls) => {
        if (!alive) return;
        setLedgers(ls);
        setScreen({ t: "ledgers" });
      })
      .catch((e: unknown) => {
        if (alive) setScreen({ t: "fatal", msg: errMsg(e) });
      });
    return () => {
      alive = false;
    };
  }, [client]);

  async function openLedger(name: string): Promise<void> {
    try {
      const v = await client.fetchLedger(name);
      setLedger(name);
      setView(v);
      setFlash("");
      setScreen({ t: "items" });
    } catch (e) {
      setFlash(errMsg(e));
    }
  }

  async function reload(): Promise<FetchedLedger | null> {
    if (ledger === null) return null;
    try {
      const v = await client.fetchLedger(ledger);
      setView(v);
      return v;
    } catch (e) {
      setFlash(errMsg(e));
      return null;
    }
  }

  const isMilestones = ledger === MILESTONES;

  async function applyStatus(row: Row, status: string): Promise<void> {
    try {
      if (isMilestones) await client.updateMilestone(row.item.id, { status });
      else await client.updateItem(ledger!, row.item.id, { status });
      setFlash(`${row.item.id} → ${status}`);
      await reload();
      setScreen({ t: "items" });
    } catch (e) {
      setFlash(errMsg(e));
      setScreen({ t: "items" });
    }
  }

  async function applyField(row: Row, field: string, raw: string): Promise<void> {
    try {
      const spec = view?.schema.fields[field];
      const value: FieldValue =
        spec !== undefined && (spec.type === "string[]" || spec.type === "id[]")
          ? raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
          : raw;
      await client.updateItem(ledger!, row.item.id, { fields: { [field]: value } });
      setFlash(`${row.item.id}.${field} updated`);
      await reload();
      setScreen({ t: "items" });
    } catch (e) {
      setFlash(errMsg(e));
      setScreen({ t: "items" });
    }
  }

  async function applyTitle(row: Row, title: string): Promise<void> {
    try {
      await client.updateMilestone(row.item.id, { title });
      setFlash(`${row.item.id} title updated`);
      await reload();
      setScreen({ t: "items" });
    } catch (e) {
      setFlash(errMsg(e));
      setScreen({ t: "items" });
    }
  }

  async function beginCreate(): Promise<void> {
    if (isMilestones) {
      setScreen({ t: "createMilestone" });
      return;
    }
    try {
      const ms = await client.fetchLedger(MILESTONES);
      const milestones = ms.milestones.flatMap((g) => g.items);
      setScreen({ t: "createItem", milestones });
    } catch (e) {
      setFlash(errMsg(e));
    }
  }

  async function doCreateMilestone(title: string): Promise<void> {
    if (title.trim().length === 0) {
      setFlash("title is required");
      return;
    }
    try {
      const m = await client.createMilestone({ title });
      setFlash(`created ${m.id}`);
      await reload();
      setScreen({ t: "items" });
    } catch (e) {
      setFlash(errMsg(e));
      setScreen({ t: "items" });
    }
  }

  async function runSearch(query: string): Promise<void> {
    if (query.trim().length === 0) {
      setScreen({ t: ledger !== null ? "items" : "ledgers" });
      return;
    }
    try {
      const hits = await client.ftsSearch(query);
      setFlash(`${hits.length} hit(s) for "${query}"`);
      setScreen({ t: "searchResults", hits });
    } catch (e) {
      setFlash(errMsg(e));
    }
  }

  // ---- render ------------------------------------------------------------

  const header = (
    <Box>
      <Text bold color="green">
        ledger-tui
      </Text>
      <Text dimColor>
        {"  "}
        {ledger !== null ? `ledger: ${ledger}` : "all ledgers"}
      </Text>
    </Box>
  );

  let body: React.ReactElement;
  let hints = "";

  switch (screen.t) {
    case "loading":
      body = <Text dimColor>connecting…</Text>;
      break;

    case "fatal":
      body = <Text color="red">connection failed: {screen.msg}</Text>;
      hints = "Ctrl+C quit";
      break;

    case "ledgers":
      hints = "↑↓ move · Enter open · / search · q quit";
      body = (
        <LedgersScreen
          ledgers={ledgers}
          onOpen={(l) => void openLedger(l)}
          onSearch={() => setScreen({ t: "search" })}
          onQuit={() => exit()}
        />
      );
      break;

    case "items": {
      hints = "↑↓ move · Enter detail · n new · / search · Esc ledgers";
      const rows = view !== null ? ledgerRows(view) : [];
      body = (
        <ItemsScreen
          rows={rows}
          onOpen={(row) => setScreen({ t: "detail", row })}
          onNew={() => void beginCreate()}
          onSearch={() => setScreen({ t: "search" })}
          onBack={() => {
            setLedger(null);
            setView(null);
            setScreen({ t: "ledgers" });
          }}
        />
      );
      break;
    }

    case "detail":
      hints = isMilestones
        ? "s status · t title · Esc back"
        : "s status · e field · Esc back";
      body = (
        <DetailScreen
          row={screen.row}
          ledger={ledger ?? ""}
          onEditStatus={() => setScreen({ t: "editStatus", row: screen.row })}
          onEditField={() =>
            isMilestones
              ? setScreen({ t: "editTitle", row: screen.row })
              : setScreen({ t: "pickField", row: screen.row })
          }
          isMilestones={isMilestones}
          onBack={() => setScreen({ t: "items" })}
        />
      );
      break;

    case "editStatus":
      hints = "↑↓ move · Enter set · Esc cancel";
      body = (
        <SelectList
          items={view?.schema.statusValues ?? []}
          getLabel={(s) => s}
          onSelect={(s) => void applyStatus(screen.row, s)}
          onCancel={() => setScreen({ t: "detail", row: screen.row })}
        />
      );
      break;

    case "pickField": {
      hints = "↑↓ move · Enter edit · Esc cancel";
      const fields = view !== null ? Object.keys(view.schema.fields) : [];
      body = (
        <SelectList
          items={fields}
          getLabel={(f) => `${f} = ${fieldToString(screen.row.item.fields[f])}`}
          onSelect={(f) => setScreen({ t: "editField", row: screen.row, field: f })}
          onCancel={() => setScreen({ t: "detail", row: screen.row })}
          emptyLabel="(no editable fields)"
        />
      );
      break;
    }

    case "editField":
      hints = "Enter save · Esc cancel";
      body = (
        <TextPrompt
          label={`${screen.field}:`}
          initialValue={fieldToString(screen.row.item.fields[screen.field])}
          onSubmit={(v) => void applyField(screen.row, screen.field, v)}
          onCancel={() => setScreen({ t: "detail", row: screen.row })}
        />
      );
      break;

    case "editTitle":
      hints = "Enter save · Esc cancel";
      body = (
        <TextPrompt
          label="title:"
          initialValue={fieldToString(screen.row.item.fields["title"])}
          onSubmit={(v) => void applyTitle(screen.row, v)}
          onCancel={() => setScreen({ t: "detail", row: screen.row })}
        />
      );
      break;

    case "search":
      hints = "Enter search · Esc cancel";
      body = (
        <TextPrompt
          label="search:"
          onSubmit={(q) => void runSearch(q)}
          onCancel={() => setScreen({ t: ledger !== null ? "items" : "ledgers" })}
        />
      );
      break;

    case "searchResults":
      hints = "↑↓ move · Enter open · Esc back";
      body = (
        <SelectList
          items={screen.hits}
          getLabel={(h) =>
            `${h.ledgerId}/${h.item.id} [${h.item.status}] ${summarize(h.item)}`
          }
          onSelect={(h) => {
            setLedger(h.ledgerId);
            void client
              .fetchLedger(h.ledgerId)
              .then((v) => {
                setView(v);
                setScreen({ t: "detail", row: { item: h.item, milestoneId: h.item.milestoneId } });
              })
              .catch((e: unknown) => setFlash(errMsg(e)));
          }}
          onCancel={() => setScreen({ t: ledger !== null ? "items" : "ledgers" })}
          emptyLabel="(no hits)"
        />
      );
      break;

    case "createMilestone":
      hints = "Enter create · Esc cancel";
      body = (
        <TextPrompt
          label="new milestone title:"
          onSubmit={(t) => void doCreateMilestone(t)}
          onCancel={() => setScreen({ t: "items" })}
        />
      );
      break;

    case "createItem":
      hints = "follow prompts · Esc cancel";
      body = (
        <CreateItemForm
          view={view}
          milestones={screen.milestones}
          onSubmit={(milestoneId, status, fields) => {
            void (async (): Promise<void> => {
              try {
                const it = await client.createItem(ledger!, milestoneId, { status, fields });
                setFlash(`created ${it.id}`);
                await reload();
                setScreen({ t: "items" });
              } catch (e) {
                setFlash(errMsg(e));
                setScreen({ t: "items" });
              }
            })();
          }}
          onCancel={() => setScreen({ t: "items" })}
        />
      );
      break;
  }

  return (
    <Box flexDirection="column">
      {header}
      <Box marginTop={1} flexDirection="column">
        {body}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {flash.length > 0 && <Text color="yellow">{flash}</Text>}
        {hints.length > 0 && <Text dimColor>{hints}</Text>}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Screen components (own their extra-key handlers alongside a SelectList)
// ---------------------------------------------------------------------------

function LedgersScreen({
  ledgers,
  onOpen,
  onSearch,
  onQuit,
}: {
  ledgers: string[];
  onOpen: (ledger: string) => void;
  onSearch: () => void;
  onQuit: () => void;
}): React.ReactElement {
  useInput((input) => {
    if (input === "/") onSearch();
    else if (input === "q") onQuit();
  });
  return (
    <SelectList
      items={ledgers}
      getLabel={(l) => l}
      onSelect={(l) => onOpen(l)}
      onCancel={onQuit}
    />
  );
}

function ItemsScreen({
  rows,
  onOpen,
  onNew,
  onSearch,
  onBack,
}: {
  rows: Row[];
  onOpen: (row: Row) => void;
  onNew: () => void;
  onSearch: () => void;
  onBack: () => void;
}): React.ReactElement {
  useInput((input) => {
    if (input === "n") onNew();
    else if (input === "/") onSearch();
  });
  return (
    <SelectList
      items={rows}
      getLabel={(r) => `${r.milestoneId} ${r.item.id} [${r.item.status}] ${summarize(r.item)}`}
      onSelect={(r) => onOpen(r)}
      onCancel={onBack}
      emptyLabel="(no items — press n to create)"
    />
  );
}

function DetailScreen({
  row,
  ledger,
  isMilestones,
  onEditStatus,
  onEditField,
  onBack,
}: {
  row: Row;
  ledger: string;
  isMilestones: boolean;
  onEditStatus: () => void;
  onEditField: () => void;
  onBack: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) onBack();
    else if (input === "s") onEditStatus();
    else if (input === "e" || input === "t") onEditField();
  });
  const f = row.item.fields;
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{row.item.id}</Text>
        <Text dimColor> @ {ledger}</Text>
        {" · "}
        <Text color="cyan">{row.item.status}</Text>
        {" · "}
        <Text dimColor>milestone {row.milestoneId}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {Object.keys(f).length === 0 ? (
          <Text dimColor>(no fields)</Text>
        ) : (
          Object.entries(f).map(([k, v]) => (
            <Text key={k}>
              <Text dimColor>{k}: </Text>
              {fieldToString(v)}
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          created {row.item.createdAt} · updated {row.item.updatedAt}
          {isMilestones ? " · (milestone)" : ""}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Create-item multi-step form: milestone → status → each schema field
// ---------------------------------------------------------------------------

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
        emptyLabel="(no active milestones — create one in the milestones ledger first)"
      />
    );
  }

  if (step.t === "status") {
    const statuses = view?.schema.statusValues ?? [];
    return (
      <SelectList
        items={statuses}
        getLabel={(s) => s}
        onSelect={(s) => {
          if (fieldNames.length === 0) {
            onSubmit(step.milestoneId, s, {});
          } else {
            setStep({ t: "field", milestoneId: step.milestoneId, status: s, idx: 0, acc: {} });
          }
        }}
        onCancel={onCancel}
      />
    );
  }

  // step.t === "field"
  const name = fieldNames[step.idx]!;
  const spec = view!.schema.fields[name]!;
  const label = `${name}${spec.required ? "*" : ""} (${spec.type}):`;
  return (
    <Box flexDirection="column">
      <Text dimColor>
        milestone {step.milestoneId} · status {step.status} · field {step.idx + 1}/{fieldNames.length}
      </Text>
      <TextPrompt
        label={label}
        onSubmit={(raw) => {
          const value: FieldValue =
            spec.type === "string[]" || spec.type === "id[]"
              ? raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
              : raw;
          const acc = { ...step.acc };
          // Only record non-empty values; omitted optional fields stay absent.
          if (raw.length > 0) acc[name] = value;
          const nextIdx = step.idx + 1;
          if (nextIdx >= fieldNames.length) {
            onSubmit(step.milestoneId, step.status, acc);
          } else {
            setStep({ ...step, idx: nextIdx, acc });
          }
        }}
        onCancel={onCancel}
      />
    </Box>
  );
}
