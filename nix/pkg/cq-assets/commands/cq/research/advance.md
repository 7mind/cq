---
description: Advance a research-flow run one research round — read research state, form/extend the hypothesis tree of candidate answers, dispatch read-only explorers (and execution-capable experimenters on a probeRequest), validate every citation against source, adjudicate node status, and on a confirmed answer write findings/conclusion/recommendation and route the full cited synthesis through `cq log put`.
argument-hint: <researchId>   # the research RS under study
allowed-tools: mcp__ledger__*, Agent, WebFetch, Write, Bash, Read, Grep, Glob
---

## Catalogue
```yaml
inputs:
  - "research id RS ($ARGUMENTS first token)"
  - "research ledger item: question, scope, and any existing findings/conclusion/recommendation"
  - "hypothesis tree: all hypothesis items ledgerRefs=researches:<RS> with parentHypothesis ancestry"
  - "linked questions for RS (open ones park the loop; answered ones fold into framing)"
outputs:
  - "hypothesis tree mutations: new nodes (create_item) and status updates (update_item)"
  - "validated evidence stored on hypothesis items (evidence[] free-text, [correct]/[incorrect] prefix — Q262)"
  - "research status transitions: open->wip->{concluded | inconclusive}"
  - "on concluded: researches.findings + conclusion + recommendation written; the FULL cited synthesis routed through `cq log put` to .cq/logs/<ts>-research-<RS>.md (recorded in sessionLogs) — NO working-tree write (Q269)"
  - "per explorer/experimenter: a summary log .cq/logs/<timestamp>-<agent-id>.md AND a raw transcript .cq/logs/raw/<timestamp>-<agent-id>.jsonl, BOTH written via `cq log put`"
ioSchema:
  - "ONE research round per invocation; idempotent and resumable from ledger state"
  - "explorer concurrency: parallel for disjoint root seeds; serial while drilling a single branch (Q27 mirror)"
  - "explorer evidence JSON: {hypothesisId, evidence[], lean, notes?, probeRequest?} (experimenter returns the same shape WITHOUT probeRequest)"
  - "experimenter dispatched (isolation=worktree; NETWORK + in-worktree installs ALLOWED — Q263) only when an explorer returns a probeRequest"
  - "conclude synthesis routed through `cq log put`; NO working-tree write anywhere (Q269)"
```

You are the **research-flow orchestrator** — the DFS/adjudication brain of the
research loop. You are given a research id **RS** (`$ARGUMENTS`, first token). You
own hypothesis formation, explorer dispatch, citation validation, and node
adjudication; subagents CANNOT spawn subagents, so the whole loop lives HERE in
the main session.

> **DISPATCHING A SUBAGENT IS HARNESS-NEUTRAL.** Wherever this command says
> "dispatch an explorer/experimenter" or "use the `Agent` tool with
> `subagent_type: <name>`", use the tool your harness (`CQ_HARNESS`) provides:
> **claude** → `Agent(subagent_type: "<name>", …)`; **pi** →
> `dispatch_agent(agent: "<name>", task: "<the full prompt>")` (the
> cq-subagent-dispatch extension runs the same cq agent as an isolated child
> turn). **Do NOT hand-simulate a subagent's job inline** by reading the repo /
> the web yourself in its place — if a step calls for a dispatch, DISPATCH.

> **FORWARD-PROGRESS INVARIANT — each round must dispatch or WRITE, else STOP.**
> Re-reading ledger/repo/web state is not progress. A research round must dispatch
> explorers/experimenters or make a state-changing ledger WRITE (extend the
> hypothesis tree, adjudicate a node, write findings/conclusion/recommendation,
> file a question). If there is nothing to advance — no open hypothesis to probe,
> the research is concluded/parked, or a stop predicate holds — **STOP** and write
> the handoff; do NOT re-read "to check". Two consecutive read-only passes with no
> write and no dispatch mean you are ill-looping: STOP and report where you are.

**This command is idempotent and fully resumable** — it re-derives ALL state
from the ledger on each invocation (the research item, its `hypothesis` tree, its
linked `questions`). Run it repeatedly; each invocation picks up exactly where the
durable ledger state left off. **ONE invocation = ONE research round.**

## Conventions this command obeys (decision Q264)
- **The tree IS the `hypothesis` ledger.** Each candidate answer to the research
  question is a `hypothesis` item; `parentHypothesis` encodes ancestry; `evidence[]`
  holds validated citations as FREE TEXT, each prefixed `[correct]`/`[incorrect]`
  (the shared E-item convention — Q262); `status` is `open|uncertain|confirmed|wrong`
  (terminal: `confirmed`/`wrong`); every node `ledgerRefs` its research
  `researches:<RS>`. **NO hypothesis schema change** — this flow reuses the existing
  `HYPOTHESIS_SCHEMA` fields (`headline`, `description`, `rationale`,
  `parentHypothesis`, `evidence[]`, `sessionLogs[]`, `rawLogs[]`, `ledgerRefs`) as-is.
- **The COMMAND owns the loop.** `research-explorer` is a READ-ONLY
  evidence-gatherer — it makes no repo edits, no ledger writes, and does NOT
  adjudicate. There is NO separate reviewer subagent: this command validates
  citations and sets node status itself (mirroring how plan/implement/investigate
  keep the loop in the command).
- **Explorer concurrency (Q27 mirror):** dispatch explorers in PARALLEL **only**
  when seeding disjoint top-level (root) candidate answers. While DRILLING a single
  branch (a node and its children), dispatch **serially** — each child's framing
  depends on the parent's validated findings.
- **Explorer is READ-ONLY; the experimenter EXECUTES (Q263).** When a
  `research-explorer` cannot settle H by reading alone (repo + web) — it needs a
  thing RUN (an experiment, a benchmark, `bun test`, a build, reproducing a
  published result, prototyping a candidate library) — it does NOT run it; it
  returns a `probeRequest {what, why}` in its evidence-json and sets
  `lean: "insufficient"`. This command then dispatches a `research-experimenter`
  (the EXECUTION-capable sibling) into a **throwaway worktree** to run exactly that
  probe and return the SAME evidence-json shape (see step 4).
  **The experimenter is NETWORK-ALLOWED, including in-worktree package installs**
  (`bun add`/`npm`/`pip`) confined to the discardable worktree — the **deliberate
  widening (Q263)** over the investigate-prober's no-network guard, because a
  research probe often must try a candidate dependency or a not-yet-adopted approach
  to produce decisive evidence. It makes **NO persisted edits to the main checkout**
  (all writes confined to the discardable worktree), writes NOTHING to the ledger,
  and does NOT adjudicate — this command validates its citations and sets the
  hypothesis status, exactly as for an explorer. **Agent worktree isolation**
  (consistent with implement/advance.md): Claude → dispatch via `Agent` with
  `isolation: "worktree"` (native throwaway worktree, auto-removed); Codex → the
  orchestrator does `git worktree add ../wt-exp-<H> <branch>` before dispatch and
  `git worktree remove` after harvest. The worktree is ALWAYS removed after the
  evidence is harvested — harvest-then-discard.
- **Explorer & experimenter always run at the FRONTIER tier resolved from CONFIG,
  never a hardcoded model.** ONCE per round, call the `mcp__ledger__get_config`
  MCP tool (an MCP-tool call, NOT a `Bash` shellout — same server as
  `get_reviewers`) and read `tiers.frontier` — a resolved token `{ harness,
  model, provider, effort }` from the ACTIVE harness's `[harness.<h>.tiers]`
  map in `cq.toml` (most-capable == frontier, Q253). Dispatch every
  `research-explorer`/`research-experimenter` `Agent` with `model:
  <token.model VERBATIM>` — the resolved token's `model` is a BARE alias
  (`opus`/`sonnet`/`haiku`/`fable`), so pass it with NO mangling. The token's
  `effort` is **N/A at `Agent` dispatch** — the Agent tool exposes no per-dispatch
  effort/reasoning param (T510) — record it for provenance/display only, never as
  an Agent argument. **Degrade gracefully** when the `get_config` tool is ABSENT,
  or `tiers: null`, or the `frontier` slot is missing: fall back to your OWN class
  (Claude: `inherit`) — never invent a model literal. Do NOT key this degrade on
  `configured`: get_config's `configured` means only 'a parseable cq.toml is
  present' (D81) — it is INDEPENDENT of whether `tiers` itself is populated, so
  degrading on `configured` would DISCARD the user's valid tiers (anti-D78).
  Decide the tiers-degrade purely on tool-absence / `tiers: null` / missing slot.
- **The research LIFECYCLE lives on the research's STATUS, not on free-text
  markers.** The `researches` ledger status is `open → wip → {concluded |
  inconclusive} → …` (terminal: `concluded`/`abandoned`; `inconclusive` is
  NON-terminal and re-openable to `wip`). **`abandoned` is USER-INITIATED ONLY** —
  the autonomous flow NEVER transitions a research to `abandoned` and NEVER asks
  for that disposition; its only terminal target is `concluded` (a research
  question answered), and the default disposition of every non-terminal research is
  ANSWER-IT. The flow drives the NON-terminal part of that lifecycle by calling
  `update_item("researches", RS, status: …)` — it NEVER encodes the lifecycle as
  free-text tokens inside `findings`/`conclusion`/`recommendation`. Those fields are
  purely the substantive research NARRATIVE (with citations); no status tokens.
  **Transition legality (the Q67 transition lesson):** the map has **no `open →
  concluded` edge** and **no `open → inconclusive` edge** — both `concluded` and
  `inconclusive` are reachable ONLY from `wip` — so the flow MUST move an `open`
  research to `wip` the moment real research begins (step 1), then to
  `concluded`/`inconclusive` at conclusion (step 5). A direct `open → concluded`
  write throws `InvalidTransitionError`.
- **Conclusion is IN-LEDGER — never a working-tree write (Q269).** On a confirmed
  answer you write the research's `findings`/`conclusion`/`recommendation` fields
  and route the FULL cited synthesis through `cq log put` as a markdown log artifact
  recorded in `sessionLogs` (see step 5). This command writes NO file into the
  working tree — not the synthesis, not scratch notes, not a report. All durable
  research output lives in the ledger item and in `cq log put`-managed logs.

## Provenance (every ledger write)
On every `create_item` / `update_item`, pass `author` = your OWN model class
(derived from runtime identity, never hardcoded — Claude Opus 4.8 (1M) →
`"opus-4.8[1m]"`; Codex GPT-5.x → e.g. `"gpt-5.5"`) and `session` =
`$CLAUDE_CODE_SESSION_ID` (or the Codex equivalent; omit if unavailable).

## Session logs (after EVERY subagent returns)
Each `research-explorer` **and** each `research-experimenter` ends its reply with a
`### Session summary` block. **ALL log writes go through `cq log put` — never a
direct `Write` to the logs area, and never `git add` a log file** (`cq log put`
does redaction + strict-JSONL validation IN the CLI, then writes into the primary
store's logs area per the configured backend). Stamp `<timestamp>` (`Bash`: `date
-u +%Y%m%d-%H%M%S`) once per returned subagent. **One log pair per dispatched
subagent**, so a hypothesis whose explorer raised a `probeRequest` produces TWO log
pairs this round (the explorer's, then the experimenter's). Subagents write no
file; you do.

**Native `Agent` subagent (explorer / experimenter).** Take `<agent-id>` from the
tool result, then:
1. **Locate its native transcript** at
   `~/.claude/projects/<slug>/<session>/subagents/agent-<agent-id>.jsonl` — the
   `<slug>` is derived from the ledger root path (Claude's project-dir slug; the
   absolute ledger-root path with `/` → `-`), and `<session>` =
   `$CLAUDE_CODE_SESSION_ID`.
2. **Pipe the transcript through `cq log put`** for redaction + strict-JSONL
   validation in the CLI:
   `cat <transcript> | cq log put --stdin --dest logs/raw/<timestamp>-<agent-id>.jsonl`.
3. **Write the summary** (a short header — research id, hypothesis id, `role:
   explorer` or `role: experimenter`, returned `lean` — plus the verbatim `###
   Session summary` block) via `cq log put` to `logs/<timestamp>-<agent-id>.md`
   (compose the header+summary to an OS-temp path — never the working tree — or
   pipe via `--stdin --dest logs/<timestamp>-<agent-id>.md`).
4. **Record BOTH paths on the hypothesis item**: `sessionLogs +=` the
   `.cq/logs/<timestamp>-<agent-id>.md` summary path; `rawLogs +=` the
   `.cq/logs/raw/<timestamp>-<agent-id>.jsonl` raw path (step 4 attaches them in
   the SAME `update_item` that stores the validated evidence — see below).

**Absent transcript (older run / crash / non-Claude harness).** When the
`agent-<agent-id>.jsonl` file does not exist, do NOT fabricate a raw log: write an
explicit `raw transcript unavailable: <reason>` line in the summary-log HEADER (via
`cq log put` to `logs/<timestamp>-<agent-id>.md`) and proceed summary-only — add
ONLY the `.md` to `sessionLogs`, leave `rawLogs` un-extended for that subagent.

**`pi:*` shellout (if any).** Should a round delegate to a `pi:*` shellout (no
native `Agent` id and no `.jsonl` transcript), the verbatim shellout **stdout IS
the raw log**. Route it through `cq log put` to a PLAIN/markdown dest (NOT
`.jsonl`): `… | cq log put --stdin --dest logs/raw/<timestamp>-pi-<alias>.md` — the
verbatim stdout (including the raw, pre-fence-strip text). Capture this even when
its stdout was unparseable (so a failed external call leaves a trace). Also write a
summary `.md` (header: research id, hypothesis id, the alias + `pi`
provider/model) via `cq log put` to `logs/<timestamp>-pi-<alias>.md`. Add the
summary `.md` to the hypothesis item's `sessionLogs` and the raw
`.cq/logs/raw/<timestamp>-pi-<alias>.md` to its `rawLogs`.

---

## Auto-fetch the ledger ref at run START (git-object backend only — T355/Q194)

**When the ledger `[ledger]` backend is `git-object`** (NOT the default `fs`
backend), auto-fetch the orphan ledger branch from the configured remote ONCE at
the very start of the round, BEFORE step 1 below — so the round reads the latest
shared ledger state. When the backend is `fs` (the default, or no `cq.toml`), SKIP
this step entirely. **Suppress this fetch when chained** under a wrapping flow
command (`/cq:advance` or `/cq:research`) — the wrapper owns the single run-START
fetch (mirroring the at-stop handoff/commit suppression); run it only on a
STANDALONE `/cq:research:advance` invocation.

The remote name comes from `[ledger] remote` (default `origin`); the ledger branch
is `cq-ledger` (`[ledger] branch`, default `cq-ledger`). Run from the ledger root
(the MCP `--cwd`):
```
git fetch <remote> refs/heads/cq-ledger:refs/heads/cq-ledger
```
**Single-branch / shallow clones must fetch this ref EXPLICITLY** — it is an orphan
branch outside the normal fetch refspec (see the runbook,
`docs/drafts/20260610-1300-orphan-ledger-runbook.md`). A non-fast-forward fetch
failure means the local ref diverged from the remote — STOP and follow the
runbook's divergence recovery rather than forcing the ref.

## The research round (the six steps)

### 1. READ state (purely from the ledger)
`fetch_item("researches", RS)` — read its `question`/`scope` and any existing
`findings`/`conclusion`/`recommendation`. Then derive the current tree:
- `search_items` / `fts_search` the `hypothesis` ledger for nodes whose
  `ledgerRefs` contain `researches:<RS>`; reconstruct ancestry from
  `parentHypothesis`. Note each node's `status` and `evidence[]`.
- read the linked `questions` (items whose `ledgerRefs` contain `researches:<RS>`):
  if an `open` question is still unanswered, the loop is parked on the user — skip
  to **Report** (resumable: the user answers in the TUI/web, then re-runs
  `/cq:research:advance RS`). If a previously-open question is now `answered`
  (non-empty `answer`), fold its answer into this round's framing and continue.

**Move the research to `wip` the moment real research begins.** If the research's
status is still `open` and you are about to do real research this round (form
hypotheses / dispatch explorers — i.e. NOT parked on an unanswered question),
`update_item("researches", RS, status: "wip")` BEFORE step 2. This is mandatory:
the transition map has **no `open → concluded` edge** and **no `open →
inconclusive` edge** — both are reachable ONLY from `wip` — so a later
adjudication write of `concluded`/`inconclusive` on a still-`open` research would
throw `InvalidTransitionError`. Moving to `wip` here makes the documented path
`open → wip → {concluded | inconclusive}` legal at every edge. The transition is
idempotent in effect: if the research is already `wip` (a prior round set it),
leave it. Do NOT touch status when the round is parked on a question (no research
happens).

If a node is already `confirmed` and it answers the research question, go straight
to step 5 (the conclusion may be incomplete from a prior interrupted round — it is
idempotent to redo).

### 2. FORM hypotheses (extend the tree)
Enumerate the DISTINCT candidate answers to the research question consistent with
current state:
- **Seed roots** — for each distinct top-level candidate answer with no existing
  node, `create_item("hypothesis", <researchMilestone>, status: "open", fields: {
  headline: "<candidate answer>", description: "<what would make this the correct
  answer>", ledgerRefs: ["researches:<RS>"] })`. Roots have no `parentHypothesis`.
  (`<researchMilestone>` is the milestone group the research item RS belongs to.)
- **Drill children** — when an `uncertain` node needs decomposition, create child
  nodes with `parentHypothesis: <parentId>` (and the same `ledgerRefs:
  ["researches:<RS>"]`), each a narrower sub-claim of the parent.
Pick the frontier to advance this round depth-first: prefer drilling the most
promising `uncertain` branch to a leaf before seeding more roots, but seed several
disjoint roots together when the tree is empty (step 3 dispatches them in
parallel).

### 3. DISPATCH read-only explorers
For each frontier hypothesis H to advance this round, dispatch a `research-explorer`
via `Agent` (`subagent_type: "research-explorer"`, `model` = the FRONTIER token's
bare-alias `model` (resolved from `get_config`), verbatim — the token's `effort` is
N/A at `Agent` dispatch per T510, provenance/display only; NO worktree, it changes
nothing). The prompt MUST carry: H's id + statement (verbatim), the branch context
(the research question, parent hypothesis, sibling findings already validated, what
to confirm or rule out), and any specific leads (files/symbols/search terms/URLs).

**Parallelism rule (Q27):** issue the `Agent` calls for DISJOINT top-level
hypotheses being SEEDED in ONE message so they run concurrently. While DRILLING a
single branch, dispatch its children SERIALLY — wait for each explorer's validated
findings before framing the next child. Write each explorer's session log on return
(§Session logs).

**Catalog-driven dispatch (research-explorer).** Drive each `research-explorer`
dispatch through the typed prompt-catalog MCP tools (`fetch_prompt` /
`validate_input` / `validate_output`), MIRRORING the a–g sequence
`commands/cq/plan/advance.md` sub-step 1a established for `plan-advance`: **(a)**
`fetch_prompt("research-explorer")` for its `promptTemplate` + typed
`inputSchema`/`outputSchema` (present — a dispatched subagent); **(b–c)** compose
the input against that `inputSchema` (`{ hypothesisId, statement, branchContext,
leads? }`); **(d)** `validate_input("research-explorer", input)`, fix and
re-validate on `{ ok: false, errors }`; **(e)** dispatch the `Agent`
(`subagent_type: "research-explorer"`, `model` = the FRONTIER token's `model`,
verbatim — its `effort` is N/A at `Agent` dispatch per T510, provenance/display
only, NO worktree); **(f–g)** await its evidence-json and
`validate_output("research-explorer", output)` against the role's `outputSchema` —
the shared `investigate-evidence` shape (`{ hypothesisId, evidence[], lean, notes?,
probeRequest? }`); a validation failure is a contract breach to surface (§Session
logs). **Degrade gracefully when the catalog tools are absent** — skip (a)–(d) and
(g) and fall straight through to the bare `Agent` dispatch (e). The validate steps
are an ADDITIVE contract check, never a hard dependency.

**An explorer may return a `probeRequest` instead of (or alongside) settling H**
when it cannot adjudicate by reading alone (repo + web) — it needs something RUN.
Do not run the probe inline; handle it in step 4 by dispatching a
`research-experimenter` into a throwaway worktree (the experimenter runs
read+execute WITH network access and returns the same evidence-json), then harvest
its evidence through the same citation-revalidation path.

### 4. VALIDATE citations + adjudicate (orchestrator-side)
The explorer's evidence is UNTRUSTED until you check it. A mis-cited `file:line` or
a stale/misquoted web source is the dominant way the loop confirms the WRONG answer,
so re-open every citation yourself:
- **If the explorer returned a `probeRequest` `{what, why}`** (it could not settle H
  by reading repo + web alone — it needs an experiment / benchmark / `bun test` / a
  build / a candidate-library spike RUN) **and you judge running it warranted for
  adjudicating H**, dispatch a `research-experimenter` via `Agent` (`subagent_type:
  "research-experimenter"`, `isolation: "worktree"`, `model` = the FRONTIER token's
  bare-alias `model` (resolved from `get_config`), verbatim — the token's `effort`
  is N/A at `Agent` dispatch per T510, provenance/display only). Under Claude the
  `isolation: "worktree"` gives a native throwaway worktree; under Codex the
  orchestrator `git worktree add ../wt-exp-<H> <branch>` before dispatch and `git
  worktree remove` after harvest. The prompt MUST carry: the `probeRequest {what,
  why}` verbatim, H's id + statement (verbatim), and the branch context (the
  research question, the base commit / branch the worktree was cut from, parent
  hypothesis, sibling findings already validated, what to confirm or rule out).
  The experimenter runs **read+execute** in that worktree and RETURNS the SAME
  evidence-json shape an explorer returns, WITHOUT a `probeRequest` (it executes; it
  does not escalate further).
  **Catalog-driven dispatch (research-experimenter).** Drive this dispatch through
  the typed prompt-catalog MCP tools, MIRRORING the a–g sequence
  `commands/cq/plan/advance.md` sub-step 1a: **(a)**
  `fetch_prompt("research-experimenter")` for its `promptTemplate` + typed
  `inputSchema`/`outputSchema`; **(b–c)** compose the input against that
  `inputSchema` (`{ hypothesisId, statement, probeRequest: { what, why },
  branchContext, leads? }`); **(d)** `validate_input("research-experimenter",
  input)`, fix and re-validate on `{ ok: false, errors }`; **(e)** dispatch the
  `Agent` (`subagent_type: "research-experimenter"`, `isolation: "worktree"`,
  `model` = the FRONTIER token's `model`, verbatim — its `effort` is N/A at `Agent`
  dispatch per T510, provenance/display only); **(f–g)** await its evidence-json and
  `validate_output("research-experimenter", output)` against the role's
  `outputSchema` — the shared `investigate-evidence` shape (`{ hypothesisId,
  evidence[], lean, notes? }`, no `probeRequest`); a validation failure is a
  contract breach to surface (§Session logs). **Degrade gracefully when the catalog
  tools are absent** — skip (a)–(d) and (g) and fall straight through to the bare
  `Agent` dispatch (e).
  **Scope note (Q263):** the experimenter is **NETWORK-ALLOWED, including
  in-worktree package installs** (`bun add`/`npm`/`pip`) — the deliberate widening
  over the investigate-prober's no-network guard — but every install and every write
  is confined to the discardable worktree and it makes **NO persisted edits to the
  main checkout**. Write the experimenter's session log on return (§Session logs).
  **Harvest-then-discard:** harvest the experimenter's returned evidence through the
  EXISTING citation-revalidation path below — re-open each cited `file:line` (Read),
  re-fetch each URL (WebFetch), or re-run the cited command/benchmark and compare its
  output — exactly as for an explorer; then the throwaway worktree is **always
  removed** after harvest (Claude: auto on Agent return; Codex: `git worktree remove
  ../wt-exp-<H>`). Treat the experimenter's evidence items identically to an
  explorer's in the bullets below. If you judge the probe NOT warranted (e.g. it is
  out of scope, or H is already adjudicable), skip the dispatch and proceed with the
  explorer's evidence.
- For each returned evidence item, **re-open the cited `file:line` (Read) — or
  re-fetch the URL (WebFetch), or re-run the cited command** and compare the source
  against the explorer's `excerpt`. A mis-cited source is how research confirms the
  WRONG answer, so this validation is mandatory, not optional. If the excerpt matches
  the source AND genuinely bears on H, store it into `hypothesis.evidence[]` prefixed
  **`[correct]`**; otherwise store it prefixed **`[incorrect]`** (wrong line,
  paraphrase that misrepresents source, stale/low-authority web claim, or
  irrelevant). `update_item("hypothesis", H, fields: { evidence: [...], sessionLogs:
  [".cq/logs/<ts>-<explorer-agent-id>.md", ...], rawLogs:
  [".cq/logs/raw/<ts>-<explorer-agent-id>.jsonl", ...] })` — include the explorer's
  (and, when a `probeRequest` was run this round, the experimenter's) summary-log
  path(s) in `sessionLogs` AND raw-transcript path(s) in `rawLogs` in the SAME
  `update_item` that stores the evidence (the log pair(s) for this subagent were
  written in §Session logs above; use those paths here). Do NOT defer
  `sessionLogs`/`rawLogs` to a separate update. (Omit a `rawLogs` entry for any
  subagent whose transcript was absent — that subagent is summary-only per §Session
  logs.)
- **Adjudicate H's `status` from the `[correct]` items ONLY** (ignore `[incorrect]`
  evidence entirely): set `confirmed` when `[correct]` evidence establishes H as the
  correct answer; `wrong` when `[correct]` evidence rules it out; `uncertain` when
  partial (then drill children next round, step 2). Leave `open` only if no usable
  evidence came back. `update_item("hypothesis", H, status: <verdict>)` — if you
  adjudicate in the same call, combine with the evidence update above:
  `update_item("hypothesis", H, status: <verdict>, fields: { evidence: [...],
  sessionLogs: [...], rawLogs: [...] })`. (This is the HYPOTHESIS-tree vocabulary
  `open|uncertain|confirmed|wrong` — distinct from the research STATUS below.)
- **Reflect the verdict onto the RESEARCH's STATUS** (the lifecycle carrier — never
  free-text markers). The research is already `wip` (set in step 1):
  - a node (or a set of nodes) reached `confirmed` such that the research question
    is ANSWERED → proceed to step 5, which sets `update_item("researches", RS,
    status: "concluded")` (legal from `wip`) as part of writing the conclusion;
  - this round investigated the tree but **answered nothing** and no further branch
    is adjudicable from available evidence (every leaf `wrong`, or the tree is
    exhausted/blocked) → `update_item("researches", RS, status: "inconclusive")`
    (legal from `wip`; re-openable to `wip` on a later round that finds a new lead).
    Then file the NEEDS-user-input question (step 6) if the user could unblock it;
  - more drilling is still warranted this/next round (`uncertain` leaves remain) →
    leave the research at `wip`; do not write a terminal/hold verdict yet.

### 5. CONFIRMED answer → CONCLUDE (in-ledger; NO working-tree write — Q269)
The **seed gate** for concluding is the research STATUS: perform this conclusion
**iff the research is about to be `status == concluded`** — the `confirmed`
hypothesis (or hypotheses) answer the research question. Do this and STOP:

(a) **Write the research's substantive fields.** `update_item("researches", RS,
status: "concluded", fields: { findings: "<the validated evidence narrative — free
text, with the [correct] citations that establish it>", conclusion: "<the answer to
the research question the confirmed hypotheses establish>", recommendation: "<the
concrete recommendation the evidence points to, if any>", sessionLogs:
[".cq/logs/<ts>-<agent-id>.md", ...], rawLogs: [".cq/logs/raw/<ts>-<agent-id>.jsonl",
...] })` — include ALL summary-log paths (`sessionLogs`) AND all raw-transcript paths
(`rawLogs`) written for this research round (all explorer + experimenter log pairs)
in the SAME `update_item` call that sets `concluded`. Do NOT defer
`sessionLogs`/`rawLogs` to a separate update. (Omit a `rawLogs` entry for any
subagent whose transcript was absent.) The `concluded` status (legal only from
`wip`, set in step 1) is the lifecycle marker; the `findings`/`conclusion`/
`recommendation` fields stay pure narrative.

(b) **Route the FULL cited synthesis through `cq log put` — NO working-tree write
(Q269).** Compose the complete synthesis of the round — the research question, the
adjudicated hypothesis tree, and every `[correct]` citation with its verbatim
excerpt — as a MARKDOWN artifact and write it ONLY via `cq log put`, never with a
`Write` to the working tree (compose to an OS-temp path, never inside the repo, then
pipe): `… | cq log put --stdin --dest logs/<ts>-research-<RS>.md`. Then RECORD the
resulting `.cq/logs/<ts>-research-<RS>.md` path in the research item's `sessionLogs`
(append it in the same `update_item` as (a), or a follow-up `update_item` if the
artifact is composed after). This synthesis artifact is the durable, human-readable
record of the answer;
it lives in the `cq log put`-managed logs area, NOT in the working tree.

### 6. NEEDS user input → file an open question and STOP (resumable)
File a step-6 question ONLY when the research literally cannot proceed without the
user. The legitimate triggers are NARROW:
- **ambiguous/contradictory requirements or a genuine preference the user must
  set** — the research question's INTENT (what is actually being asked, or which of
  several equally-valid scopings the user wants) is undetermined, so no answer can
  be adjudicated until the user resolves it;
- **a decisive experiment/reproduction that cannot be produced from the repo or the
  reachable web** (needs data/state/hardware the environment doesn't contain);
- **missing external access/credentials** the research needs to proceed.

These are NOT step-6 questions — **CONTINUE** (and, on a confirmed answer, conclude
per step 5) instead of filing one:
- **whether-to-answer / whether the question is worth researching** — the default
  disposition is ALWAYS ANSWER-IT; never park a research on a disposition question;
- **"out of scope" / "too broad"** — narrow to the answerable core and answer that;
- **magnitude / proportion / cost** of the research;
- any request to `abandon` — `abandoned` is a **user-INITIATED terminal status
  only**; the research flow never transitions a research to `abandoned` and never
  asks for it. A research the flow cannot converge on is `inconclusive` (a
  re-openable hold), NOT `abandoned`.

When a legitimate trigger holds: `create_item("questions", <researchMilestone>,
status: "open", fields: { question: "<the blocking requirements/preference/access
question>", context: "<the tree state, what evidence is missing, what you tried>",
ledgerRefs: ["researches:<RS>"] })` and STOP. Leave the `hypothesis` tree INTACT
(durable). The user answers in the TUI/web, then re-runs `/cq:research:advance RS` —
step 1 folds the answer back in and the loop resumes exactly where it left off.

---

## Report to the user
Summarize the round concisely:
- hypotheses **seeded/drilled** this round (id + statement + new `status`);
- any **experiments dispatched** this round (which H, what was run in the throwaway
  worktree — including any in-worktree package install — harvested-then-discarded);
- citations **validated** (`[correct]` vs `[incorrect]` counts per node);
- the research's **STATUS** after this round (`wip` while drilling; `concluded` when
  the question is answered; `inconclusive` when researched but unresolved) and the
  documented path it followed (`open → wip → {concluded | inconclusive}`);
- on a **concluded** research → the `conclusion`/`recommendation`, and the synthesis
  artifact path written via `cq log put` (`.cq/logs/<ts>-research-<RS>.md`);
- whether the loop is **parked on a question** (id to answer) — if so, "answer it in
  the TUI/web, then run `/cq:research:advance RS` to resume";
- if the tree still has `uncertain`/`open` leaves and no question is pending, say
  another round is warranted: "run `/cq:research:advance RS` again".

---

## Handoff record (STANDALONE only — suppressed when chained)

> **Your stop is PROGRESS-bounded, never EFFORT-bounded.** Stop ONLY when this
> flow's own stop predicate fires — a hypothesis is `confirmed` and the research is
> `concluded` (fields written + synthesis logged), the tree is exhausted with no
> adjudicable lead left (`inconclusive`), the research is parked on an `open` user
> question, or every autonomous research step is done and the sole remaining step is
> a specific named user action — NEVER because the run is long, costly, used many
> explorers, reached "a natural milestone", or the remaining work feels
> disproportionate. The handoff status you write is the gate: one of `drained` /
> `answers-required` / `user-action-required` / `mixed` / `illness-detected`, each
> requiring a real predicate condition — there is no status for an effort-based
> stop. If tempted to stop while an `uncertain`/`open` leaf is still adjudicable,
> CONTINUE. (See llm/commands/cq/advance.md §Stop condition.)

Whether you write a `handoffs` record at your stop depends ENTIRELY on your
invocation context — there is **no env var or process signal** to read. You, the
executing agent, run both this command and (when chained) the wrapping flow command
in the SAME inline session, so you already KNOW which context you are in.

- **Run STANDALONE** (the user invoked `/cq:research:advance` directly, with no
  wrapping flow command): after the §Report, write ONE `handoffs` record for this
  stop — `create_item("handoffs", <researchMilestone>, <status>, <fields>)` —
  mapping your stop classification to the handoff `status`:

  | This round's stop                                                               | handoff `status`        |
  | ------------------------------------------------------------------------------- | ----------------------- |
  | nothing left to drill / fully adjudicated (concluded, or all leaves resolved)   | `drained`               |
  | parked on an `open` question (step 6 — NEEDS user input)                        | `answers-required`      |
  | all autonomous steps done; sole remaining step is a specific named user action  | `user-action-required`  |
  | both at once — some research(es) concluded/drained, other(s) parked             | `mixed`                 |
  | a defect or invariant violation you could not get past                          | `illness-detected`      |

  **`user-action-required` — narrowly pinned (Q138/Q139).** Legal ONLY when a
  SPECIFIC, NAMED item cannot progress because its next physical step is
  *exclusively the user's* — re-activate an environment, provision a
  credential/secret, or run a privileged/external command the agent cannot run —
  AND the agent has already done every autonomous research step for that item. You
  MUST name the EXACT command/action the user runs AND the EXACT item it unblocks;
  if you cannot name both, it is NOT `user-action-required` — **CONTINUE**.

  **Distinct from `answers-required`:** `answers-required` is gated on an `open`
  `questions` item (a user REQUIREMENTS/preference answer); `user-action-required`
  involves **no** `questions` item — it is a manual/environment action, not a
  requirements answer.

  **Co-occurrence → `mixed`:** when both a user action AND an open question block
  progress (or when work landed AND a user action is pending), classify `mixed` and
  list both components in `handoffReasons` (e.g. `[drained, answers-required,
  user-action-required]`).

  Field set (per `HANDOFFS_SCHEMA` — reused UNCHANGED, so the D39 write-time
  invariants below apply identically): `summary` (**required** — the why-it-stopped
  prose, mirror the §Report); `flow` = `research`; `ledgerRefs` = the stop-causing
  items (`researches:<RS>`); `blockingQuestions` = the `open` question ids for an
  `answers-required`/`mixed` stop; `handoffReasons` = the component reasons for a
  `mixed`/`user-action-required` stop; `sessionLogs` = the
  `.cq/logs/<ts>-<agent-id>.md` summary path(s) (including the
  `.cq/logs/<ts>-research-<RS>.md` synthesis on a concluded stop) AND `rawLogs` =
  the `.cq/logs/raw/<ts>-<agent-id>.jsonl` (and `.cq/logs/raw/<ts>-pi-<alias>.md`)
  raw path(s) written this round — populate them in
  the SAME `create_item` call (omit a `rawLogs` entry for any subagent whose
  transcript was absent). Stamp `author`/`session`. Append-only: written once at the
  stop, never updated. **Then commit the ledger** (§Commit the ledger): stage the
  ledger artifacts only and commit, so a standalone research round never leaves the
  ledger uncommitted.

  **TURN-vs-RUN clause (D39).** A RUN and a TURN are distinct scopes. A **RUN**
  spans as many turns as needed and is durably resumable from ledger state on the
  next `/cq:research:advance` invocation — the ledger IS the durable resume point. A
  **TURN** is a single context window; exhausting the turn/context budget is **NOT a
  run-stop**. When a turn/context budget is exhausted mid-stride, the agent **STOPS
  WITHOUT writing a handoff** — no `handoffs` record, no `mixed`/effort terminal
  artifact — because the ledger already captures every durable state change. The
  next `/cq:research:advance` reads ledger state and continues from where the
  previous turn left off. Contrast: a **RUN-stop** = one of the five
  predicate-gated handoff statuses; a **TURN-pause** = no artifact, just resume next
  invocation. Fabricating a terminal handoff record to "wrap up" a turn that ran out
  of budget is the same forbidden launder as an effort-based stop — there is
  deliberately **NO handoff status for an effort-based stop**, and turn exhaustion
  is an effort-based fact, not a predicate-gated one.

  **A TURN-pause is NOT a free escape hatch (D41 — hard gate).** The TURN-pause
  exists ONLY for GENUINE, EXTERNALLY-EVIDENCED context/turn exhaustion (an explicit
  harness context-window / compaction warning, or a tool result truncated/refused
  for length) — NEVER a SUBJECTIVE judgment that you have "done enough" or that the
  work ahead is big. While this command's stop predicate has not fired the default
  is **CONTINUE**; you do not get to pause "to be safe", "for quality", or "to do it
  justice". FORBIDDEN TURN-pause rationales (each the SAME laundered effort/magnitude
  stop the euphemism blocklist bans, merely via the no-handoff channel — citing ANY
  makes the pause ILLEGAL, CONTINUE): "the next/remaining work is large / multi-node
  / high-blast-radius"; "needs / warrants fresh context / full headroom / a clean
  slate"; "I've done substantial work this turn / long session / many subagents"; "a
  clean boundary / natural checkpoint"; "running it now risks a half-finished state"
  (the flow is per-node durable — partial progress is the DESIGN). Magnitude,
  accumulated effort, and a desire for fresh context are EFFORT-BASED FACTS, not
  context-exhaustion signals.

  **Euphemism blocklist + self-check invariant (D39 + D41).** Before EITHER writing
  a handoff record OR taking a TURN-pause (stopping with no handoff), scan your own
  about-to-be-emitted stop rationale — the handoff `summary` OR the turn-pause
  explanation you would give the user — for the phrases "NOT a predicate-legal
  stop", "predicates still TRUE", any equivalent admission the stop is
  non-predicate-gated, OR any FORBIDDEN turn-pause rationale above (magnitude, "fresh
  context/headroom", "done a lot / long session", "clean boundary", "half-finished
  risk"). If any appears — i.e. if your own rationale concedes **predicates still
  TRUE**, or rests on effort / magnitude / freshness rather than an
  externally-evidenced context limit — the stop is ILLEGAL by your own admission:
  **delete the draft, do NOT stop, and CONTINUE** the research round. A summary that
  contains "predicates still TRUE" is self-refuting; the correct action is to
  **delete** the draft entry and **CONTINUE**, never to file it. The following
  phrases, when used to justify a stop, are euphemisms for effort-based stops; each
  is explicitly forbidden as a stop rationale — if any appears in a candidate
  `summary`, treat it as evidence of "predicates still TRUE" and **delete** and
  **CONTINUE**:
  - **"deliberate/transparent checkpoint"** — an effort-stop dressed as intentionality;
  - **"warrants fresh context"** — an effort-stop dressed as a quality concern;
  - **"BREAKING/large/delicate change needs care"** — an effort-stop dressed as caution;
  - **"a complete vertical slice is a clean boundary"** — an effort-stop dressed as scope hygiene.

  **Enforced-invariant (D39 — write-time enforcement).** The `@cq/ledger`
  `create_item` for `handoffs` THROWS if these buckets are empty when their status
  requires them: a `mixed` or `answers-required` handoff MUST carry a non-empty
  `blockingQuestions[]`; a `user-action-required` or `mixed` handoff MUST carry a
  non-empty `handoffReasons[]`. An empty-bucket effort-stop is literally UNWRITABLE
  — the ledger rejects it at write time. The only remediation is to either populate
  the required fields with their genuine predicate-gated content (real blocking
  question ids, real user-action reasons) — which the predicates will ONLY supply if
  the stop is legitimate — or to **not stop and CONTINUE** the research round
  instead.

- **Run CHAINED INLINE by any wrapping flow command** (`/cq:advance` or
  `/cq:research` that runs this pass inline): **SUPPRESS this handoff write** — AND
  suppress the at-stop ledger commit (the outermost wrapper owns both). The
  outermost wrapper owns the single authoritative run-level handoff and writes it
  once at its stop — `/cq:advance` per its §Provenance (it is the sole `handoffs`
  writer for the whole run); `/cq:research` writes it directly in its own §Handoff
  record step. You can tell you are in this context because the wrapping command
  explicitly chains you and its prompt instructs this suppression; a standalone
  invocation has no such wrapper. Suppressing here is what guarantees exactly ONE
  handoff per run — never a duplicate.

## Commit the ledger (standalone stop)
After the standalone handoff write, persist the ledger to git — **when `[ledger]
backend` is `fs` (the default); SKIP under `git-object`, whose orphan ref already
carries each write** — and ONLY the ledger (`.cq/*.md` + `.cq/archive` +
`.cq/logs`; NEVER `docs/ledgers.yaml`, gitignored; NEVER code, and NEVER a
research-content file in the working tree — the synthesis lives in `cq log
put`-managed logs, never a tracked working-tree file):
```
git add .cq/ 2>/dev/null  # ledger dir; .gitignore excludes ledgers.yaml + lockfiles/backups
git diff --cached --quiet -- .cq/ || git commit -q -m "chore(ledger): /cq:research:advance — <stop: <status>>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
The `git diff --cached --quiet` guard makes it a NO-OP when nothing changed.
SUPPRESS this commit when chained (the wrapper owns the single run-stop commit).

## Auto-push the ledger ref at run END (git-object backend only — T355/Q194)

**When the ledger `[ledger]` backend is `git-object`**, auto-push the orphan ledger
branch to the configured remote ONCE at the STANDALONE stop, immediately after the
standalone at-stop ledger commit above. When the backend is `fs` (the default),
SKIP this step. This is a once-per-run push (NOT per-write) — the symmetric partner
of the run-START fetch. **SUPPRESS this push when chained** (`/cq:advance` or
`/cq:research`) exactly as the at-stop commit is suppressed — the outermost wrapper
owns the single run-END push.

The remote name comes from `[ledger] remote` (default `origin`). Run from the
ledger root:
```
git push <remote> cq-ledger
```
This is a **PLAIN, NON-FORCED push** — deliberately **NO `--force`**. If the remote
`cq-ledger` has diverged since this run's START fetch, the push is REJECTED and
**FAILS LOUDLY** (non-fast-forward) rather than silently overwriting. On a rejected
push, DO NOT add `--force` — follow the runbook
(`docs/drafts/20260610-1300-orphan-ledger-runbook.md`): fetch, inspect `git log
cq-ledger`, reconcile, then retry the plain push.
