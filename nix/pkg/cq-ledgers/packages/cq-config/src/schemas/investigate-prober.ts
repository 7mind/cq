/**
 * investigate-prober role schema sidecar (T341, goal G41) — generalising the
 * T336 one-role proof across the dispatched-subagent roster (storage-format
 * decision 3: per-role typed sidecar under `./schemas/`).
 *
 * Authored DIRECTLY from `cq-assets/agents/investigate-prober.md` — its
 * `## Catalogue` block:
 *
 * - **Input** — the owning defect id `D`, hypothesis id `H`, and statement (verbatim), the
 *   `probeRequest { what, why }` the explorer raised (what to run and why it
 *   settles H), the branch context (incl. the base commit/branch for the
 *   throwaway worktree), and optional specific leads.
 *
 * - **Output** — the evidence block `{ hypothesisId, evidence[], lean, notes? }`
 *   — the SAME shape the explorer returns BUT WITHOUT `probeRequest` (the prober
 *   executes; it does not escalate further). `lean` is one of
 *   `supports | contradicts | mixed | insufficient`.
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";
import { EVIDENCE_LEANS, evidenceItemSchema } from "./investigate-evidence.js";

/**
 * The parent-supplied input contract for an investigate-prober dispatch: the
 * hypothesis id + statement, the explorer's probeRequest (the prober's primary
 * spec), the branch context (with the worktree base), and optional leads.
 */
const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/investigate-prober/input",
  title: "investigate-prober input",
  type: "object",
  properties: {
    defectId: {
      type: "string",
      description: "The canonical owning defect id (e.g. D3).",
      pattern: "^D[0-9]+$",
    },
    hypothesisId: { type: "string", pattern: "^H[0-9]+$" },
    statement: {
      type: "string",
      description: "The candidate root cause to test, verbatim.",
      minLength: 1,
    },
    probeRequest: {
      type: "object",
      description: "The explorer's probe request: what to run and why it settles H.",
      properties: {
        what: { type: "string", minLength: 1 },
        why: { type: "string", minLength: 1 },
      },
      required: ["what", "why"],
      additionalProperties: false,
    },
    branchContext: {
      type: "string",
      description:
        "The defect, parent hypothesis, sibling findings, and the base commit/branch the throwaway worktree was cut from.",
      minLength: 1,
    },
    leads: {
      type: "array",
      items: { type: "string" },
      description: "Optional specific leads to chase (files, symbols, commands).",
    },
  },
  required: ["defectId", "hypothesisId", "statement", "probeRequest", "branchContext"],
  additionalProperties: false,
} as const;

/**
 * The evidence-block output contract — the SAME shape the explorer returns BUT
 * WITHOUT `probeRequest` (the prober executes; it does not escalate further).
 */
const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/investigate-prober/output",
  title: "investigate-prober evidence",
  type: "object",
  properties: {
    hypothesisId: { type: "string", pattern: "^H[0-9]+$" },
    evidence: { type: "array", items: evidenceItemSchema },
    lean: { type: "string", enum: [...EVIDENCE_LEANS] },
    notes: { type: "string" },
  },
  required: ["hypothesisId", "evidence", "lean"],
  additionalProperties: false,
} as const;

/** The investigate-prober per-role schema sidecar (storage-format decision 3). */
export const investigateProberSidecar: RoleSchemaSidecar = {
  id: "investigate-prober",
  version: 2,
  inputSchema,
  outputSchema,
};
