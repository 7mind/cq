/**
 * investigate-explorer role schema sidecar (T341, goal G41) — generalising the
 * T336 one-role proof across the dispatched-subagent roster (storage-format
 * decision 3: per-role typed sidecar under `./schemas/`).
 *
 * Authored DIRECTLY from `cq-assets/agents/investigate-explorer.md` — its
 * `## Catalogue` block:
 *
 * - **Input** — the owning defect id `D`, hypothesis id `H`, and its statement (verbatim), the branch
 *   context (defect, parent hypothesis, sibling findings, confirm/rule-out
 *   intent), and optional specific leads.
 *
 * - **Output** — the evidence block
 *   `{ hypothesisId, evidence[], lean, notes?, probeRequest? }`. Each evidence
 *   item is `{ n, citation, excerpt, relevance }`; `lean` is one of
 *   `supports | contradicts | mixed | insufficient`; `probeRequest` (omitted by
 *   default) is `{ what, why }` and is only present when execution is needed to
 *   settle H — in which case `lean` MUST be `insufficient`.
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";
import { EVIDENCE_LEANS, evidenceItemSchema } from "./investigate-evidence.js";

/**
 * The parent-supplied input contract for an investigate-explorer dispatch: the
 * hypothesis id + statement, the branch context, and optional leads. The
 * hypothesis ledger is read by the orchestrator, not the subagent, so the
 * statement is passed verbatim rather than referenced by id alone.
 */
const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/investigate-explorer/input",
  title: "investigate-explorer input",
  type: "object",
  properties: {
    defectId: {
      type: "string",
      description: "The canonical owning defect id (e.g. D3).",
      pattern: "^D[0-9]+$",
    },
    hypothesisId: {
      type: "string",
      description: "The hypothesis id H passed in the dispatch prompt (e.g. H7).",
      pattern: "^H[0-9]+$",
    },
    statement: {
      type: "string",
      description: "The candidate root cause to test, verbatim.",
      minLength: 1,
    },
    branchContext: {
      type: "string",
      description:
        "The defect under investigation, parent hypothesis, sibling findings, and what to confirm/rule out.",
      minLength: 1,
    },
    leads: {
      type: "array",
      items: { type: "string" },
      description: "Optional specific leads to chase (files, symbols, error messages, URLs).",
    },
  },
  required: ["defectId", "hypothesisId", "statement", "branchContext"],
  additionalProperties: false,
} as const;

/**
 * The explorer-specific probe request: the read-only explorer escalates to the
 * execution-capable prober when static inspection cannot settle H. Present in
 * the output ONLY when execution is needed (and then `lean` is `insufficient`).
 */
const probeRequestSchema = {
  type: "object",
  properties: {
    what: {
      type: "string",
      description: "Commands / builds / tests the orchestrator must RUN to gather decisive evidence.",
      minLength: 1,
    },
    why: {
      type: "string",
      description: "Why read-only static inspection cannot settle H — what execution would reveal.",
      minLength: 1,
    },
  },
  required: ["what", "why"],
  additionalProperties: false,
} as const;

/**
 * The evidence-block output contract — the read-only explorer shape, which adds
 * the optional `probeRequest` (the prober omits it). `lean` summarises the
 * direction of the gathered evidence.
 */
const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/investigate-explorer/output",
  title: "investigate-explorer evidence",
  type: "object",
  properties: {
    hypothesisId: { type: "string", pattern: "^H[0-9]+$" },
    evidence: { type: "array", items: evidenceItemSchema },
    lean: { type: "string", enum: [...EVIDENCE_LEANS] },
    notes: { type: "string" },
    probeRequest: probeRequestSchema,
  },
  required: ["hypothesisId", "evidence", "lean"],
  additionalProperties: false,
} as const;

/** The investigate-explorer per-role schema sidecar (storage-format decision 3). */
export const investigateExplorerSidecar: RoleSchemaSidecar = {
  id: "investigate-explorer",
  version: 2,
  inputSchema,
  outputSchema,
};
