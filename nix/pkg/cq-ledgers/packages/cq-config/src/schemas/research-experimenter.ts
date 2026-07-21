/**
 * research-experimenter role schema sidecar (T566, goal M245) — the
 * research-flow counterpart of the investigate-prober sidecar, generalising the
 * dispatched-subagent schema pattern (T341, storage-format decision 3) to the
 * research pair.
 *
 * Authored DIRECTLY from `cq-assets/agents/research-experimenter.md` — its
 * `## Catalogue` block:
 *
 * - **Input** — the hypothesis id `H` and statement (verbatim), the
 *   `probeRequest { what, why }` the research-explorer raised (what to run and
 *   why it settles H), the branch context (incl. the base commit/branch for the
 *   throwaway worktree), and optional specific leads. SAME shape as
 *   investigate-prober's input.
 *
 * - **Output** — the evidence block `{ hypothesisId, evidence[], lean, notes? }`
 *   — the SAME shape the research-explorer returns BUT WITHOUT `probeRequest`
 *   (the experimenter executes; it does not escalate further). `lean` is one of
 *   `supports | contradicts | mixed | insufficient`. SAME shape as
 *   investigate-prober's output.
 */

import type { RoleSchemaSidecar } from "../promptCatalog.js";
import { EVIDENCE_LEANS, evidenceItemSchema } from "./investigate-evidence.js";

/**
 * The parent-supplied input contract for a research-experimenter dispatch: the
 * hypothesis id + statement, the explorer's probeRequest (the experimenter's
 * primary spec), the branch context (with the worktree base), and optional
 * leads.
 */
const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/research-experimenter/input",
  title: "research-experimenter input",
  type: "object",
  properties: {
    hypothesisId: { type: "string", pattern: "^H[0-9]+$" },
    statement: {
      type: "string",
      description: "The candidate answer to the research question to test, verbatim.",
      minLength: 1,
    },
    probeRequest: {
      type: "object",
      description: "The research-explorer's probe request: what to run and why it settles H.",
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
        "The research question, parent hypothesis, sibling findings, and the base commit/branch the throwaway worktree was cut from.",
      minLength: 1,
    },
    leads: {
      type: "array",
      items: { type: "string" },
      description: "Optional specific leads to chase (files, symbols, commands, packages, URLs).",
    },
  },
  required: ["hypothesisId", "statement", "probeRequest", "branchContext"],
  additionalProperties: false,
} as const;

/**
 * The evidence-block output contract — the SAME shape the research-explorer
 * returns BUT WITHOUT `probeRequest` (the experimenter executes; it does not
 * escalate further).
 */
const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "cq:prompt-catalog/research-experimenter/output",
  title: "research-experimenter evidence",
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

/** The research-experimenter per-role schema sidecar (storage-format decision 3). */
export const researchExperimenterSidecar: RoleSchemaSidecar = {
  id: "research-experimenter",
  version: 1,
  inputSchema,
  outputSchema,
};
