import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type {
  WorksetProjectedGraph,
  WorksetResult,
} from "@cq/ledger";
import type { WorksetCapableLedgerClient } from "../types.js";

type SetAcknowledgement = Extract<WorksetResult, { readonly op: "set" }>["acknowledgement"];

export interface WorksetReplacementOutcome {
  readonly acknowledgement: SetAcknowledgement;
  readonly graph: WorksetProjectedGraph | null;
  readonly refreshError: string;
}

export interface WorksetOverlayProps {
  readonly client: WorksetCapableLedgerClient;
  readonly currentGraph: WorksetProjectedGraph | null;
  readonly currentLoading: boolean;
  readonly currentError: string;
  readonly replace: (
    roots: readonly string[],
  ) => Promise<WorksetReplacementOutcome | null>;
  readonly onCancel: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const GRAPH_ROOT_LIMIT = 3;
const GRAPH_NODE_LIMIT = 3;
const GRAPH_EDGE_LIMIT = 2;
const DRAFT_WINDOW = 4;

function boundedRefs(refs: readonly string[], limit: number): string {
  const shown = refs.slice(0, limit).join(", ");
  return refs.length > limit ? `${shown} … (+${refs.length - limit})` : shown;
}

function GraphView({
  label,
  graph,
}: {
  readonly label: string;
  readonly graph: WorksetProjectedGraph;
}): React.ReactElement {
  const nodeSummary = graph.nodes.length === 0
    ? ""
    : ` [${boundedRefs(graph.nodes.map(({ ref }) => ref), GRAPH_NODE_LIMIT)}]`;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">{label}</Text>
      <Text>roots: {graph.roots.length === 0 ? "(none)" : boundedRefs(graph.roots, GRAPH_ROOT_LIMIT)}</Text>
      {graph.inactiveRoots.length > 0 ? (
        <Text color="yellow">inactive: {boundedRefs(graph.inactiveRoots, GRAPH_ROOT_LIMIT)}</Text>
      ) : null}
      <Text>nodes: {graph.nodes.length}{nodeSummary}</Text>
      <Text>edges: {graph.edges.length}</Text>
      {graph.edges.length > 0 ? (
        graph.edges.slice(0, GRAPH_EDGE_LIMIT).map((edge) => (
          <Text key={`${edge.from}\0${edge.to}\0${edge.kind}`}>
            {`  ${edge.from} -[${edge.kind}]-> ${edge.to}`}
          </Text>
        ))
      ) : null}
    </Box>
  );
}

function GraphSummary({
  label,
  graph,
}: {
  readonly label: string;
  readonly graph: WorksetProjectedGraph;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">{label}</Text>
      <Text>roots: {graph.roots.length === 0 ? "(none)" : boundedRefs(graph.roots, GRAPH_ROOT_LIMIT)}</Text>
      <Text>nodes: {graph.nodes.length} · edges: {graph.edges.length}</Text>
    </Box>
  );
}

export function WorksetOverlay({
  client,
  currentGraph,
  currentLoading,
  currentError,
  replace,
  onCancel,
}: WorksetOverlayProps): React.ReactElement {
  const [draft, setDraft] = useState<string[] | null>(() =>
    currentGraph === null ? null : [...currentGraph.roots],
  );
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(0);
  const [preview, setPreview] = useState<WorksetProjectedGraph | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    if (draft !== null) return;
    if (currentGraph !== null) {
      setDraft([...currentGraph.roots]);
      setSelected(Math.max(0, currentGraph.roots.length - 1));
    } else if (!currentLoading) {
      setDraft([]);
    }
  }, [currentGraph, currentLoading, draft]);

  useEffect(
    () => () => {
      requestSequenceRef.current += 1;
    },
    [],
  );

  const proposedRoots = (): string[] => {
    const value = input.trim();
    const roots = draft ?? [];
    return value.length === 0 ? [...roots] : [...roots, value];
  };
  const editableDraft = draft ?? [];
  const draftWindowStart = Math.max(
    0,
    Math.min(selected, Math.max(0, editableDraft.length - DRAFT_WINDOW)),
  );
  const visibleDraft = editableDraft.slice(draftWindowStart, draftWindowStart + DRAFT_WINDOW);
  const initialHydrationPending = draft === null;

  const previewDraft = async (): Promise<void> => {
    const sequence = ++requestSequenceRef.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await client.workset({
        op: "fetch",
        roots: proposedRoots(),
        projection: "id",
      });
      if (requestSequenceRef.current !== sequence) return;
      setPreview(result.graph);
      setNotice("Preview only; current roots were not changed.");
    } catch (cause) {
      if (requestSequenceRef.current !== sequence) return;
      setError(errorMessage(cause));
    } finally {
      if (requestSequenceRef.current === sequence) setBusy(false);
    }
  };

  const applyDraft = async (roots: readonly string[]): Promise<void> => {
    const sequence = ++requestSequenceRef.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const outcome = await replace(roots);
      if (requestSequenceRef.current !== sequence || outcome === null) return;
      setDraft([...outcome.acknowledgement.roots]);
      setSelected(Math.max(0, outcome.acknowledgement.roots.length - 1));
      setInput("");
      setPreview(null);
      if (outcome.refreshError.length > 0) {
        setError(
          `applied at epoch ${outcome.acknowledgement.epoch}; refresh failed: ${outcome.refreshError}`,
        );
      } else {
        setNotice(`Applied epoch ${outcome.acknowledgement.epoch}.`);
      }
    } catch (cause) {
      if (requestSequenceRef.current !== sequence) return;
      setError(errorMessage(cause));
    } finally {
      if (requestSequenceRef.current === sequence) setBusy(false);
    }
  };

  useInput((typed, key) => {
    if (key.escape) {
      requestSequenceRef.current += 1;
      onCancel();
      return;
    }
    if (initialHydrationPending) return;
    if (busy) return;
    if (key.ctrl && typed === "a") {
      void applyDraft(proposedRoots());
    } else if (key.ctrl && typed === "l") {
      void applyDraft([]);
    } else if (key.ctrl && typed === "p") {
      void previewDraft();
    } else if (key.ctrl && typed === "d") {
      if (editableDraft.length === 0) return;
      setDraft((roots) => (roots ?? []).filter((_, index) => index !== selected));
      setSelected((index) => Math.max(0, Math.min(index, editableDraft.length - 2)));
      setPreview(null);
    } else if (key.upArrow) {
      setSelected((index) => Math.max(0, index - 1));
    } else if (key.downArrow) {
      setSelected((index) => Math.min(editableDraft.length - 1, index + 1));
    } else if (key.return) {
      const value = input.trim();
      if (value.length === 0) return;
      setDraft((roots) => [...(roots ?? []), value]);
      setSelected(editableDraft.length);
      setInput("");
      setPreview(null);
      setError("");
    } else if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
    } else if (typed.length > 0 && !key.ctrl && !key.meta) {
      setInput((value) => value + typed);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Workset manager</Text>
      {initialHydrationPending ? <Text dimColor>Loading current workset…</Text> : null}
      {currentGraph !== null ? (
        preview === null
          ? <GraphView label="Current traced graph" graph={currentGraph} />
          : <GraphSummary label="Current traced graph" graph={currentGraph} />
      ) : null}
      {currentError.length > 0 ? <Text color="red">Error: {currentError}</Text> : null}

      {initialHydrationPending ? (
        <Text dimColor>Editor unavailable until current roots load. Esc closes.</Text>
      ) : (
        <>

      <Text bold>Draft roots:</Text>
      {editableDraft.length === 0 ? (
        <Text dimColor>  (none)</Text>
      ) : (
        visibleDraft.map((root, windowIndex) => {
          const index = draftWindowStart + windowIndex;
          return <Text key={`${index}:${root}`} inverse={index === selected}>
            {index === selected ? "› " : "  "}{root}
          </Text>
        })
      )}
      {editableDraft.length > DRAFT_WINDOW ? (
        <Text dimColor>
          showing {draftWindowStart + 1}-{draftWindowStart + visibleDraft.length} of {editableDraft.length}
        </Text>
      ) : null}
      <Text>root: <Text color="cyan">{input}</Text>▌</Text>

      {preview !== null ? <GraphSummary label="Fetch preview" graph={preview} /> : null}
      {busy ? <Text color="yellow">Request in progress…</Text> : null}
      {error.length > 0 ? <Text color="red">Error: {error}</Text> : null}
      {notice.length > 0 ? <Text color="green">{notice}</Text> : null}
      <Text dimColor>
        Enter add · ↑↓ select · Ctrl+D remove · Ctrl+P preview · Ctrl+A apply · Ctrl+L clear · Esc close
      </Text>
        </>
      )}
    </Box>
  );
}
