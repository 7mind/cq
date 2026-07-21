/**
 * research-explorer role schema sidecar (T566, goal M245) — the research-flow
 * counterpart of the investigate-explorer sidecar, generalising the
 * dispatched-subagent schema pattern (T341, storage-format decision 3) to the
 * research pair.
 *
 * Authored DIRECTLY from `cq-assets/agents/research-explorer.md` — its
 * `## Catalogue` block:
 *
 * - **Input** — the hypothesis id `H` and its statement (verbatim), the branch
 *   context (research question, parent hypothesis, sibling findings,
 *   confirm/rule-out intent), and optional specific leads. SAME shape as
 *   investigate-explorer's input.
 *
 * - **Output** — the shared investigate-evidence block
 *   `{ hypothesisId, evidence[], lean, notes?, probeRequest? }`, INCLUDING
 *   `probeRequest` (present only when execution is needed to settle H — in
 *   which case `lean` MUST be `insufficient`). SAME shape as
 *   investigate-explorer's output.
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";
import { EVIDENCE_LEANS, evidenceItemSchema } from "./investigate-evidence.js";

/**
 * The parent-supplied input contract for a research-explorer dispatch: the
 * hypothesis id + statement, the branch context, and optional leads. The
 * hypothesis ledger is read by the orchestrator, not the subagent, so the
 * statement is passed verbatim rather than referenced by id alone.
 */
const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/research-explorer/input",
  title: "research-explorer input",
  type: "object",
  properties: {
    hypothesisId: {
      type: "string",
      description: "The hypothesis id H passed in the dispatch prompt (e.g. H7).",
      pattern: "^H[0-9]+$",
    },
    statement: {
      type: "string",
      description: "The candidate answer to the research question to test, verbatim.",
      minLength: 1,
    },
    branchContext: {
      type: "string",
      description:
        "The research question under study, parent hypothesis, sibling findings, and what to confirm/rule out.",
      minLength: 1,
    },
    leads: {
      type: "array",
      items: { type: "string" },
      description: "Optional specific leads to chase (files, symbols, search terms, URLs).",
    },
  },
  required: ["hypothesisId", "statement", "branchContext"],
  additionalProperties: false,
} as const;

/**
 * The explorer-specific probe request: the read-only explorer escalates to the
 * execution-capable research-experimenter when static (repo + web) inspection
 * cannot settle H. Present in the output ONLY when execution is needed (and
 * then `lean` is `insufficient`).
 */
const probeRequestSchema = {
  type: "object",
  properties: {
    what: {
      type: "string",
      description: "Experiment / benchmark / build / test the orchestrator must RUN to gather decisive evidence.",
      minLength: 1,
    },
    why: {
      type: "string",
      description: "Why read-only static and web inspection cannot settle H — what execution would reveal.",
      minLength: 1,
    },
  },
  required: ["what", "why"],
  additionalProperties: false,
} as const;

/**
 * The evidence-block output contract — the shared investigate-evidence shape,
 * which adds the optional `probeRequest` (the research-experimenter omits it).
 * `lean` summarises the direction of the gathered evidence.
 */
const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/research-explorer/output",
  title: "research-explorer evidence",
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

/** The research-explorer per-role schema sidecar (storage-format decision 3). */
export const researchExplorerSidecar: RoleSchemaSidecar = {
  id: "research-explorer",
  version: 1,
  inputSchema,
  outputSchema,
};
