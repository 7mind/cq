import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Item, WorksetCapableLedgerClient } from "./types.js";
import type { WorksetProjectedGraph, WorksetProjectedNode } from "@cq/ledger";
import { summarize } from "@cq/ledger/summarize";
import { useBackdropDismiss } from "./useBackdropDismiss.js";

type WorksetPhase = "loading" | "idle" | "previewing" | "applying" | "refreshing";

interface WorksetManagerState {
  readonly loaded: boolean;
  readonly current: WorksetProjectedGraph | null;
  readonly persistedRoots: readonly string[];
  readonly draftRoots: readonly string[];
  readonly preview: WorksetProjectedGraph | null;
  readonly phase: WorksetPhase;
  readonly error: string | null;
  readonly appliedEpoch: number | null;
}

const INITIAL_STATE: WorksetManagerState = {
  loaded: false,
  current: null,
  persistedRoots: [],
  draftRoots: [],
  preview: null,
  phase: "loading",
  error: null,
  appliedEpoch: null,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameRoots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((root, index) => root === right[index]);
}

function projectedItem(node: WorksetProjectedNode): Item | null {
  if (!("item" in node) || !("status" in node.item) || !("milestoneId" in node.item)) {
    return null;
  }
  return node.item as Item;
}

function WorksetGraphView({
  graph,
  scope,
}: {
  graph: WorksetProjectedGraph;
  scope: "current" | "preview";
}): React.ReactElement {
  return (
    <section className="lw-workset-graph" data-testid={`workset-${scope}-graph`}>
      <div
        className={graph.restrictive ? "lw-workset-mode" : "lw-workset-mode lw-dim"}
        data-testid={`workset-${scope}-restrictive`}
      >
        {graph.restrictive ? "prioritized" : "unrestricted"}
      </div>
      {graph.roots.length === 0 && (
        <p className="lw-empty" data-testid={`workset-${scope}-empty`}>
          no prioritization
        </p>
      )}
      {graph.roots.length > 0 && (
        <ul className="lw-workset-list" data-testid={`workset-${scope}-roots`}>
          {graph.roots.map((root) => (
            <li key={root} data-testid={`workset-${scope}-root-${root}`}>
              <code>{root}</code>
              {graph.inactiveRoots.includes(root) && (
                <span className="lw-workset-inactive"> inactive</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {graph.nodes.length > 0 && (
        <ul className="lw-workset-list lw-workset-nodes" data-testid={`workset-${scope}-nodes`}>
          {graph.nodes.map((node) => {
            const item = projectedItem(node);
            return (
              <li key={node.ref} data-testid={`workset-${scope}-node-${node.ref}`}>
                <code>{node.ref}</code>
                {item !== null && (
                  <>
                    {" "}
                    <span className="lw-dim">[{item.status}]</span> {summarize(item)}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {graph.edges.length > 0 && (
        <ul className="lw-workset-list lw-workset-edges" data-testid={`workset-${scope}-edges`}>
          {graph.edges.map((edge, index) => (
            <li
              key={`${edge.kind}\0${edge.from}\0${edge.to}`}
              data-testid={`workset-${scope}-edge-${index}`}
            >
              <code>{edge.from}</code> {edge.kind} <code>{edge.to}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function WorksetManager({
  client,
  onClose,
}: {
  client: WorksetCapableLedgerClient;
  onClose: () => void;
}): React.ReactElement {
  const [state, setState] = useState<WorksetManagerState>(INITIAL_STATE);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const previewGenerationRef = useRef(0);
  const draftRevisionRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const backdropProps = useBackdropDismiss(onClose);

  useEffect(
    () => () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      previewGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
    },
    [],
  );

  const loadCurrent = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setState((current) => ({ ...current, phase: "loading", error: null }));
    try {
      const result = await client.workset({ op: "get", projection: "compact" });
      if (!mountedRef.current || loadGenerationRef.current !== generation) return;
      draftRevisionRef.current += 1;
      setState((current) => ({
        ...current,
        loaded: true,
        current: result.graph,
        persistedRoots: [...result.graph.roots],
        draftRoots: [...result.graph.roots],
        preview: null,
        phase: "idle",
        error: null,
      }));
    } catch (error) {
      if (!mountedRef.current || loadGenerationRef.current !== generation) return;
      setState((current) => ({ ...current, phase: "idle", error: messageOf(error) }));
    }
  }, [client]);

  useEffect(() => {
    void loadCurrent();
  }, [loadCurrent]);

  const editDraft = useCallback((edit: (roots: readonly string[]) => readonly string[]) => {
    draftRevisionRef.current += 1;
    previewGenerationRef.current += 1;
    setState((current) => ({
      ...current,
      draftRoots: edit(current.draftRoots),
      preview: null,
      phase: current.phase === "previewing" ? "idle" : current.phase,
      error: null,
    }));
  }, []);

  const addRoot = useCallback(() => {
    const input = inputRef.current;
    if (input === null) return;
    const root = input.value.trim();
    if (root === "") return;
    editDraft((roots) => (roots.includes(root) ? roots : [...roots, root]));
    input.value = "";
    input.focus();
  }, [editDraft]);

  const previewDraft = useCallback(async () => {
    const generation = ++previewGenerationRef.current;
    const revision = draftRevisionRef.current;
    const roots = [...state.draftRoots];
    setState((current) => ({ ...current, phase: "previewing", error: null }));
    try {
      const result = await client.workset({ op: "fetch", roots, projection: "compact" });
      if (
        !mountedRef.current ||
        previewGenerationRef.current !== generation ||
        draftRevisionRef.current !== revision
      ) {
        return;
      }
      setState((current) => ({
        ...current,
        draftRoots: [...result.graph.roots],
        preview: result.graph,
        phase: "idle",
        error: null,
      }));
    } catch (error) {
      if (
        !mountedRef.current ||
        previewGenerationRef.current !== generation ||
        draftRevisionRef.current !== revision
      ) {
        return;
      }
      setState((current) => ({ ...current, phase: "idle", error: messageOf(error) }));
    }
  }, [client, state.draftRoots]);

  const applyDraft = useCallback(async () => {
    const generation = ++mutationGenerationRef.current;
    previewGenerationRef.current += 1;
    const roots = [...state.draftRoots];
    setState((current) => ({ ...current, phase: "applying", error: null }));
    let acknowledgement: { readonly roots: readonly string[]; readonly epoch: number };
    try {
      acknowledgement = (await client.workset({ op: "set", roots })).acknowledgement;
    } catch (error) {
      if (!mountedRef.current || mutationGenerationRef.current !== generation) return;
      setState((current) => ({ ...current, phase: "idle", error: messageOf(error) }));
      return;
    }
    if (!mountedRef.current || mutationGenerationRef.current !== generation) return;
    draftRevisionRef.current += 1;
    previewGenerationRef.current += 1;
    setState((current) => ({
      ...current,
      current: null,
      persistedRoots: [...acknowledgement.roots],
      draftRoots: [...acknowledgement.roots],
      preview: null,
      phase: "refreshing",
      error: null,
      appliedEpoch: acknowledgement.epoch,
    }));
    try {
      const refreshed = await client.workset({ op: "get", projection: "compact" });
      if (!mountedRef.current || mutationGenerationRef.current !== generation) return;
      setState((current) => ({
        ...current,
        loaded: true,
        current: refreshed.graph,
        persistedRoots: [...refreshed.graph.roots],
        draftRoots: [...refreshed.graph.roots],
        phase: "idle",
        error: null,
      }));
    } catch (error) {
      if (!mountedRef.current || mutationGenerationRef.current !== generation) return;
      setState((current) => ({
        ...current,
        phase: "idle",
        error: `applied at epoch ${acknowledgement.epoch}; refresh failed: ${messageOf(error)}`,
      }));
    }
  }, [client, state.draftRoots]);

  const mutating =
    state.phase === "loading" || state.phase === "applying" || state.phase === "refreshing";
  const dirty = !sameRoots(state.draftRoots, state.persistedRoots);

  return (
    <div className="lw-modal-backdrop" data-testid="workset-backdrop" {...backdropProps}>
      <div
        className="lw-modal lw-workset-modal"
        data-testid="workset-modal"
        role="dialog"
        aria-label="workset manager"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="lw-modal-head">
          <strong>Workset</strong>
          <div className="lw-workset-heading-actions">
            {state.appliedEpoch !== null && (
              <span className="lw-dim" data-testid="workset-epoch">
                applied epoch {state.appliedEpoch}
              </span>
            )}
            <button
              type="button"
              className="lw-close"
              data-testid="workset-close"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </div>
        <div className="lw-modal-body lw-workset-body">
          {state.phase === "loading" && (
            <p className="lw-empty" data-testid="workset-loading">
              loading workset…
            </p>
          )}
          {state.error !== null && (
            <p className="lw-error" data-testid="workset-error">
              {state.error}
            </p>
          )}
          {state.current === null && state.phase !== "loading" && (
            <button type="button" data-testid="workset-retry" onClick={() => void loadCurrent()}>
              Retry
            </button>
          )}
          {state.loaded && (
            <>
              <section>
                <h3>Current</h3>
                {state.current === null ? (
                  <p className="lw-empty" data-testid="workset-current-unavailable">
                    current graph awaiting refresh
                  </p>
                ) : (
                  <WorksetGraphView graph={state.current} scope="current" />
                )}
              </section>
              <section className="lw-workset-editor">
                <h3>Draft roots</h3>
                <form
                  className="lw-workset-root-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    addRoot();
                  }}
                >
                  <input
                    ref={inputRef}
                    type="text"
                    autoFocus
                    data-testid="workset-root-input"
                    aria-label="canonical ledger reference"
                    placeholder="ledger:ID"
                    disabled={mutating}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addRoot();
                    }}
                  />
                  <button
                    type="submit"
                    data-testid="workset-add-root"
                    disabled={mutating}
                  >
                    Add
                  </button>
                </form>
                {state.draftRoots.length === 0 ? (
                  <p className="lw-empty" data-testid="workset-draft-empty">
                    empty draft
                  </p>
                ) : (
                  <ul className="lw-workset-draft-roots">
                    {state.draftRoots.map((root) => (
                      <li key={root} data-testid={`workset-draft-root-${root}`}>
                        <code>{root}</code>
                        <button
                          type="button"
                          data-testid={`workset-remove-${root}`}
                          aria-label={`remove ${root}`}
                          disabled={mutating}
                          onClick={() => editDraft((roots) => roots.filter((entry) => entry !== root))}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="lw-workset-actions">
                  <button
                    type="button"
                    data-testid="workset-clear"
                    disabled={mutating || state.draftRoots.length === 0}
                    onClick={() => editDraft(() => [])}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    data-testid="workset-preview"
                    disabled={mutating}
                    onClick={() => void previewDraft()}
                  >
                    {state.phase === "previewing" ? "Previewing…" : "Preview"}
                  </button>
                  <button
                    type="button"
                    data-testid="workset-apply"
                    disabled={mutating || state.phase === "previewing" || !dirty}
                    onClick={() => void applyDraft()}
                  >
                    {mutating ? "Applying…" : "Apply"}
                  </button>
                </div>
              </section>
              {state.preview !== null && (
                <section>
                  <h3>Preview</h3>
                  <WorksetGraphView graph={state.preview} scope="preview" />
                </section>
              )}
              <span className="lw-dim" data-testid="workset-status">
                {state.phase}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
