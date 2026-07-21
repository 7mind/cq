---
description: Start a research-flow run — intake a research question (or resume an existing one), then run the /cq:research:advance round inline.
argument-hint: <research question | RS id>
allowed-tools: mcp__ledger__*, Agent, WebFetch, Write, Bash, Read, Grep, Glob
---

## Catalogue
```yaml
inputs:
  - "free-form research question (free text) OR bare research id RS (matching ^RS\\d+$)"
outputs:
  - "intake path: coordination milestone M + research item RS on the researches ledger"
  - "resume path: validates existing research RS (aborts if terminal)"
  - "research-flow advance round run inline (full /cq:research:advance output)"
  - "handoffs item and ledger git commit (this command is the outermost wrapper)"
ioSchema:
  - "intake path: creates a researches item with fields question (required), scope (optional)"
  - "researches lifecycle: open -> wip -> {concluded | inconclusive}; abandoned is user-initiated only"
  - "advance round output: hypothesis tree mutations, validated evidence, adjudication, and on a confirmed answer the findings/conclusion/recommendation"
  - "handoffs item: flow=research, ledgerRefs=researches:<RS>; /cq:research:advance suppresses its own handoff"
```

You are **bootstrapping a research-flow run**. The argument is:

> $ARGUMENTS

This command does the one-time **intake and bootstrap** only, then hands off to the
`/cq:research:advance` round inline. It owns NO research or loop logic of its own — the
entire round (hypothesis formation, explorer/experimenter dispatch, citation validation,
adjudication, conclusion, handoff) lives in `/cq:research:advance`, so that logic exists
in exactly ONE place.

## No confirmation checkpoints — just run (hard rule)
This flow is **fully autonomous by default**. Do NOT pause to ask the user to confirm
scope or "should I proceed?". A confirmation checkpoint is wasted latency and is
forbidden. The ONLY legitimate way to surface a blocker is a `questions` ledger item —
never an inline "do you want me to…?" prompt.

## Question vs research triage (Q267)
Before filing, decide which ledger the item belongs on — this command only ever files
`researches`, never `questions`, so get the triage right before intake:

- **`researches`** — the thing to file is an **empirical unknown**: a claim about the
  world (the codebase, a library, a runtime, a published result) that is *knowable* by
  reading, searching, or running something, and that nobody has yet determined. "Which
  of these three libraries handles backpressure correctly?", "does this race condition
  actually reproduce under load?", "what does the upstream API actually return for this
  edge case?" are research questions — answerable by evidence, not by asking the user.
- **`questions`** — the thing to file is a **preference or requirement** only the user
  can supply: which of several equally-valid scopings they want, an ambiguous or
  contradictory requirement, a policy/preference call, or a genuine "what do you want
  here?". No amount of reading or experimentation resolves it — only the user's answer
  does.

If `$ARGUMENTS` reads as a preference/requirements question rather than an empirical
unknown, tell the user this belongs on the `questions` ledger instead (e.g. via the
TUI/web or a `questions` item created directly) and do NOT create a `researches` item
for it.

## Provenance (every ledger write)
On any `create_item` / `update_item`, pass `author` = your OWN model class
(derived from runtime identity, never hardcoded — Claude Opus 4.8 (1M) →
`"opus-4.8[1m]"`; Codex GPT-5.x → e.g. `"gpt-5.5"`) and `session` =
`$CLAUDE_CODE_SESSION_ID` (or the Codex equivalent; omit if unavailable).

## Steps

### 1. Determine the input form

Inspect `$ARGUMENTS`:

- **Bare research id** (matches `^RS\d+$` or an existing `researches` ledger item) → go
  to **Resume path** (step 2b).
- **Anything else** (a free-form research question) → go to **Intake path** (step 2a).

### 2a. Intake path — create a new research item

#### 2a-1. Duplicate check
`fts_search` the `researches` ledger with the key terms from `$ARGUMENTS`. If a
non-terminal research item already exists that matches the question, tell the user its
id and run **Resume path** (step 2b) against that id instead of creating a duplicate.

#### 2a-2. Confirm the triage (Q267)
Re-check `$ARGUMENTS` against **§Question vs research triage** above. If it is actually
a preference/requirements question, STOP here and redirect the user to file it as a
`questions` item instead — do not proceed to intake.

#### 2a-3. Derive scope (optional)
If `$ARGUMENTS` (or its surrounding context) narrows the question to a specific area
(a package, a subsystem, a time/version bound), capture that as `scope`. If nothing
narrows it, omit `scope` — it is optional on the schema.

#### 2a-4. Derive a slug
From the question, form a short slug (≤ 5 words, kebab-case, no articles/stop-words).
Example: "does bun's fs watcher coalesce rapid writes" → `bun-watcher-coalesce-writes`.

#### 2a-5. Create the coordination milestone
```
create_milestone(title: "Research: <slug>")
```
Save the returned id as **M**.

#### 2a-6. Create the research item
```
create_item("researches", M,
  status: "open",
  fields: {
    question: "$ARGUMENTS (verbatim, plus any narrowing captured in 2a-3)",
    scope: "<derived scope, if any>",
  },
  author: <your model class>,
  session: <session id>,
)
```
Save the returned id as **RS**.

### 2b. Resume path — validate an existing research item

`fetch_item("researches", RS)` where RS is the id from `$ARGUMENTS`.

- If the item does not exist → abort with a clear error: "No research `<RS>` found in
  the ledger. Check the id and retry, or provide a research question to start a new
  research."
- If the item's status is terminal (`concluded` / `abandoned`) → abort: "Research `<RS>`
  is already terminal (status: `<status>`). Nothing to research. If you believe this was
  closed in error, reopen it first via the TUI/web."
- Otherwise (status `open` / `wip` / `inconclusive` — `inconclusive` is a re-openable
  hold, NOT terminal) → save its milestone as **M** and proceed.

### 3. Hand off to the advance round

Now execute the `/cq:research:advance` round for research **RS** — follow the full loop
spec in `/cq:research:advance` (READ state → FORM hypotheses → DISPATCH
explorers/experimenters → VALIDATE citations → adjudicate → CONCLUDE or NEEDS-user-input
park, plus its session-log writing and provenance rules). Do NOT restate or duplicate
that logic here; run it. Then produce `/cq:research:advance`'s end-of-round report.

This command is the outermost wrapper for this invocation (the user ran
`/cq:research`), so the inline `/cq:research:advance` round **SUPPRESSES its own
handoff write** (per `/cq:research:advance`'s §Handoff record — `/cq:research` is listed
as a suppress-context), and **this command** writes the ONE `handoffs` record at the
stop. Use the field schema from `/cq:research:advance`'s §Handoff record, STANDALONE
branch (do not restate the mapping here). **Then commit the ledger** — this command is
the outermost wrapper, so it owns the single run-stop ledger commit; immediately after
the handoff write, persist the ledger to git — **when `[ledger] backend` is `fs` (the
default); SKIP under `git-object`, whose orphan ref already carries each write** — ONLY
the ledger (`.cq/*.md` + `.cq/archive` + `.cq/logs`; NEVER `docs/ledgers.yaml`,
gitignored; NEVER code):
```
git add .cq/ 2>/dev/null  # ledger dir; .gitignore excludes ledgers.yaml + lockfiles/backups
git diff --cached --quiet -- .cq/ || git commit -q -m "chore(ledger): /cq:research — research RS<n> <intake|resume> + first round

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
The `git diff --cached --quiet` guard makes it a NO-OP when nothing changed.

The run is resumable: after the user answers any registered questions, they re-run
**`/cq:research:advance RS`** (no need to re-run `/cq:research`).

---

## Report
After the advance round completes, prepend a brief intake summary:
- **Research:** `<RS>` — `<question>` (scope: `<scope, if any>`, milestone: `<M>`)
- **Action:** created new research item (intake path) **or** resumed existing research
  item (resume path)
- Then the full `/cq:research:advance` round report.
