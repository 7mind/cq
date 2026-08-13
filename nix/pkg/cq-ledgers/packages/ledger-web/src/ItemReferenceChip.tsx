import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ItemReference } from "./itemReferences.js";
import type { ReferencePreviewResult } from "./referenceLookup.js";

const VIEWPORT_GAP = 8;
const PREVIEW_GAP = 6;
const PREVIEW_WIDTH = 304;
const PREVIEW_HEIGHT = 192;

interface PreviewPosition {
  left: number;
  top: number;
}

function popupPosition(rect: DOMRect): PreviewPosition {
  const maxLeft = Math.max(VIEWPORT_GAP, window.innerWidth - PREVIEW_WIDTH - VIEWPORT_GAP);
  const left = Math.min(Math.max(VIEWPORT_GAP, rect.left), maxLeft);
  const below = rect.bottom + PREVIEW_GAP;
  const top = below + PREVIEW_HEIGHT <= window.innerHeight - VIEWPORT_GAP
    ? below
    : Math.max(VIEWPORT_GAP, rect.top - PREVIEW_HEIGHT - PREVIEW_GAP);
  return { left, top };
}

export interface ItemReferenceChipProps {
  text: string;
  reference: ItemReference;
  resolve?: (reference: ItemReference) => Promise<ReferencePreviewResult>;
  onNavigate?: (ledger: string, id: string) => void;
}

export function ItemReferenceChip({
  text,
  reference,
  resolve,
  onNavigate,
}: ItemReferenceChipProps): React.ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previewId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PreviewPosition>({ left: VIEWPORT_GAP, top: VIEWPORT_GAP });
  const [result, setResult] = useState<ReferencePreviewResult | null>(null);

  const load = async (): Promise<ReferencePreviewResult | null> => {
    if (resolve === undefined) return null;
    const resolved = await resolve(reference);
    setResult(resolved);
    return resolved;
  };

  const show = (): void => {
    const trigger = triggerRef.current;
    if (trigger !== null) setPosition(popupPosition(trigger.getBoundingClientRect()));
    setOpen(true);
    void load();
  };

  const activate = async (): Promise<void> => {
    setOpen(true);
    const resolved = result ?? await load();
    if (resolved?.kind === "found") onNavigate?.(resolved.ledger, resolved.id);
  };

  useEffect(() => {
    setOpen(false);
    setResult(null);
  }, [reference.ledger, reference.id]);

  const preview = open && resolve !== undefined
    ? createPortal(
        <div
          id={previewId}
          className="lw-ref-preview"
          role="tooltip"
          style={{ position: "fixed", left: position.left, top: position.top }}
        >
          {result === null ? (
            <span className="lw-dim">loading {reference.ledger}:{reference.id}…</span>
          ) : result.kind === "found" ? (
            <>
              <strong>{result.ledger}:{result.id}</strong>
              <span className="lw-ref-preview-status">{result.status}</span>
              <span>{result.summary}</span>
            </>
          ) : result.kind === "not-found" ? (
            <span>not found: {result.ledger}:{result.id}</span>
          ) : (
            <span>preview unavailable: {result.message}</span>
          )}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="lw-ref-chip"
        aria-describedby={open && resolve !== undefined ? previewId : undefined}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={() => void activate()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          } else if (event.key === "Enter") {
            event.preventDefault();
            void activate();
          }
        }}
      >
        {text}
      </button>
      {preview}
    </>
  );
}
