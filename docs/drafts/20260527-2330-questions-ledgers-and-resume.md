# Clarifications: ledger library + resume-from-history rework

**Context:** Two parallel tasks were dispatched: (1) build a markdown-backed
ledger library with Claude-facing tools, to be run under `/vsm-loop`;
(2) rework the resume-from-history UX (Haiku-generated session titles,
resume buttons on the History tab, drop the dialog, suppress zero
token/cost cells for subagents). Both have non-trivial design decisions
that should be settled before code is written.

**How to answer:** Write your response on the `Answer:` line under each
question. Leave blank to skip. You can answer in any order; reference
questions by their ID (e.g. `Q3`) in chat.

---

# Part A — Ledger library

## Q1: Where should the ledger library live in the workspace?

**Context:** The repo has `packages/{shared,server,web,e2e}`. The ledger
code is mostly server-side (filesystem I/O, in-memory state, locks), but
its types (Ledger, Item, Milestone) would also be referenced by web if
ledgers ever surface in the UI.

**Suggestions:**

- **New package `packages/ledger`** (recommended) — clean boundary; types
  re-exported through `@cq/shared` if web needs them later; tests live
  with the implementation. Tradeoff: one more `tsconfig` to maintain.
- **Inside `packages/server/src/ledger/`** — fewer moving parts, but
  couples the library to the server lifecycle and makes reuse awkward.
- **Inside `packages/shared`** — keeps types accessible to web; but
  shared currently has no Node/Bun fs deps and that would change.

Answer: new package

---

## Q2: Who consumes the ledger tools — the embedded agent, the human user via WS, or both?

**Context:** The request says "expose ledger operations as tools to our
Claude sessions." cq is itself a chat over the Claude Agent SDK, so
"Claude sessions" could mean (a) the SDK agent the user is talking to in
the Chat tab (tools exposed via SDK-MCP, like the existing
`AskUserQuestion` MCP server in `packages/server/src/agent/askUserQuestion.ts`),
or (b) something exposed to the human via the cq UI directly. The
distinction drives whether we need WS protocol messages, UI affordances,
or only an MCP server.

**Suggestions:**

- **Agent only (MCP server)** (recommended for v1) — mirrors the
  existing `cq` MCP server pattern; the agent can read/write ledgers
  during a session. No UI work needed until later.
- **Agent + UI viewer** — also render ledgers in a new tab. Larger
  scope.
- **Human via WS only** — the user edits ledgers in cq's UI, agent
  has no direct access. Doesn't match "expose to Claude sessions."

Answer: agent only for v1. Question: can we expose this as tools, not MCP?

---

## Q3: What is the root directory for ledger files?

**Context:** Spec says ledgers live in `./docs/${ledger-name}.md`. cq
takes `--cwd` at startup, but the agent might be working in a sibling
directory. The library could anchor on (a) the server's `--cwd`,
(b) a separate `--ledger-root`, or (c) a path passed into every tool
call.

**Suggestions:**

- **Server `--cwd`** (recommended) — matches how the agent sees the
  filesystem; one source of truth.
- **Separate `--ledger-root` flag** with `--cwd` as default — gives the
  user an escape hatch (e.g. host ledgers under `~/.cq/ledgers/...`).
- **Per-call path** — most flexible; risks the agent writing ledgers in
  arbitrary places.

Answer: server cwd

---

## Q4: How are ledger schemas defined — frontmatter in the file, separate config, or code?

**Context:** Each ledger has a schema (status enum values, allowed keys,
their types). Three plausible locations:

**Suggestions:**

- **YAML frontmatter at the top of each ledger `.md`** (recommended) —
  self-contained, human-readable, ledger file is the source of truth;
  parser reads `---` block then markdown body. Tradeoff: schema lives
  next to data, not centrally registered.
- **Central TypeScript registry** (`ledgerSchemas.ts`) — types fully
  inferable at compile time; new ledger kinds require a code change.
- **Separate config file** (`docs/ledgers.yaml`) — central, code-free;
  one more file to keep in sync.

Answer: I think separate config file. Ledger schema itself is defined at creation and is represented in Ledger object

---

## Q5: Markdown parser — which library?

**Suggestions:**

- **`unified` + `remark-parse` + `remark-frontmatter` + `remark-stringify`**
  (recommended) — produces a typed mdast AST that round-trips cleanly,
  large ecosystem, handles frontmatter. Tradeoff: ~10 deps; mildly heavy.
- **`marked`** — lightweight, fast, but the AST is less structured and
  re-emitting is awkward.
- **Hand-rolled parser over a known restricted grammar** — zero deps,
  but reinvents formatter/escaping rules; brittle if a human edits a
  ledger by hand.

Answer: this is up to you, choose the best option

---

## Q6: Locking strategy — process-level mutex, OS file lock, or both?

**Context:** cq is a single-process server (one Bun process). The agent
could call tools concurrently, but no other process should be touching
the ledger files. The request explicitly demands "proper lockfiles" and
"no race conditions."

**Suggestions:**

- **In-process async mutex per ledger + advisory `.lock` file**
  (recommended) — mutex prevents intra-process races; lockfile catches
  external editors (e.g. user opens the file in vim and the agent tries
  to write). On startup, stale lockfiles (PID dead) are reclaimed.
- **In-process mutex only** — simplest; trusts that nothing else writes.
- **OS file lock (`flock`) only** — robust across processes but Bun's
  `flock` story is uneven; harder to test.

Answer: as recommended

---

## Q7: Concurrency model — write-through, write-behind, or snapshot?

**Suggestions:**

- **Write-through under the lock** (recommended) — every mutation
  acquires the lock, updates the in-memory state, serializes to disk,
  releases. Simple, no data loss on crash; modest fsync cost.
- **Write-behind with debounce** — batches rapid edits; risks losing the
  tail on crash. Overkill for the expected write rate.
- **Snapshot + journal** — most robust but disproportionate to the
  problem size.

Answer: as recommended for now

---

## Q8: Should milestone/item IDs be auto-generated or caller-supplied?

**Suggestions:**

- **Auto-generated, ULID-style** (recommended) — monotonically sortable,
  collision-free, no thinking required from the agent. Caller-supplied
  IDs are accepted only for `import`/`restore`.
- **Caller-supplied, human-readable slugs** (e.g. `D27`, `M3`) — match
  existing `tasks.md`/`defects.md` style. Tradeoff: collisions, agent
  has to think of names.
- **Hybrid: auto by default, optional override** — most flexible, but
  more API surface.

Answer: I think hybrid - and we keep milestone/item counters right in the ledger file

---

## Q9: How should "active items only" be defined per ledger kind?

**Context:** The `fetch_ledger` tool should return only active items.
"Active" depends on status enum values, which are per-ledger.

**Suggestions:**

- **Schema declares `terminalStatuses`** (recommended) — e.g. defects
  schema lists `["resolved", "abandoned"]` as terminal; everything else
  is active. Explicit and per-ledger.
- **Hardcoded convention** — e.g. status named `"resolved"` or
  `"completed"` is always terminal. Brittle.
- **Caller passes a status filter** — pushes responsibility onto the
  agent.

Answer: as recommended

---

## Q10: Archive trigger — explicit tool call only, or implicit on milestone close?

**Suggestions:**

- **Explicit `archive_milestone(ledger, milestone_id)` tool**
  (recommended) — agent decides when to archive; matches `review-loop`
  workflow. Library refuses to archive a milestone with non-terminal
  items.
- **Implicit on last item reaching terminal status** — automatic but
  surprising; can fight the agent's intent.
- **Both: implicit by default, explicit override** — more complex API.

Answer: as recommended

---

## Q11: Should we ship MCP tools beyond the listed set?

**Context:** The request lists `ledger_fetch`, `ledger_update`,
`enumerate_ledgers`, `fetch_ledger`, `fetch_ledger_archive`,
`fetch_milestone`, `update_milestone`. Plausible additions:

**Suggestions (multi-select intent — flag each):**

- `create_item(ledger, milestone, fields)` — needed unless `update` doubles as upsert
- `create_milestone(ledger, title, description)` — same reasoning
- `create_ledger(name, schema)` — or are ledgers admin-defined only?
- `archive_milestone(ledger, milestone_id)` — required if archive is explicit (Q10)
- `search_items(ledger, query)` — convenience over `fetch_ledger` + client-side filter
- None — stick to the listed set; `update` upserts, ledgers/milestones admin-only

Answer: as suggested. But my question stands - is MCP the only way to add tools?

---

## Q12: What is the rollout / acceptance bar for v1?

**Context:** vsm-loop work needs a discharge condition.

**Suggestions:**

- **Library + MCP server + parser round-trip tests + dual-tests-style
  filesystem suite, but NOT yet wired into the running agent**
  (recommended for v1) — proves the design without disturbing the live
  agent; second milestone wires it in.
- **Full integration: agent in the Chat tab can call the tools end-to-end
  in a fresh session** — bigger first cycle, but immediately useful.
- **Just the parser and types; no MCP** — too narrow.

Answer: full integration

---

# Part B — Resume-from-history UX rework

## Q13: How should Haiku-generated session titles be produced?

**Context:** Item 1 says "use Haiku to generate session descriptions
once user sends first prompt." Three plausible mechanisms:

**Suggestions:**

- **Direct `@anthropic-ai/sdk` call from the server** (recommended) —
  one extra dep; runs out-of-band of the SDK session; controllable
  prompt + token budget; cached by session id.
- **Spawn a one-shot Claude Agent SDK query** — heavier (subprocess) and
  conflates with the user's session.
- **Reuse the active SDK session to ask the model for a title** —
  pollutes the conversation transcript.

Answer: as recommended

---

## Q14: When exactly should the title be generated?

**Suggestions:**

- **After the first user message is persisted, async, with a fallback to
  the first ~60 chars of the prompt until it lands** (recommended) — UI
  always has something to show; title appears within a few seconds.
- **After the first `result` message (turn complete)** — slightly better
  context (agent has responded) but UI shows "(no title)" longer.
- **On demand when the History tab is opened** — lazy; first-open
  latency unpleasant.

Answer: I guess after first result

---

## Q15: Where is the generated title stored?

**Suggestions:**

- **New `title` column on the `session` row** (recommended), nullable;
  migration adds it; `HistoryRow` Zod schema gains it.
- **Derived at read time from the first user message + cached** — no
  schema change but more code.

Answer: as recommended

---

## Q16: Which model id for the title generator?

**Suggestions:**

- **`claude-haiku-4-5-20251001`** (recommended — matches the env note's
  "latest Haiku"). Cheap, fast.
- **`claude-haiku-4-5`** — alias; pinned date is safer for reproducibility.
- **User-configurable via CLI flag** — overkill for v1.

Answer: alias

---

## Q17: Resume button placement and visibility — only top-level main sessions, never subagents — correct?

**Context:** Request says "Show 'resume' buttons on history tab for
top-level sessions in a separate column (not subagents)." Confirming:

**Suggestions:**

- **Yes: dedicated rightmost "Resume" column, button on every row where
  `agent_name='main' AND parent_invocation_id IS NULL`, hidden (empty
  cell) for subagent rows** (recommended).
- **Button only on rows where the session is not currently active**
  (avoid resuming the live one).
- **Button only on rows where `endedAt IS NOT NULL`** (resume only
  finished sessions).

Answer: as recommended an only for finished/inactive sessions

---

## Q18: When the dialog and its trigger button are removed, where does the resume entry point live?

**Context:** Item 4 says "Remove 'resume from history' button and
dialog — if user needs to resume, they could use history tab." Confirm
full removal from `Header.tsx` and `ResumePicker`.

**Suggestions:**

- **Yes: delete `ResumePicker.tsx`, remove the Header button, drop
  related tests** (recommended).
- **Keep the dialog but hide the Header trigger** (no-op).
- **Keep both, just stop showing them by default** (dead UI).

Answer: yes, delete

---

## Q19: Zero-cost / zero-token cells for subagents — render as empty or as a dash?

**Context:** Item 3: the SDK doesn't emit per-subagent token/cost, so
those rows always show 0. Two display choices:

**Suggestions:**

- **Empty cell** (recommended — request says "we shouldn't show zeros,
  we should show nothing").
- **Em dash `—`** (visually indicates "n/a" rather than "missing data").

Answer: empty cell

---

## Q20: Should the generated title replace `(no prompt)` for **subagents** too, or stay main-only?

**Context:** Item 5: "use generated description in session/excerpt
column — as we do for subagents." Today the excerpt column shows the
subagent's prompt for subagent rows and `(no prompt)` for the main
session before any user input. The fix could be:

**Suggestions:**

- **Main rows: show generated title (or fall back to first prompt
  excerpt); subagent rows unchanged** (recommended — they already have a
  meaningful prompt).
- **Both: generate titles for subagents too** — extra Haiku calls; minor
  benefit; raises cost questions.

Answer: as recommended

---

## Q21: Acceptance / test scope for Part B?

**Suggestions:**

- **Server: unit tests for the title-generator service (mocked Anthropic
  client) + persistence round-trip + Zod schema. Web: List.tsx renders
  the title column + resume column; ResumePicker tests deleted. E2E:
  one Playwright that resumes from the History tab and asserts the
  resumed session is the same `chatSessionId`** (recommended).
- **Skip E2E for this rework, rely on unit + the existing resume e2e
  reused.**
- **Full E2E including Haiku call against the real API.**

Answer: full e2e

---
