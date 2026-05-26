/**
 * ElicitationCard.tsx — MCP elicitation card.
 *
 * Rendered by ChatTab when a `chat.elicitation_request` frame arrives.
 * Supports two modes per the SDK ElicitationRequest shape:
 *
 * Form mode (`requestedSchema` present, mode === 'form'):
 *   Renders a JSON-Schema → form mapper supporting:
 *   - type:'string' → <input type="text"> (or <select> if enum is present)
 *   - type:'number' → <input type="number">
 *   - type:'boolean' → <input type="checkbox">
 *   - fallback (complex schema) → <textarea> with a schema-not-supported hint
 *   Accept / Decline / Cancel buttons.
 *
 * URL mode (`url` present, mode === 'url'):
 *   Shows "Open in new tab" button → window.open(url, '_blank', 'noopener').
 *   Shows "Waiting for completion…" text.
 *   Cancel button sends {action:'cancel'}.
 */

import { useState } from "react";
import styles from "../../styles/ElicitationCard.module.css";
import type { ChatElicitationRequest } from "@cq/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ElicitationAction = "accept" | "decline" | "cancel";

export interface ElicitationReply {
  action: ElicitationAction;
  content?: Record<string, unknown>;
}

export interface ElicitationCardProps {
  frame: ChatElicitationRequest;
  onReply: (reply: ElicitationReply) => void;
}

// ---------------------------------------------------------------------------
// JSON-Schema → form mapper
// ---------------------------------------------------------------------------

interface SchemaProperty {
  type?: string;
  enum?: unknown[];
  description?: string;
  default?: unknown;
}

interface ObjectSchema {
  type: "object";
  properties: Record<string, SchemaProperty>;
  required?: string[];
}

function isObjectSchema(schema: Record<string, unknown>): boolean {
  return (
    schema["type"] === "object" &&
    schema["properties"] !== null &&
    typeof schema["properties"] === "object"
  );
}

function isSupportedProperty(prop: SchemaProperty): boolean {
  return (
    prop.type === "string" ||
    prop.type === "number" ||
    prop.type === "boolean"
  );
}

// ---------------------------------------------------------------------------
// FormFields sub-component
// ---------------------------------------------------------------------------

interface FormFieldsProps {
  schema: ObjectSchema;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

function FormFields({ schema, values, onChange }: FormFieldsProps): React.ReactElement {
  const entries = Object.entries(schema.properties);

  return (
    <div className={styles.form} data-testid="elicitation-form">
      {entries.map(([key, prop]) => {
        const currentValue = values[key];

        if (!isSupportedProperty(prop)) {
          return (
            <div key={key} className={styles.field}>
              <label className={styles.label}>{key}</label>
              <textarea
                className={styles.textarea}
                data-testid={`elicitation-field-${key}`}
                value={typeof currentValue === "string" ? currentValue : ""}
                onChange={(e) => { onChange(key, e.target.value); }}
                placeholder="(complex type — enter JSON)"
              />
              <span className={styles.schemaHint}>
                Schema type not directly supported — enter raw value.
              </span>
            </div>
          );
        }

        if (prop.type === "boolean") {
          return (
            <div key={key} className={styles.field}>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  data-testid={`elicitation-field-${key}`}
                  checked={currentValue === true}
                  onChange={(e) => { onChange(key, e.target.checked); }}
                />
                {key}
                {prop.description !== undefined && (
                  <span className={styles.schemaHint}>{prop.description}</span>
                )}
              </label>
            </div>
          );
        }

        if (prop.type === "string" && Array.isArray(prop.enum) && prop.enum.length > 0) {
          return (
            <div key={key} className={styles.field}>
              <label className={styles.label}>{key}</label>
              <select
                className={styles.select}
                data-testid={`elicitation-field-${key}`}
                value={typeof currentValue === "string" ? currentValue : ""}
                onChange={(e) => { onChange(key, e.target.value); }}
              >
                <option value="">— select —</option>
                {prop.enum.map((v) => (
                  <option key={String(v)} value={String(v)}>
                    {String(v)}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (prop.type === "number") {
          return (
            <div key={key} className={styles.field}>
              <label className={styles.label}>{key}</label>
              <input
                type="number"
                className={styles.input}
                data-testid={`elicitation-field-${key}`}
                value={typeof currentValue === "number" ? currentValue : ""}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  onChange(key, isNaN(n) ? "" : n);
                }}
              />
            </div>
          );
        }

        // Default: string text input
        return (
          <div key={key} className={styles.field}>
            <label className={styles.label}>{key}</label>
            <input
              type="text"
              className={styles.input}
              data-testid={`elicitation-field-${key}`}
              value={typeof currentValue === "string" ? currentValue : ""}
              onChange={(e) => { onChange(key, e.target.value); }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build default values from schema
// ---------------------------------------------------------------------------

function buildDefaults(schema: ObjectSchema): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.default !== undefined) {
      defaults[key] = prop.default;
    } else if (prop.type === "boolean") {
      defaults[key] = false;
    } else if (prop.type === "number") {
      defaults[key] = "";
    } else {
      defaults[key] = "";
    }
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// FormModeCard
// ---------------------------------------------------------------------------

interface FormModeCardProps {
  frame: ChatElicitationRequest;
  schema: ObjectSchema;
  onReply: (reply: ElicitationReply) => void;
}

function FormModeCard({ frame, schema, onReply }: FormModeCardProps): React.ReactElement {
  const [values, setValues] = useState<Record<string, unknown>>(() => buildDefaults(schema));

  function handleChange(key: string, value: unknown): void {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleAccept(): void {
    // Filter out empty-string placeholders for numbers.
    const content: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value !== "") {
        content[key] = value;
      }
    }
    onReply({ action: "accept", content });
  }

  return (
    <>
      <div className={styles.body}>
        <div className={styles.message}>{frame.message}</div>
        <FormFields schema={schema} values={values} onChange={handleChange} />
      </div>
      <div className={styles.actions}>
        <button
          className={`${styles.btn} ${styles.btnAccept}`}
          onClick={handleAccept}
          data-testid="elicitation-accept"
        >
          Accept
        </button>
        <button
          className={`${styles.btn} ${styles.btnDecline}`}
          onClick={() => { onReply({ action: "decline" }); }}
          data-testid="elicitation-decline"
        >
          Decline
        </button>
        <button
          className={`${styles.btn} ${styles.btnCancel}`}
          onClick={() => { onReply({ action: "cancel" }); }}
          data-testid="elicitation-cancel"
        >
          Cancel
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// UrlModeCard
// ---------------------------------------------------------------------------

interface UrlModeCardProps {
  frame: ChatElicitationRequest;
  url: string;
  onReply: (reply: ElicitationReply) => void;
}

function UrlModeCard({ frame, url, onReply }: UrlModeCardProps): React.ReactElement {
  return (
    <>
      <div className={styles.body}>
        <div className={styles.message}>{frame.message}</div>
        <button
          className={`${styles.btn} ${styles.btnOpenTab}`}
          onClick={() => { window.open(url, "_blank", "noopener"); }}
          data-testid="elicitation-open-tab"
        >
          Open in new tab
        </button>
        <div className={styles.waiting}>Waiting for completion in the linked tab…</div>
      </div>
      <div className={styles.actions}>
        <button
          className={`${styles.btn} ${styles.btnCancel}`}
          onClick={() => { onReply({ action: "cancel" }); }}
          data-testid="elicitation-cancel"
        >
          Cancel
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// ElicitationCard (top-level)
// ---------------------------------------------------------------------------

export function ElicitationCard({ frame, onReply }: ElicitationCardProps): React.ReactElement {
  const title = frame.title ?? "MCP server needs input";
  const rawSchema = frame.requestedSchema;
  const isFormMode =
    rawSchema !== undefined &&
    isObjectSchema(rawSchema as Record<string, unknown>);
  const isUrlMode =
    frame.mode === "url" && typeof frame.url === "string";

  return (
    <div className={styles.root} data-testid="elicitation-card">
      <div className={styles.header}>
        <span className={styles.icon}>🔗</span>
        <span className={styles.title}>{title}</span>
        <span className={styles.serverName}>{frame.mcpServerName}</span>
      </div>
      {isFormMode ? (
        <FormModeCard
          frame={frame}
          schema={rawSchema as unknown as ObjectSchema}
          onReply={onReply}
        />
      ) : isUrlMode ? (
        <UrlModeCard frame={frame} url={frame.url as string} onReply={onReply} />
      ) : (
        // Fallback: no schema, no URL — show message with cancel only.
        <>
          <div className={styles.body}>
            <div className={styles.message}>{frame.message}</div>
          </div>
          <div className={styles.actions}>
            <button
              className={`${styles.btn} ${styles.btnCancel}`}
              onClick={() => { onReply({ action: "cancel" }); }}
              data-testid="elicitation-cancel"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
