---
description: Universal intake splitter — segment a mixed request into plan-flow, investigate-flow, and research-flow intakes, then chain ONE /cq:advance sequencer pass over the whole batch.
argument-hint: <mixed request: features, bug reports, research questions>
allowed-tools: mcp__ledger__*, Agent, Bash, Read, Grep, Glob
---

## Catalogue
```yaml
inputs:
  - "free-form mixed request ($ARGUMENTS) — any blend of feature asks, fault reports, and empirical research questions in ONE message"
outputs:
  - "per clear NEW segment: one intake — plan-flow goal G (per /cq:plan §Steps 1-2), defect D (per /cq:investigate intake path 2a), or research RS (per /cq:research intake path 2a) — all by cross-reference"
  - "per clear goal-EXTENSION segment: the scope appended + goal re-opened per /cq:plan:follow-up's bootstrap (steps 1-4), deferring its clarifying round to the chained sequencer pass"
  - "at most ONE compact `questions` item collecting ALL genuinely ambiguous segments (Q300) — those segments are NOT intaked this run"
  - "ONE chained /cq:advance sequencer pass over the whole intaked batch (Q299 option c); it writes the run-level handoffs record"
  - "routing-table report: segment → ledger item id → flow, plus the ambiguity question id if any"
  - "OWN handoffs item ONLY when no /cq:advance pass ran (answers-required with the ambiguity question id)"
ioSchema:
  - "segmentation: split $ARGUMENTS into discrete request segments; each segment classifies independently"
  - "classification (Q267 vocabulary): greenfield capability → goals; fault to fix → defects; EMPIRICALLY answerable unknown → researches; a PREFERENCE/requirements ask is never a research — it joins the ambiguity question"
  - "dedup (Q300): exact duplicate → report + skip; clear extension of a live goal → /cq:plan:follow-up <G> route; otherwise fresh intake"
  - "intake is by CROSS-REFERENCE only — this command re-derives NO flow's intake logic (goal: title+description; defect: headline+description+severity; research: question+scope?)"
  - "single-handoff rule: the chained /cq:advance pass writes the ONE run-level handoff (Q85); this command writes its own ONLY on the no-advance-ran path (flow=begin, blockingQuestions=[ambiguity question id])"
```

You are the **universal intake splitter**. The user's mixed request is:

> $ARGUMENTS

A single message may bundle several unrelated asks — two new features, a bug
report, and an open empirical question, all in one paragraph. This command
SPLITS that message into discrete segments, routes each segment to the right
flow's intake, and then hands the WHOLE batch to one `/cq:advance` sequencer
pass so every segment's clarifying questions surface together (Q299, option c).

This command is a **command-of-commands (K12)**: it may chain other commands
inline in this same main session, and it **spawns NO subagents of its own** —
every subagent is dispatched by the sub-commands the chained `/cq:advance` pass
runs, never directly by this command. It owns NO flow logic of its own: each
flow's intake is performed strictly BY CROSS-REFERENCE to that flow's own
command (DRY — the intake logic exists in exactly one place, there).

If `$ARGUMENTS` is empty, ask the user what to intake and stop.

## No confirmation checkpoints — just run (hard rule)
Do NOT pause to confirm scope or routing ("should I file this as a defect?").
The ONLY legitimate user-facing pause is the single ambiguity `questions` item
of step 3 — never an inline "do you want me to…?" prompt. Clear segments route
immediately.

## Provenance (every ledger write)
On any `create_item` / `create_milestone` / `update_item`, pass `author` = your
OWN model class (derived from runtime identity, never hardcoded — Claude Opus
4.8 (1M) → `"opus-4.8[1m]"`; Codex GPT-5.x → e.g. `"gpt-5.5"`) and `session` =
`$CLAUDE_CODE_SESSION_ID` (or the Codex equivalent; omit if unavailable).

## Steps

### 1. SEGMENT the request
Split `$ARGUMENTS` into discrete request segments — one segment per
independently actionable ask. Sentence boundaries, enumerations ("also…",
"and another thing…", bullet lists), and topic shifts are the usual seams. Keep
each segment's text verbatim; do not paraphrase away detail. A single-topic
message yields exactly one segment — that is fine; this command still applies.

### 2. CLASSIFY each segment (Q267 vocabulary)
Classify every segment into exactly one route:

| Segment reads as | Route | Intake spec (cross-reference) |
|---|---|---|
| **Greenfield capability** — build/change something new | plan-flow goal | `/cq:plan` §Steps 1–2 |
| **Fault to fix** — an existing behavior is wrong | investigate-flow defect | `/cq:investigate` intake path (step 2a) |
| **Empirically answerable question** — verifiable by experiment (benchmark, API behavior, feasibility) | research-flow item | `/cq:research` intake path (step 2a) |

- **Feature vs defect:** apply `/cq:plan`'s §Defect-vs-goal test — a fault to
  repair is a defect, never a goal; a new capability is a goal, never a defect.
- **Research vs user question (Q267):** triage the unknown by WHO can answer
  it. An EMPIRICALLY answerable unknown — a verifiable-by-experiment fact about
  the code or the world (benchmarks, API behavior, feasibility, mirroring the
  plan-flow triage in `agents/plan-advance.md` §Q267) — routes to `researches`.
  A PREFERENCE or requirements decision only the user can make is NOT a
  research and NOT separately intaked: fold it into the step-3 ambiguity
  question, since only the user's answer can route it.
- **Genuinely ambiguous** — feature-vs-defect unclear, or too vague to route at
  all — goes to the step-3 ambiguity bucket, not to a best-guess intake.

### 3. DEDUP + ambiguity triage (Q300)
BEFORE intaking anything, run this over every segment:

- **Dedup each clear segment** via `fts_search` against the route's target
  ledger (`goals` / `defects` / `researches`) using the segment's key terms:
  - an **exact duplicate** of a live item → report the existing id in the
    routing table and SKIP the segment (no intake);
  - a **clear EXTENSION of an existing live goal** (more scope for something a
    non-terminal goal already covers) → route it to **`/cq:plan:follow-up <G>`**
    instead of a fresh goal (see step 4);
  - otherwise → fresh intake (step 4).
- **Collect ALL genuinely ambiguous segments into ONE compact `questions`
  item** — not one question per segment. Create a coordination milestone
  (`create_milestone(title: "Begin: ambiguous intake")`), then
  `create_item("questions", M, status: "open", fields: { question: "<each
  ambiguous segment verbatim, one bullet each, with the plausible routes>",
  suggestions: [...] })`. These segments are **NOT intaked this run**; after the
  user answers, they re-run `/cq:begin` (or the named flow) with the routing
  resolved. Clear segments are never held back by ambiguous ones — they route
  immediately.

### 4. INTAKE every clear segment (Q299, option c — no inline first pass)
Intake ALL clear segments FIRST, performing each flow's **bootstrap-intake
steps by cross-reference** — do NOT re-derive their logic here, and do NOT run
any flow's inline first pass per segment (no planner handoff, no advance round
yet — the batch gets ONE sequencer pass in step 5):

- **plan-flow segment** → run `/cq:plan` **§Steps 1–2 only** (coordination
  milestone + goal in `clarifying`). Skip its step 3+ (planner handoff and
  after) — the chained `/cq:advance` plan stage drives the clarifying round.
- **goal-extension segment** → run `/cq:plan:follow-up <G>` **steps 1–4 only**
  (parse/validate, phase gate, append the scope, re-open to `clarifying`).
  Skip its step 5+ (planner handoff and after) — same deferral.
- **defect segment** → run `/cq:investigate`'s **intake path (step 2a) only**
  (duplicate check already done in step 3; severity inference, slug,
  coordination milestone, defect item). Skip its step 3 (the inline advance
  pass) — the chained `/cq:advance` investigate stage drives the first round.
- **research segment** → run `/cq:research`'s **intake path (step 2a) only**
  (triage re-check, scope, slug, coordination milestone, research item). Skip
  its step 3 (the inline advance round) — the chained `/cq:advance` research
  stage drives it.

Record every created/updated id (G / D / RS) for the routing table.

### 5. Chain ONE /cq:advance sequencer pass over the batch
If step 4 intaked at least one segment, run **`/cq:advance` INLINE, exactly
once**, per its own command spec — do NOT re-implement its cycle; RUN it. The
sequencer picks up the whole batch through its detection predicates
(P-investigate / P-plan / P-research / …), so all segments' first rounds run in
one pass and their clarifying questions surface together. K12 holds: only this
command (a command) chains `/cq:advance`; it still spawns no subagents itself.

If step 4 intaked NOTHING (every segment was a duplicate or ambiguous), skip
this step.

**Session logs.** This command spawns no subagents, so it writes no session-log
artifact of its own. Each sub-flow chained under `/cq:advance` logs ITS
subagents per its own rule — logical paths `.cq/logs/<ts>-<agent-id>.md` /
`.cq/logs/raw/<ts>-<agent-id>.jsonl`, BOTH written via `cq log put` into the
primary store's out-of-tree logs area, read back via `read_log`.

### 6. Report the routing table
Report one line per segment:

| Segment (short restatement) | Ledger item | Flow |
|---|---|---|
| … | `goals:<G>` / `defects:<D>` / `researches:<RS>` / existing id (duplicate — skipped) / — (ambiguous) | plan / plan:follow-up / investigate / research / question |

Plus: the ambiguity `questions` item id if step 3 filed one (with the
instruction to answer it and re-run `/cq:begin`), and the chained
`/cq:advance` pass's own end-of-run report if step 5 ran.

### 7. Handoff record — SINGLE-HANDOFF rule
Exactly ONE run-level `handoffs` record is written per invocation:

- **If the step-5 `/cq:advance` pass ran** (the normal path): that pass writes
  the ONE run-level handoff itself, per Q85 and its own §End-of-run write —
  this command DEFERS to it and writes NO handoff of its own, even though it is
  the outermost wrapper.
- **If NO `/cq:advance` pass ran** (e.g. every segment was ambiguous): THIS
  command writes the one `handoffs` record — status `answers-required`, `flow`
  = `begin`, `blockingQuestions` = [the step-3 ambiguity question id],
  `ledgerRefs` = the question's `questions:<Q>` ref, `summary` = why nothing
  was intaked. If nothing was intaked AND no question was filed either (every
  segment was an exact duplicate), there is no blocked work to hand off —
  report the routing table and write NO handoff.

Do not form hypotheses, file per-flow clarifying questions, plan, or implement
anything yourself — the flows chained under `/cq:advance` own everything after
intake.
